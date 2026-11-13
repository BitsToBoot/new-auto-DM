import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  renderDmMessage,
  selectMessageVariation,
} from "@/lib/delivery/renderer";

process.env.NEXTAUTH_SECRET = "test-secret-for-tracked-link-signatures";

vi.mock("@/lib/db/client", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  return { prisma: createFakePrisma() };
});

import { prisma } from "@/lib/db/client";
import type { FakePrisma } from "./helpers/fake-prisma";
import { createDeliveryJobForComment } from "@/lib/delivery/intake";
import {
  DeliveryStateConflictError,
  claimForSending,
  markSent,
  markUnknown,
  rescheduleAfterAttempt,
} from "@/lib/delivery/state";

const db = prisma as unknown as FakePrisma;

describe("Phase 2 — Message Variations & Rendering", () => {
  it("renders {username}, {name}, and {link} placeholders deterministically", () => {
    const template = "Hey {username} ({name})! Click here: {link}";
    const rendered = renderDmMessage(template, {
      username: "alex99",
      displayName: "Alex Johnson",
      trackedUrl: "https://campaigncue.com/r/xyz123",
    });

    expect(rendered).toBe("Hey @alex99 (Alex Johnson)! Click here: https://campaigncue.com/r/xyz123");
  });

  it("falls back gracefully when placeholders are not provided", () => {
    const template = "Hey {name}! Hope you like this.";
    const rendered = renderDmMessage(template, {});
    expect(rendered).toBe("Hey friend! Hope you like this.");
  });

  it("never selects inactive variations", () => {
    const variations = [
      { id: "var_1", message: "Active Variation", isActive: true },
      { id: "var_2", message: "Inactive Variation", isActive: false },
    ];

    for (let i = 0; i < 25; i++) {
      const selected = selectMessageVariation(variations, "Fallback default", `comment_${i}`);
      expect(selected.variationId).not.toBe("var_2");
      expect(["Active Variation", "Fallback default"]).toContain(selected.template);
    }
  });

  it("falls back to default automation.dmMessage if no active variations exist", () => {
    const variations = [
      { id: "var_2", message: "Inactive Variation", isActive: false },
    ];

    const selected = selectMessageVariation(variations, "Fallback default", "comment_1");
    expect(selected.variationId).toBeNull();
    expect(selected.template).toBe("Fallback default");
  });
});

describe("Phase 2 — Delivery Job & Retry Message Stability", () => {
  const automation = {
    id: "auto_1",
    dmMessage: "Fallback DM",
    variations: [
      { id: "var_A", message: "Variation A for {username}", isActive: true },
      { id: "var_B", message: "Variation B for {username}", isActive: true },
    ],
  };

  const input = (commentId: string) => ({
    workspaceId: "ws_1",
    instagramAccountId: "acc_1",
    automation,
    contactId: null,
    commentId,
    commenterId: `user_${commentId}`,
    commenterName: "alex",
    commentText: "VIP",
    mediaId: "media_1",
    matchedKeyword: "VIP",
    commentedAt: new Date(),
  });

  beforeEach(() => db.reset());

  it("persists the selected variation and the fully rendered message on creation", async () => {
    const outcome = await createDeliveryJobForComment(input("comment_1"));

    expect(outcome.outcome).toBe("CREATED");
    const job = db.tables.deliveryJob[0];
    const expected = selectMessageVariation(automation.variations, automation.dmMessage, "comment_1");
    expect(job.selectedVariationId).toBe(expected.variationId);
    expect(job.messagePayload).toBe(renderDmMessage(expected.template, { username: "alex" }));
    expect(job.status).toBe("PENDING");
    expect(job.deadlineAt).toBeInstanceOf(Date);
  });

  it("reuses the exact persisted message on retry without re-selecting a variation", async () => {
    await createDeliveryJobForComment(input("comment_1"));
    db.tables.deliveryJob[0].messagePayload = "Original Persisted Variation B";

    // Campaign copy changes between attempts; the retry must not pick it up.
    const replay = await createDeliveryJobForComment({
      ...input("comment_1"),
      automation: { ...automation, variations: [{ id: "var_C", message: "New copy", isActive: true }] },
    });

    expect(replay.outcome).toBe("EXISTING");
    expect(db.tables.deliveryJob).toHaveLength(1);
    expect(replay.job.messagePayload).toBe("Original Persisted Variation B");
  });

  it("records delivery attempts on every state transition", async () => {
    await createDeliveryJobForComment(input("comment_1"));
    const id = db.tables.deliveryJob[0].id;
    const startedAt = new Date();

    const claimed = await claimForSending(id);
    expect(claimed).toMatchObject({ status: "SENDING", attemptCount: 1 });
    await rescheduleAfterAttempt(id, new Date(Date.now() + 60_000), {
      attemptNumber: 1,
      startedAt,
      rateLimited: false,
      errorMessage: "500 Server error",
      errorCode: "2",
    });
    expect(db.tables.deliveryJob[0].status).toBe("PENDING");

    await claimForSending(id);
    await markUnknown(id, { attemptNumber: 2, startedAt, errorMessage: "Network timeout" });
    expect(db.tables.deliveryJob[0].status).toBe("UNKNOWN");

    expect(db.tables.deliveryAttempt.map((a) => [a.attemptNumber, a.status, a.errorType])).toEqual([
      [1, "FAILED", "RETRYABLE"],
      [2, "UNKNOWN", "AMBIGUOUS"],
    ]);
  });

  it("refuses to overwrite a state it does not own", async () => {
    await createDeliveryJobForComment(input("comment_1"));
    const id = db.tables.deliveryJob[0].id;
    // Not SENDING: a late SENT write must not clobber the row or add an attempt.
    await expect(markSent(id, "mid", { attemptNumber: 1, startedAt: new Date() })).rejects.toBeInstanceOf(
      DeliveryStateConflictError
    );
    expect(db.tables.deliveryJob[0].status).toBe("PENDING");
    expect(db.tables.deliveryAttempt).toHaveLength(0);
  });

  it("only one of two concurrent claims wins", async () => {
    await createDeliveryJobForComment(input("comment_1"));
    const id = db.tables.deliveryJob[0].id;
    const results = await Promise.all([claimForSending(id), claimForSending(id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
