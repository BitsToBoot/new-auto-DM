/**
 * Delivery engine integration tests.
 *
 * These drive the PRODUCTION worker (intake + delivery) and the durable
 * scheduler end to end against an in-memory PostgreSQL stand-in
 * (helpers/fake-prisma.ts) and an in-memory queue. Only external systems are
 * faked: Meta, Redis throughput counters and monthly usage counters.
 *
 * A global invariant is checked on every Meta send: the DeliveryJob must
 * already be durably SENDING (FakeMeta.violations must stay empty).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeMeta, FakeQueue, FakeRateLimiter, FakeUsage } from "./helpers/engine-harness";

process.env.NEXTAUTH_SECRET = "test-secret-for-tracked-link-signatures";
process.env.NEXTAUTH_URL = "https://app.campaigncue.test";

const h = vi.hoisted(() => ({}) as {
  meta: import("./helpers/engine-harness").FakeMeta;
  queue: import("./helpers/engine-harness").FakeQueue;
  limiter: import("./helpers/engine-harness").FakeRateLimiter;
  usage: import("./helpers/engine-harness").FakeUsage;
});

vi.mock("@/lib/db/client", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  return { prisma: createFakePrisma() };
});

vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  sendPrivateReply: (...args: [string, string, string, string]) => h.meta.sendPrivateReply(...args),
  getMediaPublishedAt: (token: string, mediaId: string) => h.meta.getMediaPublishedAt(token, mediaId),
  replyToComment: vi.fn(async () => ({ id: "reply" })),
}));

vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: (value: string) => {
    if (value === "corrupt") throw new Error("bad ciphertext");
    return "plain-access-token";
  },
}));

vi.mock("@/lib/queue/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queue/client")>()),
  getDMQueue: () => h.queue,
  getRedisConnection: vi.fn(),
}));

vi.mock("@/lib/utils/rate-limiter", () => ({
  reserveDMSlot: async (accountId: string) => h.limiter.reserve(accountId),
  releaseDMSlot: async (accountId: string) => h.limiter.release(accountId),
}));

vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: async (workspaceId: string) => h.usage.reserve(workspaceId),
  releaseWorkspaceDMReservation: async (workspaceId: string) => h.usage.release(workspaceId),
}));

vi.mock("@/lib/ops/worker-health", () => ({ recordWorkerAlert: vi.fn(async () => {}) }));

import { prisma } from "@/lib/db/client";
import type { FakePrisma } from "./helpers/fake-prisma";
import {
  clearMediaPublishedAtCache,
  deliverDeliveryJob,
  processCommentJob,
  processQueueJob,
} from "@/lib/queue/dm-worker";
import { runSchedulerPass } from "@/lib/delivery/scheduler";
import { MetaApiError, MetaNetworkError, RateLimitError } from "@/lib/meta/client";
import { DELIVERY_CONFIG } from "@/lib/config/delivery";
import type { ProcessCommentJob } from "@/lib/queue/client";

const db = prisma as unknown as FakePrisma;
const T0 = new Date("2026-11-09T12:00:00.000Z");

// ─── fixtures ────────────────────────────────────────────────────────────────

let seq = 0;

function seedAccounts() {
  db.seed("workspace", { id: "ws_1", name: "Agency One", ownerId: "u1" });
  db.seed("workspace", { id: "ws_2", name: "Agency Two", ownerId: "u2" });
  db.seed("instagramAccount", { id: "acc_1", workspaceId: "ws_1", instagramId: "ig_acc_1", username: "brand_one", accessToken: "enc" });
  db.seed("instagramAccount", { id: "acc_2", workspaceId: "ws_2", instagramId: "ig_acc_2", username: "brand_two", accessToken: "enc" });
}

interface CampaignOptions {
  id?: string;
  account?: "acc_1" | "acc_2";
  scope?: "SPECIFIC_POST" | "NEXT_POST" | "ANY_POST";
  postId?: string | null;
  keywords?: string[];
  legacyKeywords?: string[];
  dmMessage?: string;
  variations?: { id?: string; message: string; isActive?: boolean }[];
  trackedLink?: { slug: string; destinationUrl: string } | null;
  createdAt?: Date;
  isActive?: boolean;
}

function seedCampaign(options: CampaignOptions = {}) {
  const id = options.id ?? `auto_${++seq}`;
  const account = options.account ?? "acc_1";
  const workspaceId = account === "acc_1" ? "ws_1" : "ws_2";
  const keywords = options.keywords ?? ["LINK"];
  db.seed("automation", {
    id,
    workspaceId,
    instagramAccountId: account,
    name: `Campaign ${id}`,
    triggerScope: options.scope ?? "ANY_POST",
    postId: options.postId ?? null,
    keywords: options.legacyKeywords ?? keywords,
    dmMessage: options.dmMessage ?? "Hey {username}! Here you go.",
    isActive: options.isActive ?? true,
    createdAt: options.createdAt ?? new Date(T0.getTime() - 60_000),
  });
  for (const keyword of keywords) {
    db.seed("automationKeyword", { automationId: id, keyword, normalizedKeyword: keyword.toLowerCase() });
  }
  for (const variation of options.variations ?? []) {
    db.seed("automationMessageVariation", {
      id: variation.id,
      automationId: id,
      message: variation.message,
      isActive: variation.isActive ?? true,
    });
  }
  if (options.trackedLink) {
    db.seed("trackedLink", { workspaceId, automationId: id, ...options.trackedLink });
  }
  return id;
}

function comment(overrides: Partial<ProcessCommentJob> = {}): ProcessCommentJob {
  const n = ++seq;
  return {
    instagramAccountId: "ig_acc_1",
    commentId: `c_${n}`,
    commentText: "LINK please",
    commenterId: `user_${n}`,
    commenterName: `fan_${n}`,
    mediaId: "media_1",
    commentedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Webhook path: persist InboundComment, then process. */
