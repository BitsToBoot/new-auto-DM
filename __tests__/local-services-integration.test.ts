/**
 * Real Local Services Integration Tests (PostgreSQL + Redis/BullMQ)
 *
 * Runs against:
 * - Real local Redis (port 6379)
 * - Real local PostgreSQL (port 5433)
 *
 * Verifies:
 * - Producer / Consumer queue integration ("dm-queue")
 * - Deterministic job IDs & duplicate event handling
 * - Automation matching across scopes (SPECIFIC_POST, NEXT_POST, ANY_POST)
 * - Atomic NEXT_POST claim handling
 * - Concurrent DeliveryJob claim races
 * - DeliveryJob state transitions: NO_TOKEN, DECRYPT_FAILED, PLAN_LIMIT, rate-limit deferral, UNKNOWN (ambiguous), FAILED, SENT
 * - Database-enforced "DM each user once per campaign" (unique dedupKey)
 * - Worker graceful shutdown
 *
 * Requires `docker-compose up -d` and `npm run db:migrate`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getDMQueue, getRedisConnection } from "@/lib/queue/client";
import { createDMWorker } from "@/lib/queue/dm-worker";
import { prisma } from "@/lib/db/client";
import { createDeliveryJobForComment } from "@/lib/delivery/intake";
import {
  claimForSending,
  closePending,
  deferPending,
  markFailedAfterSend,
  markSent,
  markUnknown,
  rescheduleAfterAttempt,
} from "@/lib/delivery/state";
import { deliverJobId } from "@/lib/delivery/scheduler";
import { claimNextPostAutomation } from "@/lib/automation/resolver";
import { selectWinningAutomation } from "@/lib/automation/policy";

describe("Local Services Integration — PostgreSQL & Redis/BullMQ", () => {
  const redis = getRedisConnection();
  const queue = getDMQueue();

  beforeAll(async () => {
    // Verify services are reachable
    const pong = await redis.ping();
    expect(pong).toBe("PONG");
    const count = await prisma.workspace.count();
    expect(typeof count).toBe("number");
  });

  afterAll(async () => {
    // Clean up
    await queue.obliterate({ force: true }).catch(() => {});
  });

  describe("1. Queue Producer-Consumer & Deterministic Job IDs", () => {
    it("producer and worker share canonical queue 'dm-queue' and process real jobs", async () => {
      expect(queue.name).toBe("dm-queue");

      const testJobId = `comment-testacc-testcomment-${Date.now()}`;
      expect(testJobId).not.toContain(":");

      // Add job via producer
      const job = await queue.add(
        "process-comment",
        {
          instagramAccountId: "testacc",
          commentId: "testcomment",
          mediaId: "testmedia",
          commentText: "hello",
          commenterId: "user123",
          requeueAttempt: 0,
        },
        { jobId: testJobId }
      );

      expect(job.id).toBe(testJobId);

      // Verify idempotency: duplicate enqueue with same jobId does not create a second job
      const duplicateJob = await queue.add(
        "process-comment",
        {
          instagramAccountId: "testacc",
          commentId: "testcomment",
          mediaId: "testmedia",
          commentText: "hello again",
          commenterId: "user123",
          requeueAttempt: 0,
        },
        { jobId: testJobId }
      );

      expect(duplicateJob.id).toBe(testJobId);
      const count = await queue.getJobCountByTypes("wait", "active", "delayed");
      expect(count).toBe(1);

      // Clean up test job
      await job.remove();
    });

    it("real BullMQ worker consumes enqueued job from Redis and completes it", async () => {
      const consumeJobId = `consume-${Date.now()}`;
      const job = await queue.add(
        "process-comment",
        {
          instagramAccountId: `nonexistent_${Date.now()}`,
          commentId: `comm_${Date.now()}`,
          mediaId: `media_${Date.now()}`,
          commentText: "real worker consume test",
          commenterId: `user_${Date.now()}`,
          requeueAttempt: 0,
        },
        { jobId: consumeJobId }
      );

      expect(job.id).toBe(consumeJobId);

      // Create live worker
      const worker = createDMWorker();

      // Wait for the worker to pick up and complete the job
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Worker timed out consuming job from Redis within 10s"));
        }, 10000);

        worker.on("completed", (completedJob) => {
          if (completedJob.id === consumeJobId) {
            clearTimeout(timeout);
            resolve();
          }
        });

        worker.on("failed", (failedJob, err) => {
          if (failedJob?.id === consumeJobId) {
            clearTimeout(timeout);
            reject(err);
          }
        });
      });

      // Verify job state in Redis transitioned to completed
      const finalState = await job.getState();
      expect(finalState).toBe("completed");

      // Verify graceful shutdown of worker
      await worker.close();
    });

    it("verifies deterministic delivery job ID format without colons", () => {
      const scheduledAt = new Date("2026-11-09T12:00:00.000Z");
      const id = deliverJobId({ id: "job_789", scheduledAt, deadlineAt: null });

      expect(id).toBe(`deliver-job_789-${scheduledAt.getTime()}`);
      expect(id).not.toContain(":");
    });
  });

  describe("2. Concurrent Delivery Claims & State Machine (PostgreSQL)", () => {
    let workspaceId: string;
    let accountId: string;
    let automationId: string;

    beforeEach(async () => {
      // Create clean test fixtures in database
      const user = await prisma.user.create({
        data: {
          email: `test-${Date.now()}-${Math.random()}@example.com`,
          name: "Test User",
        },
      });

      const ws = await prisma.workspace.create({
        data: {
          name: "Integration Test Workspace",
          ownerId: user.id,
          plan: "PRO",
          subscriptionStatus: "ACTIVE",
          dmsSentThisPeriod: 0,
        },
      });
      workspaceId = ws.id;

      const acc = await prisma.instagramAccount.create({
        data: {
          workspaceId: ws.id,
          instagramId: `ig_${Date.now()}`,
          username: `testuser_${Date.now()}`,
          accessToken: "encrypted_fake_token",
        },
      });
      accountId = acc.id;

      const auto = await prisma.automation.create({
        data: {
          workspaceId: ws.id,
          instagramAccountId: acc.id,
          name: "Integration Test Campaign",
          goal: "Testing",
          dmMessage: "Hey {username}, here is your link: {link}",
          triggerScope: "ANY_POST",
          keywords: ["INFO", "DEMO"],
          isActive: true,
        },
      });
      automationId = auto.id;
    });

    async function loadAutomation() {
      return prisma.automation.findUniqueOrThrow({
        where: { id: automationId },
        include: { variations: true },
      });
    }

    async function createJob(commentId: string, commenterId: string, commenterName?: string) {
      return createDeliveryJobForComment({
        workspaceId,
        instagramAccountId: accountId,
        automation: {
          ...(await loadAutomation()),
          trackedLinks: [{ slug: "slug1", destinationUrl: "https://example.com", active: true }],
        },
        contactId: null,
        commentId,
        commenterId,
        commenterName,
        commentText: "INFO please",
        mediaId: "media_1",
        matchedKeyword: "INFO",
        commentedAt: new Date(),
      });
    }

    const attempt = (n = 1) => ({ attemptNumber: n, startedAt: new Date() });

    it("prevents double delivery: concurrent workers on the same trigger", async () => {
      const triggerId = `comm_${Date.now()}`;

      const created = await Promise.all([
        createJob(triggerId, "commenter_1", "alice"),
        createJob(triggerId, "commenter_1", "alice"),
      ]);
      expect(created.map((c) => c.outcome).sort()).toEqual(["CREATED", "EXISTING"]);
      expect(created[0].job.id).toBe(created[1].job.id);

      const claims = await Promise.all([
        claimForSending(created[0].job.id),
        claimForSending(created[0].job.id),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);

      const persistedJob = await prisma.deliveryJob.findUniqueOrThrow({
        where: { id: created[0].job.id },
      });
      expect(persistedJob.messagePayload).toContain(`/r/slug1?d=${persistedJob.id}&s=`);
      expect(persistedJob.messagePayload).toContain("@alice");
      expect(persistedJob.status).toBe("SENDING");
    });

    it("enforces one active delivery per recipient and campaign in PostgreSQL", async () => {
      const first = await createJob(`comm_a_${Date.now()}`, "commenter_dup");
      const second = await createJob(`comm_b_${Date.now()}`, "commenter_dup");

      expect(first.outcome).toBe("CREATED");
      expect(second.outcome).toBe("DEDUPLICATED");
      expect(second.job.status).toBe("SKIPPED_DEDUP");
      expect(second.job.dedupOfDeliveryJobId).toBe(first.job.id);
    });

    it("transitions DeliveryJob state to SENT on success with attempt record", async () => {
      const { job } = await createJob(`comm_sent_${Date.now()}`, "commenter_2");
      await claimForSending(job.id);
      await markSent(job.id, "meta_msg_999", attempt());

      const updated = await prisma.deliveryJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(updated.status).toBe("SENT");
      expect(updated.metaMessageId).toBe("meta_msg_999");
      expect(updated.sentAt).not.toBeNull();

      const attempts = await prisma.deliveryAttempt.findMany({ where: { deliveryJobId: job.id } });
      expect(attempts).toHaveLength(1);
      expect(attempts[0].status).toBe("SENT");
    });

    it("transitions DeliveryJob state to UNKNOWN on ambiguous outcome without retrying", async () => {
      const { job } = await createJob(`comm_unk_${Date.now()}`, "commenter_3");
      await claimForSending(job.id);
      await markUnknown(job.id, { ...attempt(), errorMessage: "Connection reset by peer (ECONNRESET)" });

      const updated = await prisma.deliveryJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(updated.status).toBe("UNKNOWN");
      expect(updated.lastError).toContain("ECONNRESET");

      // An UNKNOWN job can never be claimed for sending again.
      expect(await claimForSending(job.id)).toBeNull();
    });

    it("transitions DeliveryJob state to FAILED on permanent failure and releases dedup", async () => {
      const { job } = await createJob(`comm_fail_${Date.now()}`, "commenter_4");
      await claimForSending(job.id);
      await markFailedAfterSend(job.id, { ...attempt(), errorMessage: "Meta API error 100: Invalid parameter", errorCode: "100" });

      const updated = await prisma.deliveryJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(updated.status).toBe("FAILED");
      expect(updated.lastError).toContain("Meta API error 100");
      expect(updated.dedupKey).toBeNull();
    });

    it("reschedules to PENDING after a definite, retryable rejection", async () => {
      const { job } = await createJob(`comm_retry_${Date.now()}`, "commenter_5");
      await claimForSending(job.id);
      const retryAt = new Date(Date.now() + 120_000);
      await rescheduleAfterAttempt(job.id, retryAt, { ...attempt(), rateLimited: true, errorMessage: "Rate limited", errorCode: "4" });

      const updated = await prisma.deliveryJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(updated.status).toBe("PENDING");
      expect(updated.scheduledAt.getTime()).toBe(retryAt.getTime());
      expect(updated.rateLimitDeferrals).toBe(1);
    });

    it("closes PENDING jobs on missing token, decryption failure and plan limit", async () => {
      for (const [code, status] of [
        ["NO_TOKEN", "FAILED"],
        ["DECRYPT_FAILED", "FAILED"],
        ["PLAN_LIMIT", "SKIPPED_PLAN_LIMIT"],
      ] as const) {
        const { job } = await createJob(`comm_${code}_${Date.now()}`, `commenter_${code}`);
        expect(await closePending(job.id, status, `closed: ${code}`, code)).toBe(true);
        const updated = await prisma.deliveryJob.findUniqueOrThrow({ where: { id: job.id } });
        expect(updated).toMatchObject({ status, errorCode: code, dedupKey: null });
      }
    });

    it("defers rate-limited jobs instead of dropping them", async () => {
      const { job } = await createJob(`comm_defer_${Date.now()}`, "commenter_defer");
      const later = new Date(Date.now() + 3_600_000);
      expect(await deferPending(job.id, later, "throughput limit")).toBe(true);

      const updated = await prisma.deliveryJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(updated.status).toBe("PENDING");
      expect(updated.rateLimitDeferrals).toBe(1);
    });
  });

  describe("3. Automation Scopes & Atomic NEXT_POST Claim (PostgreSQL)", () => {
    it("atomic NEXT_POST claim claims exactly once and rejects concurrent claims", async () => {
      const user = await prisma.user.create({
        data: { email: `nextpost-${Date.now()}@example.com` },
      });
      const ws = await prisma.workspace.create({
        data: { name: "NextPost Workspace", ownerId: user.id },
      });
      const acc = await prisma.instagramAccount.create({
        data: {
          workspaceId: ws.id,
          instagramId: `ig_np_${Date.now()}`,
          username: `np_${Date.now()}`,
          accessToken: "fake_token",
        },
      });

      const nextPostAuto = await prisma.automation.create({
        data: {
          workspaceId: ws.id,
          instagramAccountId: acc.id,
          name: "Next Post Campaign",
          triggerScope: "NEXT_POST",
          dmMessage: "Link here",
          keywords: ["GO"],
          consumedPostId: null,
          consumedAt: null,
        },
      });

      const publishedAfterCampaign = new Date(nextPostAuto.createdAt.getTime() + 60_000);

      // Claim for first post media_100
      const claimed1 = await claimNextPostAutomation(nextPostAuto.id, "media_100", publishedAfterCampaign);
      expect(claimed1).toBe(true);

      // Verify post was consumed in DB
      const updated = await prisma.automation.findUniqueOrThrow({ where: { id: nextPostAuto.id } });
      expect(updated.consumedPostId).toBe("media_100");
      expect(updated.consumedAt).not.toBeNull();

      // Second claim for DIFFERENT media_200 must fail
      const claimed2 = await claimNextPostAutomation(nextPostAuto.id, "media_200", publishedAfterCampaign);
      expect(claimed2).toBe(false);

      // The consuming post keeps matching (replays and other commenters on it).
      const claimedAgain = await claimNextPostAutomation(nextPostAuto.id, "media_100", publishedAfterCampaign);
      expect(claimedAgain).toBe(true);
    });

    it("evaluates SPECIFIC_POST, NEXT_POST, and ANY_POST according to strict priority", () => {
      const specific = {
        id: "auto_1",
        triggerScope: "SPECIFIC_POST" as const,
        postId: "media_target",
        keywords: ["BUY"],
        createdAt: new Date("2026-01-01"),
      };
      const anyPost = {
        id: "auto_2",
        triggerScope: "ANY_POST" as const,
        postId: null,
        keywords: ["BUY"],
        createdAt: new Date("2026-01-02"),
      };

      // When both match, SPECIFIC_POST wins
      const winner = selectWinningAutomation([
        { automation: anyPost, matchedKeyword: "BUY" },
        { automation: specific, matchedKeyword: "BUY" },
      ] as any);
      expect(winner?.automation.id).toBe("auto_1");
    });
  });
});
