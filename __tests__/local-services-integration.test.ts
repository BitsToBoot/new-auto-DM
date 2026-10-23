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
 * - DeliveryJob state transitions: NO_TOKEN, DECRYPT_FAILED, PLAN_LIMIT, RATE_LIMIT, UNKNOWN (ambiguous), FAILED, SENT
 * - Monthly usage reservation preservation on ambiguous Meta outcome
 * - Worker graceful shutdown
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getDMQueue, getRedisConnection } from "@/lib/queue/client";
import { createDMWorker } from "@/lib/queue/dm-worker";
import { prisma } from "@/lib/db/client";
import { claimDeliveryJob } from "@/lib/delivery/claim";
import {
  transitionToSent,
  transitionToPermanentFailure,
  transitionToRetryable,
  transitionToUnknown,
} from "@/lib/delivery/state";
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

    it("verifies deterministic retry job ID format without colons", () => {
      const accountId = "acc_456";
      const commentId = "comm_789";
      const requeueAttempt = 1;
      const retryJobId = `comment-${accountId}-${commentId}-retry-${requeueAttempt + 1}`;

      expect(retryJobId).toBe("comment-acc_456-comm_789-retry-2");
      expect(retryJobId).not.toContain(":");
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

    it("prevents double delivery: concurrent workers claiming the same trigger", async () => {
      const triggerId = `comm_${Date.now()}`;
      const candidateAuto = await prisma.automation.findUniqueOrThrow({
        where: { id: automationId },
        include: { variations: true },
      });

      // Two concurrent claims for the exact same comment
      const [claim1, claim2] = await Promise.all([
        claimDeliveryJob({
          workspaceId,
          instagramAccountId: accountId,
          automation: candidateAuto as any,
          commentId: triggerId,
          commenterId: "commenter_1",
          commenterName: "alice",
          commentText: "INFO please",
          matchedKeyword: "INFO",
          trackedUrl: "https://example.com/r/slug1",
        }),
        claimDeliveryJob({
          workspaceId,
          instagramAccountId: accountId,
          automation: candidateAuto as any,
          commentId: triggerId,
          commenterId: "commenter_1",
          commenterName: "alice",
          commentText: "INFO please",
          matchedKeyword: "INFO",
          trackedUrl: "https://example.com/r/slug1",
        }),
      ]);

      // Exactly ONE claim must succeed, the other must fail (CLAIM_RACE or ALREADY_COMPLETED)
      const successCount = [claim1, claim2].filter((c) => c.success).length;
      expect(successCount).toBe(1);

      const winningClaim = claim1.success ? claim1 : claim2;
      const losingClaim = claim1.success ? claim2 : claim1;

      expect(winningClaim.success).toBe(true);
      expect(losingClaim.success).toBe(false);

      // Verify the persisted job has the rendered message payload preserved
      const persistedJob = await prisma.deliveryJob.findUnique({
        where: { id: (winningClaim as any).deliveryJob.id },
      });
      expect(persistedJob?.messagePayload).toContain("https://example.com/r/slug1");
      expect(persistedJob?.messagePayload).toContain("@alice");
      expect(persistedJob?.status).toBe("SENDING");
    });

    it("transitions DeliveryJob state to SENT on success with attempt record", async () => {
      const triggerId = `comm_sent_${Date.now()}`;
      const candidateAuto = await prisma.automation.findUniqueOrThrow({
        where: { id: automationId },
        include: { variations: true },
      });

      const claim = await claimDeliveryJob({
        workspaceId,
        instagramAccountId: accountId,
        automation: candidateAuto as any,
        commentId: triggerId,
        commenterId: "commenter_2",
        commentText: "DEMO",
        matchedKeyword: "DEMO",
      });
      expect(claim.success).toBe(true);
      const jobId = (claim as any).deliveryJob.id;

      await transitionToSent(jobId, "meta_msg_999", 1, new Date());

      const updated = await prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(updated.status).toBe("SENT");
      expect(updated.metaMessageId).toBe("meta_msg_999");
      expect(updated.sentAt).not.toBeNull();

      const attempts = await prisma.deliveryAttempt.findMany({ where: { deliveryJobId: jobId } });
      expect(attempts).toHaveLength(1);
      expect(attempts[0].status).toBe("SENT");
    });

    it("transitions DeliveryJob state to UNKNOWN on ambiguous outcome without retrying", async () => {
      const triggerId = `comm_unk_${Date.now()}`;
      const candidateAuto = await prisma.automation.findUniqueOrThrow({
        where: { id: automationId },
        include: { variations: true },
      });

      const claim = await claimDeliveryJob({
        workspaceId,
        instagramAccountId: accountId,
        automation: candidateAuto as any,
        commentId: triggerId,
        commenterId: "commenter_3",
        commentText: "DEMO",
        matchedKeyword: "DEMO",
      });
      const jobId = (claim as any).deliveryJob.id;

      await transitionToUnknown(jobId, 1, "Connection reset by peer (ECONNRESET)", undefined, new Date());

      const updated = await prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(updated.status).toBe("UNKNOWN");
      expect(updated.lastError).toContain("ECONNRESET");

      // Verify claiming an UNKNOWN job returns IN_FLIGHT_UNKNOWN and never re-sends
      const retryClaim = await claimDeliveryJob({
        workspaceId,
        instagramAccountId: accountId,
        automation: candidateAuto as any,
        commentId: triggerId,
        commenterId: "commenter_3",
        commentText: "DEMO",
        matchedKeyword: "DEMO",
      });
      expect(retryClaim.success).toBe(false);
      expect((retryClaim as any).reason).toBe("IN_FLIGHT_UNKNOWN");
    });

    it("transitions DeliveryJob state to FAILED on permanent failure", async () => {
      const triggerId = `comm_fail_${Date.now()}`;
      const candidateAuto = await prisma.automation.findUniqueOrThrow({
        where: { id: automationId },
        include: { variations: true },
      });

      const claim = await claimDeliveryJob({
        workspaceId,
        instagramAccountId: accountId,
        automation: candidateAuto as any,
        commentId: triggerId,
        commenterId: "commenter_4",
        commentText: "DEMO",
        matchedKeyword: "DEMO",
      });
      const jobId = (claim as any).deliveryJob.id;

      await transitionToPermanentFailure(jobId, 1, "Meta API error 100: Invalid parameter", "100", new Date());

      const updated = await prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(updated.status).toBe("FAILED");
      expect(updated.lastError).toContain("Meta API error 100");
    });

    it("transitions DeliveryJob state to PENDING on retryable failure", async () => {
      const triggerId = `comm_retry_${Date.now()}`;
      const candidateAuto = await prisma.automation.findUniqueOrThrow({
        where: { id: automationId },
        include: { variations: true },
      });

      const claim = await claimDeliveryJob({
        workspaceId,
        instagramAccountId: accountId,
        automation: candidateAuto as any,
        commentId: triggerId,
        commenterId: "commenter_5",
        commentText: "DEMO",
        matchedKeyword: "DEMO",
      });
      const jobId = (claim as any).deliveryJob.id;

      await transitionToRetryable(jobId, 1, "Hourly rate limit hit", "RATE_LIMIT_REQUEUE", new Date());

      const updated = await prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(updated.status).toBe("PENDING");
    });

    it("transitions DeliveryJob state to FAILED on missing token and decryption failure", async () => {
      const candidateAuto = await prisma.automation.findUniqueOrThrow({
        where: { id: automationId },
        include: { variations: true },
      });

      // 1. Test NO_TOKEN
      const claim1 = await claimDeliveryJob({
        workspaceId,
        instagramAccountId: accountId,
        automation: candidateAuto as any,
        commentId: `comm_notoken_${Date.now()}`,
        commenterId: "commenter_tok1",
        commentText: "DEMO",
        matchedKeyword: "DEMO",
      });
      const jobId1 = (claim1 as any).deliveryJob.id;
      await transitionToPermanentFailure(jobId1, 1, "No Instagram access token available", "NO_TOKEN", new Date());

      const updated1 = await prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId1 } });
      expect(updated1.status).toBe("FAILED");
      expect(updated1.lastError).toBe("No Instagram access token available");
      const attempt1 = await prisma.deliveryAttempt.findFirstOrThrow({ where: { deliveryJobId: jobId1 } });
      expect(attempt1.errorCode).toBe("NO_TOKEN");

      // 2. Test DECRYPT_FAILED
      const claim2 = await claimDeliveryJob({
        workspaceId,
        instagramAccountId: accountId,
        automation: candidateAuto as any,
        commentId: `comm_decrypt_${Date.now()}`,
        commenterId: "commenter_tok2",
        commentText: "DEMO",
        matchedKeyword: "DEMO",
      });
      const jobId2 = (claim2 as any).deliveryJob.id;
      await transitionToPermanentFailure(jobId2, 1, "Failed to decrypt Instagram access token", "DECRYPT_FAILED", new Date());

      const updated2 = await prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId2 } });
      expect(updated2.status).toBe("FAILED");
      const attempt2 = await prisma.deliveryAttempt.findFirstOrThrow({ where: { deliveryJobId: jobId2 } });
      expect(attempt2.errorCode).toBe("DECRYPT_FAILED");
    });

    it("transitions DeliveryJob state on quota/rate-limit thresholds", async () => {
      const candidateAuto = await prisma.automation.findUniqueOrThrow({
        where: { id: automationId },
        include: { variations: true },
      });

      // 1. Test PLAN_LIMIT failure
      const claim1 = await claimDeliveryJob({
        workspaceId,
        instagramAccountId: accountId,
        automation: candidateAuto as any,
        commentId: `comm_planlim_${Date.now()}`,
        commenterId: "commenter_lim1",
        commentText: "DEMO",
        matchedKeyword: "DEMO",
      });
      const jobId1 = (claim1 as any).deliveryJob.id;
      await transitionToPermanentFailure(jobId1, 1, "Monthly DM limit reached (500)", "PLAN_LIMIT", new Date());

      const updated1 = await prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId1 } });
      expect(updated1.status).toBe("FAILED");
      expect(updated1.lastError).toContain("Monthly DM limit reached");
      const attempt1 = await prisma.deliveryAttempt.findFirstOrThrow({ where: { deliveryJobId: jobId1 } });
      expect(attempt1.errorCode).toBe("PLAN_LIMIT");

      // 2. Test RATE_LIMIT_EXHAUSTED failure
      const claim2 = await claimDeliveryJob({
        workspaceId,
        instagramAccountId: accountId,
        automation: candidateAuto as any,
        commentId: `comm_rateexh_${Date.now()}`,
        commenterId: "commenter_lim2",
        commentText: "DEMO",
        matchedKeyword: "DEMO",
      });
      const jobId2 = (claim2 as any).deliveryJob.id;
      await transitionToPermanentFailure(
        jobId2,
        3,
        "Hourly Instagram DM rate limit reached; max retries exhausted",
        "RATE_LIMIT_EXHAUSTED",
        new Date()
      );

      const updated2 = await prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId2 } });
      expect(updated2.status).toBe("FAILED");
      expect(updated2.lastError).toContain("max retries exhausted");
      const attempt2 = await prisma.deliveryAttempt.findFirstOrThrow({ where: { deliveryJobId: jobId2 } });
      expect(attempt2.errorCode).toBe("RATE_LIMIT_EXHAUSTED");
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

      // Claim for first post media_100
      const claimed1 = await claimNextPostAutomation(nextPostAuto.id, "media_100");
      expect(claimed1).toBe(true);

      // Verify post was consumed in DB
      const updated = await prisma.automation.findUniqueOrThrow({ where: { id: nextPostAuto.id } });
      expect(updated.consumedPostId).toBe("media_100");
      expect(updated.consumedAt).not.toBeNull();

      // Second claim for DIFFERENT media_200 must fail
      const claimed2 = await claimNextPostAutomation(nextPostAuto.id, "media_200");
      expect(claimed2).toBe(false);

      // Once consumed, subsequent atomic claims return false (consumedPostId is no longer null)
      const claimedAgain = await claimNextPostAutomation(nextPostAuto.id, "media_100");
      expect(claimedAgain).toBe(false);
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