async function receive(data: ProcessCommentJob) {
  return processCommentJob(data);
}

/** Runs every queued job that is due, like a BullMQ worker would. */
async function drainQueue(maxRounds = 20) {
  for (let round = 0; round < maxRounds; round++) {
    const due = h.queue.dueJobs();
    if (due.length === 0) return;
    for (const [id, job] of due) {
      h.queue.jobs.delete(id);
      await processQueueJob({ name: job.name, data: job.data } as any);
    }
  }
}

function advance(ms: number) {
  vi.setSystemTime(new Date(Date.now() + ms));
}

const jobs = () => db.tables.deliveryJob;
const jobFor = (commentId: string) => jobs().find((j) => j.triggerId === commentId)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  db.reset();
  h.meta = new FakeMeta(db);
  h.queue = new FakeQueue();
  h.limiter = new FakeRateLimiter();
  h.usage = new FakeUsage();
  clearMediaPublishedAtCache();
  seedAccounts();
});

afterEach(() => {
  expect(h.meta.violations).toEqual([]);
  vi.useRealTimers();
});

// ─── BUG 1: message variations ───────────────────────────────────────────────

describe("Bug 1 — message variations reach the worker", () => {
  it("uses the default message when the campaign has no variations", async () => {
    seedCampaign({ dmMessage: "Default copy for {username}" });
    const c = comment({ commenterName: "alice" });
    await receive(c);

    expect(jobFor(c.commentId).selectedVariationId).toBeNull();
    expect(h.meta.sent[0].message).toBe("Default copy for @alice");
  });

  it("selects between the default and a single variation, persisting the choice", async () => {
    seedCampaign({ dmMessage: "Default copy", variations: [{ id: "v_1", message: "Variation one copy" }] });
    const comments = Array.from({ length: 20 }, () => comment());
    for (const c of comments) await receive(c);

    const chosen = new Set(comments.map((c) => jobFor(c.commentId).selectedVariationId));
    expect(chosen).toEqual(new Set([null, "v_1"]));
    for (const c of comments) {
      const job = jobFor(c.commentId);
      const sent = h.meta.sent.find((s) => s.commentId === c.commentId)!;
      expect(sent.message).toBe(job.selectedVariationId === "v_1" ? "Variation one copy" : "Default copy");
      expect(job.messagePayload).toBe(sent.message);
    }
  });

  it("spreads multiple variations across recipients", async () => {
    seedCampaign({
      dmMessage: "D",
      variations: [
        { id: "v_a", message: "A" },
        { id: "v_b", message: "B" },
        { id: "v_c", message: "C" },
      ],
    });
    const comments = Array.from({ length: 40 }, () => comment());
    for (const c of comments) await receive(c);

    expect(new Set(h.meta.sent.map((s) => s.message))).toEqual(new Set(["D", "A", "B", "C"]));
  });

  it("retries send exactly the same selected variation", async () => {
    seedCampaign({ dmMessage: "D", variations: [{ id: "v_a", message: "A {username}" }, { id: "v_b", message: "B {username}" }] });
    const c = comment();
    h.meta.nextErrors.push(new MetaApiError(2, undefined, undefined, "Service temporarily unavailable"));
    await receive(c);
    expect(jobFor(c.commentId).status).toBe("PENDING");

    advance(DELIVERY_CONFIG.backoffMaxMs + 1000);
    await deliverDeliveryJob(jobFor(c.commentId).id);

    expect(jobFor(c.commentId).status).toBe("SENT");
    expect(h.meta.sent).toHaveLength(2);
    expect(h.meta.sent[0].message).toBe(h.meta.sent[1].message);
  });

  it("never selects inactive or empty variations", async () => {
    seedCampaign({
      dmMessage: "D",
      variations: [
        { id: "v_inactive", message: "Inactive copy", isActive: false },
        { id: "v_empty", message: "   " },
        { id: "v_ok", message: "Active copy" },
      ],
    });
    const comments = Array.from({ length: 30 }, () => comment());
    for (const c of comments) await receive(c);

    const ids = new Set(comments.map((c) => jobFor(c.commentId).selectedVariationId));
    expect(ids.has("v_inactive")).toBe(false);
    expect(ids.has("v_empty")).toBe(false);
    expect(ids.has("v_ok")).toBe(true);
  });
});

// ─── BUG 2: NEXT_POST ────────────────────────────────────────────────────────

