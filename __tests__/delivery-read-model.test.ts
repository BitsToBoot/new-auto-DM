/**
 * Bug 9 — DeliveryJob is the single source of truth for dashboards, logs,
 * analytics, reports and diagnostics; DmLog is only read by the backfill.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ workspaceId: "ws_1" as string | null }));

vi.mock("@/lib/db/client", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  return { prisma: createFakePrisma() };
});
vi.mock("@/lib/auth", () => ({ getCurrentWorkspaceId: async () => h.workspaceId }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { FakePrisma } from "./helpers/fake-prisma";
import { GET as getStats } from "../app/api/dashboard/stats/route";
import { GET as getLogs } from "../app/api/logs/route";
import { getCampaignReportBySlug } from "@/lib/reports/data";
import { DELIVERY_BACKFILL_STATEMENTS } from "@/lib/delivery/backfill";

const db = prisma as unknown as FakePrisma;
const ROOT = path.resolve(__dirname, "..");

function seed() {
  const now = new Date();
  db.seed("workspace", { id: "ws_1", name: "One", ownerId: "u", plan: "PRO", subscriptionStatus: "ACTIVE" });
  db.seed("workspace", { id: "ws_2", name: "Two", ownerId: "u2" });
  db.seed("instagramAccount", { id: "acc_1", workspaceId: "ws_1", instagramId: "ig_1", username: "brand", accessToken: "x" });
  db.seed("instagramAccount", { id: "acc_old", workspaceId: "ws_1", instagramId: "ig_old", username: "old", accessToken: "", status: "DISCONNECTED" });
  db.seed("automation", {
    id: "auto_1",
    workspaceId: "ws_1",
    instagramAccountId: "acc_1",
    name: "Launch",
    keywords: ["LINK"],
    dmMessage: "m",
    reportShareSlug: "share_1",
    reportShareEnabled: true,
  });
  const job = (id: string, status: string, extra: Record<string, unknown> = {}) =>
    db.seed("deliveryJob", {
      id,
      workspaceId: "ws_1",
      instagramAccountId: "acc_1",
      automationId: "auto_1",
      triggerId: `comment_${id}`,
      recipientId: `user_${id}`,
      recipientUsername: `fan_${id}`,
      commentText: `LINK from ${id}`,
      matchedKeyword: "LINK",
      messagePayload: "m",
      status,
      ...extra,
    });
  job("j_sent_1", "SENT", { sentAt: now });
  job("j_sent_2", "SENT", { sentAt: now });
  job("j_failed", "FAILED", { lastError: "Permission denied" });
  job("j_unknown", "UNKNOWN");
  job("j_dedup", "SKIPPED_DEDUP");
  job("j_expired", "EXPIRED");
  // Another tenant's data must never leak in.
  db.seed("deliveryJob", {
    id: "j_other",
    workspaceId: "ws_2",
    instagramAccountId: "acc_x",
    automationId: "auto_x",
    triggerId: "c_x",
    recipientId: "u_x",
    messagePayload: "m",
    status: "SENT",
    sentAt: now,
  });
}

beforeEach(() => {
  db.reset();
  h.workspaceId = "ws_1";
  seed();
});

describe("dashboard, logs and reports read DeliveryJob", () => {
  it("dashboard counts and recent activity come from DeliveryJob", async () => {
    const response = await getStats(new NextRequest("https://app.test/api/dashboard/stats"));
    const { data } = await response.json();

    expect(data.dmsSentToday).toBe(2);
    expect(data.totalDMs).toBe(2);
    expect(data.dmsFailedMonth).toBe(2); // FAILED + UNKNOWN (needs review)
    expect(data.dmsSkippedMonth).toBe(2); // SKIPPED_DEDUP + EXPIRED
    expect(data.topKeywords).toEqual([{ keyword: "LINK", count: 6 }]);
    expect(data.recentLogs).toHaveLength(6);
    expect(data.recentLogs[0]).toMatchObject({
      commenterId: expect.stringMatching(/^user_/),
      commenterName: expect.stringMatching(/^fan_/),
      commentText: expect.stringContaining("LINK from"),
      automation: { name: "Launch" },
      instagramAccount: { username: "brand" },
    });
    // Disconnected accounts are not listed as connected.
    expect(data.instagramAccounts.map((a: { id: string }) => a.id)).toEqual(["acc_1"]);
  });

  it("logs API keeps its response contract while reading DeliveryJob", async () => {
    const response = await getLogs(new NextRequest("https://app.test/api/logs?status=FAILED"));
    const { data } = await response.json();
    expect(data.pagination.total).toBe(1);
    expect(data.logs[0]).toMatchObject({
      id: "j_failed",
      status: "FAILED",
      errorMessage: "Permission denied",
      commentText: "LINK from j_failed",
      automation: { name: "Launch", keywords: ["LINK"] },
    });
  });

  it("shared campaign reports aggregate DeliveryJob", async () => {
    const report = await getCampaignReportBySlug("share_1");
    expect(report?.metrics).toMatchObject({ sent: 2, failed: 2, skipped: 2 });
    expect(report?.metrics.latestSentAt).toBeInstanceOf(Date);
  });
});

describe("DmLog retirement safety", () => {
  const sourceFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "generated" ? [] : sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    });

  it("no application code reads or writes DmLog through Prisma", () => {
    const offenders = ["app", "lib", "worker", "components"]
      .flatMap((dir) => sourceFiles(path.join(ROOT, dir)))
      .filter((file) => /prisma\.dmLog\b|tx\.dmLog\b|"DmLog"/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(ROOT, file));
    // Only the backfill reads the legacy table (raw SQL).
    expect(offenders).toEqual([path.join("lib", "delivery", "backfill.ts")]);
  });

  it("the migration keeps DmLog and embeds the exact repeatable backfill", () => {
    const migration = fs.readFileSync(
      path.join(ROOT, "prisma/migrations/20261109000000_delivery_engine_remediation/migration.sql"),
      "utf8"
    );
    expect(migration).not.toMatch(/DROP TABLE/i);
    expect(migration).not.toMatch(/DROP COLUMN/i);
    // Guard against CLI output leaking into generated SQL.
    expect(migration).not.toMatch(/Prisma config|injected env|^◇/m);
    for (const statement of DELIVERY_BACKFILL_STATEMENTS) {
      expect(migration).toContain(statement);
    }
  });

  it("every backfill statement is idempotent", () => {
    const [copyContext, insertMissing, deadlines, dedupKeys, closeDuplicates] = DELIVERY_BACKFILL_STATEMENTS;
    expect(copyContext).toMatch(/"legacyDmLogId" IS NULL OR dj\."commentText" IS NULL/);
    expect(insertMissing).toMatch(/WHERE NOT EXISTS/);
    expect(insertMissing).toMatch(/ON CONFLICT DO NOTHING/);
    expect(deadlines).toMatch(/WHERE "deadlineAt" IS NULL/);
    expect(dedupKeys).toMatch(/dj\."dedupKey" IS NULL/);
    expect(closeDuplicates).toMatch(/dj\."status" = 'PENDING'/);
    // Legacy rows without a rendered message are never left sendable.
    expect(insertMissing).toMatch(/WHEN 'PENDING' THEN 'FAILED'/);
  });
});