describe("Bug 2 — NEXT_POST is consumed only by a newer post with a matching keyword", () => {
  const campaignCreatedAt = new Date(T0.getTime() - 60 * 60 * 1000);

  beforeEach(() => {
    seedCampaign({ id: "auto_next", scope: "NEXT_POST", createdAt: campaignCreatedAt });
    h.meta.mediaPublishedAt.set("old_post", new Date(campaignCreatedAt.getTime() - 24 * 60 * 60 * 1000));
    h.meta.mediaPublishedAt.set("new_post", new Date(campaignCreatedAt.getTime() + 10 * 60 * 1000));
    h.meta.mediaPublishedAt.set("new_post_2", new Date(campaignCreatedAt.getTime() + 20 * 60 * 1000));
  });

  const automation = () => db.tables.automation.find((a) => a.id === "auto_next")!;

  it("old post + matching keyword does not consume the campaign", async () => {
    const outcome = await receive(comment({ mediaId: "old_post" }));
    expect(outcome).toBe("NO_MATCHING_CAMPAIGN");
    expect(automation().consumedPostId).toBeNull();
    expect(jobs()).toHaveLength(0);
  });

  it("new post + non-matching keyword does not consume the campaign", async () => {
    await receive(comment({ mediaId: "new_post", commentText: "nice photo" }));
    expect(automation().consumedPostId).toBeNull();
  });

  it("new post + matching keyword consumes it and sends", async () => {
    const c = comment({ mediaId: "new_post" });
    await receive(c);
    expect(automation().consumedPostId).toBe("new_post");
    expect(jobFor(c.commentId).status).toBe("SENT");

    // Other commenters on the same (consuming) post still match.
    const later = comment({ mediaId: "new_post" });
    await receive(later);
    expect(jobFor(later.commentId).status).toBe("SENT");
  });

  it("two concurrent eligible posts: exactly one wins", async () => {
    const a = comment({ mediaId: "new_post" });
    const b = comment({ mediaId: "new_post_2" });
    await Promise.all([receive(a), receive(b)]);

    const winner = automation().consumedPostId;
    expect(["new_post", "new_post_2"]).toContain(winner);
    expect(jobs().filter((j) => j.automationId === "auto_next")).toHaveLength(1);
    expect(jobs()[0].mediaId).toBe(winner);
  });

  it("a replayed webhook does not consume again or create another delivery", async () => {
    const c = comment({ mediaId: "new_post" });
    await receive(c);
    const replay = await receive({ ...c });
    expect(replay).toBe("ALREADY_PROCESSED");
    expect(jobs()).toHaveLength(1);
    expect(h.meta.sent).toHaveLength(1);
  });

  it("a transient failure reading the publish time is retried, not resolved to another campaign", async () => {
    seedCampaign({ id: "auto_any", scope: "ANY_POST" });
    h.meta.mediaPublishedAt.set("flaky_post", new Error("ETIMEDOUT"));
    await expect(receive(comment({ mediaId: "flaky_post" }))).rejects.toThrow("ETIMEDOUT");
    expect(jobs()).toHaveLength(0);
    expect(automation().consumedPostId).toBeNull();
  });
});

// ─── BUG 3: one canonical resolver ───────────────────────────────────────────

describe("Bug 3 — the worker follows the canonical resolver", () => {
  it("SPECIFIC_POST wins over an older ANY_POST", async () => {
    seedCampaign({ id: "auto_any", scope: "ANY_POST", createdAt: new Date(T0.getTime() - 9e6) });
    seedCampaign({ id: "auto_specific", scope: "SPECIFIC_POST", postId: "media_1" });
    const c = comment();
    await receive(c);
    expect(jobFor(c.commentId).automationId).toBe("auto_specific");
    expect(jobs()).toHaveLength(1);
  });

  it("an eligible NEXT_POST wins over ANY_POST", async () => {
    seedCampaign({ id: "auto_any", scope: "ANY_POST", createdAt: new Date(T0.getTime() - 9e6) });
    seedCampaign({ id: "auto_next", scope: "NEXT_POST", createdAt: new Date(T0.getTime() - 60_000) });
    h.meta.mediaPublishedAt.set("media_1", T0);
    const c = comment();
    await receive(c);
    expect(jobFor(c.commentId).automationId).toBe("auto_next");
  });

  it("an ineligible NEXT_POST does not block ANY_POST and stays unconsumed", async () => {
    seedCampaign({ id: "auto_any", scope: "ANY_POST" });
    seedCampaign({ id: "auto_next", scope: "NEXT_POST", createdAt: T0 });
    h.meta.mediaPublishedAt.set("media_1", new Date(T0.getTime() - 86_400_000));
    const c = comment();
    await receive(c);
    expect(jobFor(c.commentId).automationId).toBe("auto_any");
    expect(db.tables.automation.find((a) => a.id === "auto_next")!.consumedPostId).toBeNull();
  });

  it("a SPECIFIC_POST winner leaves NEXT_POST unconsumed", async () => {
    seedCampaign({ id: "auto_next", scope: "NEXT_POST" });
    seedCampaign({ id: "auto_specific", scope: "SPECIFIC_POST", postId: "media_1" });
    h.meta.mediaPublishedAt.set("media_1", T0);
    await receive(comment());
    expect(db.tables.automation.find((a) => a.id === "auto_next")!.consumedPostId).toBeNull();
  });

  it("matches the canonical keywordsList, not the legacy keywords array", async () => {
    seedCampaign({ keywords: ["PRICE"], legacyKeywords: ["LINK"] });
    expect(await receive(comment({ commentText: "LINK" }))).toBe("NO_MATCHING_CAMPAIGN");
    expect(await receive(comment({ commentText: "what is the PRICE" }))).toBe("CREATED");
  });

  it("falls back to the legacy keywords array only when keywordsList is empty", async () => {
    db.seed("automation", {
      id: "auto_legacy",
      workspaceId: "ws_1",
      instagramAccountId: "acc_1",
      name: "Legacy",
      triggerScope: "ANY_POST",
      keywords: ["GUIDE"],
      dmMessage: "Here is the guide",
      createdAt: T0,
    });
    expect(await receive(comment({ commentText: "GUIDE" }))).toBe("CREATED");
  });

  it("resolves equal-priority campaigns deterministically (oldest, then ID)", async () => {
    const sameTime = new Date(T0.getTime() - 1000);
    seedCampaign({ id: "auto_b", scope: "ANY_POST", createdAt: sameTime });
    seedCampaign({ id: "auto_a", scope: "ANY_POST", createdAt: sameTime });
    const c = comment();
    await receive(c);
    expect(jobFor(c.commentId).automationId).toBe("auto_a");
  });

  it("ignores inactive campaigns and campaigns of other accounts", async () => {
    seedCampaign({ id: "auto_paused", isActive: false });
    seedCampaign({ id: "auto_other", account: "acc_2" });
    expect(await receive(comment())).toBe("NO_MATCHING_CAMPAIGN");
  });
});

// ─── BUG 4: creator self-comments ────────────────────────────────────────────

describe("Bug 4 — the creator's own comments are excluded", () => {
  beforeEach(() => {
    seedCampaign();
  });

  it("skips a comment written by the connected account", async () => {
    const outcome = await receive(comment({ commenterId: "ig_acc_1", commenterName: "brand_one" }));
    expect(outcome).toBe("SELF_COMMENT");
    expect(jobs()).toHaveLength(0);
    expect(db.tables.contact).toHaveLength(0);
    expect(db.tables.inboundComment[0]).toMatchObject({ status: "IGNORED", outcome: "SELF_COMMENT" });
  });

  it("processes comments from other users normally", async () => {
    expect(await receive(comment())).toBe("CREATED");
    expect(h.meta.sent).toHaveLength(1);
  });

  it("fails safely when the commenter ID is missing or malformed", async () => {
    expect(await receive(comment({ commenterId: "" }))).toBe("MISSING_COMMENTER_ID");
    expect(await receive(comment({ commenterId: "bad id!" }))).toBe("MISSING_COMMENTER_ID");
    expect(await receive(comment({ commenterId: undefined as unknown as string }))).toBe("MISSING_COMMENTER_ID");
    expect(jobs()).toHaveLength(0);
  });

  it("does not exclude a different user who shares the creator's username", async () => {
    expect(await receive(comment({ commenterId: "user_lookalike", commenterName: "brand_one" }))).toBe("CREATED");
  });
});

// ─── BUG 5: DM each user once ────────────────────────────────────────────────

describe("Bug 5 — each user is DMed at most once per campaign", () => {
  beforeEach(() => {
    seedCampaign({ id: "auto_main" });
  });

  it("same user commenting ten times receives one DM", async () => {
    const comments = Array.from({ length: 10 }, () => comment({ commenterId: "user_same" }));
    for (const c of comments) await receive(c);

    expect(h.meta.sent).toHaveLength(1);
    const holder = jobFor(comments[0].commentId);
    expect(holder.status).toBe("SENT");
    const skipped = jobs().filter((j) => j.status === "SKIPPED_DEDUP");
    expect(skipped).toHaveLength(9);
    for (const job of skipped) {
      expect(job.dedupOfDeliveryJobId).toBe(holder.id);
      expect(job.errorCode).toBe("DUPLICATE_RECIPIENT");
    }
  });

  it("a duplicate webhook delivery creates no second delivery", async () => {
    const c = comment();
    await receive(c);
    await receive({ ...c });
    expect(jobs()).toHaveLength(1);
    expect(h.meta.sent).toHaveLength(1);
  });

  it("concurrent comments from the same user send once", async () => {
    const comments = Array.from({ length: 6 }, () => comment({ commenterId: "user_burst" }));
    await Promise.all(comments.map((c) => receive(c)));

    expect(h.meta.sent).toHaveLength(1);
    expect(jobs().filter((j) => j.status === "SKIPPED_DEDUP")).toHaveLength(5);
  });

  it("different users are not blocked", async () => {
    for (const id of ["u_a", "u_b", "u_c"]) await receive(comment({ commenterId: id }));
    expect(h.meta.sent).toHaveLength(3);
  });

  it("different Instagram accounts are isolated", async () => {
    seedCampaign({ id: "auto_acc2", account: "acc_2" });
    await receive(comment({ commenterId: "user_shared" }));
    await receive(comment({ commenterId: "user_shared", instagramAccountId: "ig_acc_2" }));
    expect(h.meta.sent.map((s) => s.instagramAccountId).sort()).toEqual(["ig_acc_1", "ig_acc_2"]);
  });

  it("another campaign may still DM the same user", async () => {
    seedCampaign({ id: "auto_price", scope: "SPECIFIC_POST", postId: "media_2", keywords: ["PRICE"] });
    await receive(comment({ commenterId: "user_x" }));
    await receive(comment({ commenterId: "user_x", mediaId: "media_2", commentText: "PRICE" }));
    expect(h.meta.sent).toHaveLength(2);
  });

  it("retrying the original delivery never creates another delivery", async () => {
    const c = comment();
    h.meta.nextErrors.push(new MetaApiError(2, undefined, undefined, "temporary"));
    await receive(c);
    advance(DELIVERY_CONFIG.backoffMaxMs + 1000);
    await runSchedulerPass({ queue: h.queue });
    await drainQueue();
    expect(jobs()).toHaveLength(1);
    expect(jobFor(c.commentId).status).toBe("SENT");
  });

  it("an UNKNOWN delivery keeps blocking (it may have been delivered)", async () => {
    h.meta.nextErrors.push(new MetaNetworkError("socket reset", true, "ECONNRESET"));
    await receive(comment({ commenterId: "user_u" }));
    await receive(comment({ commenterId: "user_u" }));
    expect(h.meta.sent).toHaveLength(1);
    expect(jobs().map((j) => j.status).sort()).toEqual(["SKIPPED_DEDUP", "UNKNOWN"]);
  });

  it("a definitively FAILED delivery releases the user for a later comment", async () => {
    h.meta.nextErrors.push(new MetaApiError(100, undefined, undefined, "Invalid parameter"));
    await receive(comment({ commenterId: "user_f" }));
    const second = comment({ commenterId: "user_f" });
    await receive(second);
    expect(jobFor(second.commentId).status).toBe("SENT");
  });
});

// ─── BUG 6 (worker side) / BUG 7 / BUG 12 ────────────────────────────────────

describe("Bugs 6, 7, 12 — rendering at delivery creation", () => {
  it("embeds a signed, delivery-specific tracked URL that survives retries", async () => {
    seedCampaign({
      dmMessage: "Grab it: {link}",
      trackedLink: { slug: "abc123XYZ_", destinationUrl: "https://shop.example.com/p" },
    });
    const c = comment();
    h.meta.nextErrors.push(new MetaApiError(2, undefined, undefined, "temporary"));
    await receive(c);
    const job = jobFor(c.commentId);
    const url = new URL(job.messagePayload.replace("Grab it: ", ""));
    expect(url.pathname).toBe("/r/abc123XYZ_");
    expect(url.searchParams.get("d")).toBe(job.id);
    expect(url.searchParams.get("s")).toMatch(/^[0-9a-f]{32}$/);

    advance(DELIVERY_CONFIG.backoffMaxMs + 1000);
    await deliverDeliveryJob(job.id);
    expect(h.meta.sent[1].message).toBe(h.meta.sent[0].message);
  });

  it("rewrites a raw destination URL to the tracked URL when {link} is not used", async () => {
    seedCampaign({
      dmMessage: "See https://shop.example.com/p now",
      trackedLink: { slug: "slug000001", destinationUrl: "https://shop.example.com/p" },
    });
    await receive(comment());
    expect(h.meta.sent[0].message).toContain("/r/slug000001?d=");
    expect(h.meta.sent[0].message).not.toContain("shop.example.com");
  });

  it("{link} without a tracked link fails validation and sends nothing", async () => {
    seedCampaign({ dmMessage: "Link: {link}" });
    const c = comment();
    expect(await receive(c)).toBe("INVALID_MESSAGE");
    expect(jobFor(c.commentId)).toMatchObject({ status: "FAILED", errorCode: "MISSING_TRACKED_LINK" });
    expect(h.meta.sent).toHaveLength(0);
  });

  it("an unsupported placeholder fails validation and sends nothing", async () => {
    seedCampaign({ dmMessage: "Hi {first_name}" });
    const c = comment();
    expect(await receive(c)).toBe("INVALID_MESSAGE");
    expect(jobFor(c.commentId).errorCode).toBe("UNSUPPORTED_PLACEHOLDER");
    expect(h.meta.sent).toHaveLength(0);
  });

  it("a variation over 1000 UTF-8 bytes (Hindi) is rejected before sending", async () => {
    seedCampaign({ dmMessage: "नमस्ते".repeat(60), variations: [{ id: "v_long", message: "नमस्ते".repeat(60) }] });
    // 6 code points x 3 bytes x 60 = 1080 bytes, only 360 JS characters.
    const c = comment();
    expect(await receive(c)).toBe("INVALID_MESSAGE");
    expect(jobFor(c.commentId).errorCode).toBe("MESSAGE_TOO_LONG");
    expect(h.meta.sent).toHaveLength(0);
  });

  it("preserves Hindi text and emoji end to end", async () => {
    seedCampaign({ dmMessage: "नमस्ते {username} 🎉 {username}" });
    await receive(comment({ commenterName: "प्रिया" }));
    expect(h.meta.sent[0].message).toBe("नमस्ते @प्रिया 🎉 @प्रिया");
  });

  it("refuses to send a legacy payload that still contains a placeholder", async () => {
    seedCampaign({ id: "auto_legacy_payload" });
    db.seed("deliveryJob", {
      id: "legacy_job",
      workspaceId: "ws_1",
      instagramAccountId: "acc_1",
      automationId: "auto_legacy_payload",
      triggerId: "legacy_comment",
      recipientId: "user_legacy",
      messagePayload: "Old renderer left {link} here",
      deadlineAt: new Date(T0.getTime() + 86_400_000),
    });
    expect(await deliverDeliveryJob("legacy_job")).toBe("INVALID_MESSAGE");
    expect(h.meta.sent).toHaveLength(0);
  });
});

// ─── BUG 8: fail closed ──────────────────────────────────────────────────────

describe("Bug 8 — worker errors fail closed and are never swallowed", () => {
  beforeEach(() => {
    seedCampaign({ id: "auto_main" });
  });

  it("database unavailable before the claim: no send, reservations released, job stays PENDING", async () => {
    const c = comment();
    await processCommentJob(c, { deliverInline: false });
    const job = jobFor(c.commentId);

    db.beforeOperation = (model, op, args: any) => {
      if (model === "deliveryJob" && op === "updateMany" && args?.data?.status === "SENDING") {
        throw new Error("connection terminated");
      }
    };
    await expect(deliverDeliveryJob(job.id)).rejects.toThrow("connection terminated");
    db.beforeOperation = undefined;

    expect(h.meta.sent).toHaveLength(0);
    expect(job.status).toBe("PENDING");
    expect(h.usage.count("ws_1")).toBe(0);
    expect(h.limiter.counts.get("ig_acc_1")).toBe(0);
  });

  it("delivery record cannot be created: nothing is sent and the comment stays recoverable", async () => {
    db.beforeOperation = (model, op) => {
      if (model === "deliveryJob" && op === "create") throw new Error("deadlock detected");
    };
    const c = comment();
    await expect(receive(c)).rejects.toThrow("deadlock detected");
    db.beforeOperation = undefined;

    expect(h.meta.sent).toHaveLength(0);
    expect(db.tables.inboundComment[0].status).toBe("RECEIVED");
  });

  it("contact persistence failure is not swallowed and blocks the send", async () => {
    db.beforeOperation = (model) => {
      if (model === "contact") throw new Error("relation \"Contact\" does not exist");
    };
    await expect(receive(comment())).rejects.toThrow("Contact");
    db.beforeOperation = undefined;
    expect(jobs()).toHaveLength(0);
    expect(h.meta.sent).toHaveLength(0);
  });

  it("database fails while persisting SENT: job stays SENDING, becomes UNKNOWN, never re-sent", async () => {
    const c = comment();
    db.beforeOperation = (model, op, args: any) => {
      if (model === "deliveryJob" && op === "updateMany" && args?.data?.status === "SENT") {
        throw new Error("connection lost");
      }
    };
    await expect(receive(c)).rejects.toThrow("connection lost");
    db.beforeOperation = undefined;

    expect(h.meta.sent).toHaveLength(1);
    expect(jobFor(c.commentId).status).toBe("SENDING");

    // BullMQ retry of the same job: must not send again.
    expect(await deliverDeliveryJob(jobFor(c.commentId).id)).toBe("NOT_PENDING");

    advance(DELIVERY_CONFIG.staleSendingMs + 1000);
    await runSchedulerPass({ queue: h.queue });
    await drainQueue();
    expect(jobFor(c.commentId)).toMatchObject({ status: "UNKNOWN", errorCode: "INTERRUPTED_WHILE_SENDING" });
    expect(h.meta.sent).toHaveLength(1);
    expect(h.usage.count("ws_1")).toBe(1); // possibly delivered: usage kept
  });

  it("a definite permanent Meta failure is recorded as FAILED and releases usage", async () => {
    h.meta.nextErrors.push(new MetaApiError(10, undefined, undefined, "Permission denied"));
    const c = comment();
    await receive(c);
    expect(jobFor(c.commentId)).toMatchObject({ status: "FAILED", errorCode: "10" });
    expect(h.usage.count("ws_1")).toBe(0);
    expect(db.tables.deliveryAttempt[0]).toMatchObject({ status: "FAILED", errorType: "PERMANENT" });
  });

  it("a Meta timeout after dispatch is UNKNOWN and is never retried", async () => {
    h.meta.nextErrors.push(new MetaNetworkError("timeout", true, "UND_ERR_HEADERS_TIMEOUT"));
    const c = comment();
    await receive(c);
    expect(jobFor(c.commentId).status).toBe("UNKNOWN");

    advance(24 * 60 * 60 * 1000);
    await runSchedulerPass({ queue: h.queue });
    await drainQueue();
    expect(h.meta.sent).toHaveLength(1);
    expect(h.usage.count("ws_1")).toBe(1);
  });

  it("an unclassified error from the send is treated as ambiguous (UNKNOWN)", async () => {
    h.meta.nextErrors.push(new TypeError("Cannot read properties of undefined"));
    const c = comment();
    await receive(c);
    expect(jobFor(c.commentId).status).toBe("UNKNOWN");
  });

  it("a connection that never reached Meta is retried safely", async () => {
    h.meta.nextErrors.push(new MetaNetworkError("refused", false, "ECONNREFUSED"));
    const c = comment();
    await receive(c);
    expect(jobFor(c.commentId).status).toBe("PENDING");
    advance(DELIVERY_CONFIG.backoffMaxMs + 1000);
    await runSchedulerPass({ queue: h.queue });
    await drainQueue();
    expect(jobFor(c.commentId).status).toBe("SENT");
  });

  it("gives up after the bounded number of transient failures", async () => {
    for (let i = 0; i < DELIVERY_CONFIG.maxTransientAttempts; i++) {
      h.meta.nextErrors.push(new MetaApiError(2, undefined, undefined, "temporary"));
    }
    const c = comment();
    await receive(c);
    for (let i = 0; i < DELIVERY_CONFIG.maxTransientAttempts; i++) {
      advance(DELIVERY_CONFIG.backoffMaxMs + 1000);
      await runSchedulerPass({ queue: h.queue });
      await drainQueue();
    }
    expect(jobFor(c.commentId).status).toBe("FAILED");
    expect(h.meta.sent).toHaveLength(DELIVERY_CONFIG.maxTransientAttempts);
  });

  it("a revoked token (190) fails the delivery and records an operational event", async () => {
    h.meta.nextErrors.push(new MetaApiError(190, undefined, undefined, "Session expired"));
    await receive(comment());
    expect(db.tables.instagramAccount[0].tokenExpiresAt.getTime()).toBe(0);
    expect(db.tables.operationalEvent.some((e) => e.message.includes("expired or revoked"))).toBe(true);
  });

  it("missing or undecryptable tokens fail before any send", async () => {
    const a = comment();
    await processCommentJob(a, { deliverInline: false });
    db.tables.instagramAccount[0].accessToken = "corrupt";
    expect(await deliverDeliveryJob(jobFor(a.commentId).id)).toBe("DECRYPT_FAILED");
    expect(h.meta.sent).toHaveLength(0);
  });
});

// ─── BUG 11: durable backlog ─────────────────────────────────────────────────

describe("Bug 11 — rate-limited backlog is durable and deadline-aware", () => {
  beforeEach(() => {
    seedCampaign({ id: "auto_viral" });
  });

  it("a viral post with thousands of comments never drops eligible ones when throttled", async () => {
    const TOTAL = 2000;
    const PER_WINDOW = 500;
    h.limiter.limit = PER_WINDOW;
    const comments = Array.from({ length: TOTAL }, () => comment());
    for (const c of comments) await receive(c);

    expect(h.meta.sent).toHaveLength(PER_WINDOW);
    const statuses = jobs().reduce<Record<string, number>>((acc, j) => {
      acc[j.status] = (acc[j.status] ?? 0) + 1;
      return acc;
    }, {});
    expect(statuses).toEqual({ SENT: PER_WINDOW, PENDING: TOTAL - PER_WINDOW });
    expect(jobs().filter((j) => j.status === "PENDING").every((j) => j.rateLimitDeferrals >= 1)).toBe(true);

    // Each window drains the next batch until everything is sent, with no
    // job ever dropped (the old engine skipped after 3 requeues).
    for (let window = 1; window <= TOTAL / PER_WINDOW; window++) {
      advance(h.limiter.windowMs + 31_000);
      h.limiter.resetWindow();
      // Scheduler batches are bounded; run passes until this window is used up.
      for (let pass = 0; pass < 3; pass++) {
        await runSchedulerPass({ queue: h.queue });
        await drainQueue();
      }
    }
    expect(h.meta.sent).toHaveLength(TOTAL);
    expect(new Set(h.meta.sent.map((s) => s.commentId)).size).toBe(TOTAL);
    expect(jobs().every((j) => j.status === "SENT")).toBe(true);
    expect(h.usage.count("ws_1")).toBe(TOTAL);
  }, 120_000);

  it("recovers pending deliveries after Redis loses every queued job", async () => {
    h.limiter.limit = 1;
    const a = comment();
    const b = comment();
    await receive(a);
    await receive(b);
    expect(jobFor(b.commentId).status).toBe("PENDING");

    h.queue.wipe();
    advance(h.limiter.windowMs + 31_000);
    h.limiter.resetWindow();
    const pass = await runSchedulerPass({ queue: h.queue });
    expect(pass.enqueued).toBe(1);
    await drainQueue();
    expect(jobFor(b.commentId).status).toBe("SENT");
  });

  it("recovers comments persisted by the webhook whose intake job was lost", async () => {
    const c = comment();
    db.seed("inboundComment", {
      instagramAccountId: c.instagramAccountId,
      commentId: c.commentId,
      mediaId: c.mediaId,
      commenterId: c.commenterId,
      commenterUsername: c.commenterName,
      commentText: c.commentText,
      commentedAt: new Date(),
      receivedAt: new Date(),
    });
    advance(DELIVERY_CONFIG.inboundRecoveryAgeMs + 1000);
    const pass = await runSchedulerPass({ queue: h.queue });
    expect(pass.inboundRecovered).toBe(1);
    await drainQueue();
    expect(jobFor(c.commentId).status).toBe("SENT");

    // A second pass does not re-enqueue a processed comment.
    expect((await runSchedulerPass({ queue: h.queue })).inboundRecovered).toBe(0);
  });

  it("a worker restart mid-send leaves UNKNOWN, never a second send", async () => {
    const c = comment();
    await processCommentJob(c, { deliverInline: false });
    const job = jobFor(c.commentId);
    Object.assign(job, { status: "SENDING", processingStartedAt: new Date(), attemptCount: 1 });

    advance(DELIVERY_CONFIG.staleSendingMs + 1);
    await runSchedulerPass({ queue: h.queue });
    await drainQueue();
    expect(job.status).toBe("UNKNOWN");
    expect(h.meta.sent).toHaveLength(0);
  });

  it("honors Meta's Retry-After and releases the monthly reservation", async () => {
    h.meta.nextErrors.push(new RateLimitError("Too many calls", undefined, 120_000, 4));
    const c = comment();
    await receive(c);
    const job = jobFor(c.commentId);

    expect(job.status).toBe("PENDING");
    const delay = job.scheduledAt.getTime() - T0.getTime();
    expect(delay).toBeGreaterThanOrEqual(120_000);
    expect(delay).toBeLessThan(150_000);
    expect(h.usage.count("ws_1")).toBe(0);
    expect(db.tables.deliveryAttempt[0]).toMatchObject({ errorType: "RATE_LIMITED", status: "FAILED" });

    advance(60_000);
    await runSchedulerPass({ queue: h.queue });
    await drainQueue();
    expect(h.meta.sent).toHaveLength(1); // not before Retry-After

    advance(91_000);
    await runSchedulerPass({ queue: h.queue });
    await drainQueue();
    expect(job.status).toBe("SENT");
    expect(h.usage.count("ws_1")).toBe(1); // exactly one reservation for one DM
  });

  it("multiple concurrent workers send a job exactly once", async () => {
    const c = comment();
    await processCommentJob(c, { deliverInline: false });
    const id = jobFor(c.commentId).id;
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => deliverDeliveryJob(id)));
    expect(outcomes.filter((o) => o === "SENT")).toHaveLength(1);
    expect(h.meta.sent).toHaveLength(1);
    expect(h.usage.count("ws_1")).toBe(1);
    expect(h.limiter.counts.get("ig_acc_1")).toBe(1);
  });

  it("prioritizes earlier deadlines and expires jobs that miss their window", async () => {
    h.limiter.limit = 0;
    const deadlineMs = (DELIVERY_CONFIG.privateReplyWindowHours * 60 - DELIVERY_CONFIG.deadlineSafetyMarginMinutes) * 60_000;
    const old = comment({ commentedAt: new Date(T0.getTime() - deadlineMs + 30 * 60_000).toISOString() });
    const fresh = comment();
    await receive(old);
    await receive(fresh);

    const oldJob = jobFor(old.commentId);
    const deliverJobs = [...h.queue.jobs.values()].filter((j) => j.name === "deliver");
    const priorityOf = (id: string) => deliverJobs.find((j) => j.data.deliveryJobId === id)!.opts.priority!;
    expect(priorityOf(oldJob.id)).toBeLessThan(priorityOf(jobFor(fresh.commentId).id));

    advance(31 * 60_000);
    const pass = await runSchedulerPass({ queue: h.queue });
    expect(pass.expired).toBe(1);
    expect(oldJob).toMatchObject({ status: "EXPIRED", dedupKey: null, errorCode: "DEADLINE_PASSED" });
    expect(h.meta.sent).toHaveLength(0);
  });

  it("comments already past the window are recorded as EXPIRED, not sent", async () => {
    const c = comment({ commentedAt: new Date(T0.getTime() - 8 * 86_400_000).toISOString() });
    expect(await receive(c)).toBe("EXPIRED");
    expect(h.meta.sent).toHaveLength(0);
  });

  it("repeated scheduler passes and duplicate queue entries never duplicate a delivery", async () => {
    h.limiter.limit = 2;
    const comments = Array.from({ length: 5 }, () => comment());
    for (const c of comments) await receive(c);
    advance(h.limiter.windowMs + 31_000);
    h.limiter.limit = 100;
    for (let i = 0; i < 3; i++) await runSchedulerPass({ queue: h.queue });
    for (const job of jobs()) {
      await h.queue.add("deliver", { deliveryJobId: job.id }, { jobId: `dup-${job.id}` });
    }
    await drainQueue();
    expect(h.meta.sent).toHaveLength(5);
    expect(new Set(h.meta.sent.map((s) => s.commentId)).size).toBe(5);
  });

  it("monthly plan limit closes the job without sending and releases the throughput slot", async () => {
    h.usage.limit = 0;
    const c = comment();
    await receive(c);
    expect(jobFor(c.commentId)).toMatchObject({ status: "SKIPPED_PLAN_LIMIT", dedupKey: null });
    expect(h.limiter.counts.get("ig_acc_1")).toBe(0);
  });
});

// ─── BUG 9 (worker side) / BUG 10 (worker side) ──────────────────────────────

describe("DeliveryJob is the only delivery record; disconnected accounts never send", () => {
  it("the worker never touches the legacy DmLog table", async () => {
    seedCampaign();
    await receive(comment());
    expect("dmLog" in db).toBe(false); // any access would have thrown
    expect(jobs()).toHaveLength(1);
  });

  it("comments for a disconnected account are ignored", async () => {
    seedCampaign();
    db.tables.instagramAccount[0].status = "DISCONNECTED";
    expect(await receive(comment())).toBe("ACCOUNT_NOT_CONNECTED");
    expect(jobs()).toHaveLength(0);
  });

  it("queued deliveries do not send once the account is disconnecting", async () => {
    seedCampaign();
    const c = comment();
    await processCommentJob(c, { deliverInline: false });
    db.tables.instagramAccount[0].status = "DISCONNECTING";
    expect(await deliverDeliveryJob(jobFor(c.commentId).id)).toBe("ACCOUNT_DISCONNECTED");
    expect(h.meta.sent).toHaveLength(0);
    expect(jobFor(c.commentId).dedupKey).toBeNull();
  });

  it("a campaign paused after matching does not send", async () => {
    seedCampaign({ id: "auto_pause" });
    const c = comment();
    await processCommentJob(c, { deliverInline: false });
    db.tables.automation[0].isActive = false;
    expect(await deliverDeliveryJob(jobFor(c.commentId).id)).toBe("CAMPAIGN_INACTIVE");
    expect(h.meta.sent).toHaveLength(0);
  });
});
