import { prisma } from "@/lib/db/client";
import { DELIVERY_CONFIG, computeDeliveryDeadline } from "@/lib/config/delivery";
import {
  DELIVER_JOB,
  PROCESS_COMMENT_JOB,
  getDMQueue,
  processCommentJobId,
  type DMQueueJobData,
} from "@/lib/queue/client";
import { logEvent, describeError } from "@/lib/ops/logger";

/**
 * Durable delivery scheduler.
 *
 * PostgreSQL holds all pending work; BullMQ only executes it. Each pass:
 *  1. Expires PENDING jobs whose private-reply deadline has passed (EXPIRED).
 *  2. Moves jobs stuck in SENDING (crash mid-send) to UNKNOWN; never re-sends.
 *  3. Enqueues due PENDING jobs, earliest deadline first, with deterministic
 *     job IDs so overlapping passes and multiple workers never duplicate work.
 *  4. Re-enqueues InboundComments that were persisted but never processed
 *     (queue job lost to a Redis restart or worker crash).
 *
 * Correctness never depends on this pass being single-instance: enqueueing is
 * idempotent and every state change is a conditional update.
 */

const MAX_INBOUND_RECOVERY_ATTEMPTS = 10;
const MAX_PRIORITY = 2_000_000; // BullMQ priority range is 1..2^21

type QueueLike = {
  add: (name: string, data: DMQueueJobData, opts?: Record<string, unknown>) => Promise<unknown>;
};

export interface SchedulableJob {
  id: string;
  scheduledAt: Date;
  deadlineAt: Date | null;
}

/**
 * Earlier deadline => higher priority (lower number). Bucketed by minute of
 * remaining eligibility. Priority is recomputed at every (re)enqueue, so a
 * newer job's priority rises as its own deadline approaches: no starvation.
 */
export function computeDeliveryPriority(deadlineAt: Date | null, now: Date = new Date()): number {
  if (!deadlineAt) return MAX_PRIORITY;
  const minutesLeft = Math.floor((deadlineAt.getTime() - now.getTime()) / 60_000);
  return Math.min(MAX_PRIORITY, Math.max(1, minutesLeft + 1));
}

export function deliverJobId(job: SchedulableJob): string {
  return `deliver-${job.id}-${job.scheduledAt.getTime()}`;
}

/** Enqueues a delivery attempt for a PENDING DeliveryJob (idempotent). */
export async function enqueueDelivery(
  job: SchedulableJob,
  queue: QueueLike = getDMQueue(),
  now: Date = new Date()
) {
  await queue.add(
    DELIVER_JOB,
    { deliveryJobId: job.id },
    {
      jobId: deliverJobId(job),
      delay: Math.max(0, job.scheduledAt.getTime() - now.getTime()),
      priority: computeDeliveryPriority(job.deadlineAt, now),
    }
  );
}

export interface SchedulerPassResult {
  expired: number;
  staleSendingToUnknown: number;
  enqueued: number;
  inboundRecovered: number;
  inboundAbandoned: number;
}

export async function runSchedulerPass(
  options: { now?: Date; queue?: QueueLike } = {}
): Promise<SchedulerPassResult> {
  const now = options.now ?? new Date();
  const queue = options.queue ?? getDMQueue();

  const expired = await prisma.deliveryJob.updateMany({
    where: { status: "PENDING", deadlineAt: { lte: now } },
    data: {
      status: "EXPIRED",
      dedupKey: null,
      errorCode: "DEADLINE_PASSED",
      lastError: "Private-reply eligibility window closed before the DM could be sent",
    },
  });

  const staleCutoff = new Date(now.getTime() - DELIVERY_CONFIG.staleSendingMs);
  const stale = await prisma.deliveryJob.updateMany({
    where: { status: "SENDING", processingStartedAt: { lt: staleCutoff } },
    data: {
      status: "UNKNOWN",
      errorCode: "INTERRUPTED_WHILE_SENDING",
      lastError:
        "Worker stopped while the Meta request was in flight; delivery outcome unknown. Not retried automatically.",
    },
  });
  if (stale.count > 0) {
    logEvent("warn", "delivery.stale_sending_marked_unknown", { count: stale.count });
  }

  const lookahead = new Date(now.getTime() + DELIVERY_CONFIG.schedulerIntervalMs);
  const due = await prisma.deliveryJob.findMany({
    where: { status: "PENDING", scheduledAt: { lte: lookahead } },
    orderBy: [{ deadlineAt: "asc" }, { scheduledAt: "asc" }, { id: "asc" }],
    take: DELIVERY_CONFIG.schedulerBatchSize,
    select: { id: true, scheduledAt: true, deadlineAt: true },
  });

  let enqueued = 0;
  for (const job of due) {
    await enqueueDelivery(job, queue, now);
    enqueued++;
  }

  const { recovered, abandoned } = await recoverInboundComments(now, queue);

  return {
    expired: expired.count,
    staleSendingToUnknown: stale.count,
    enqueued,
    inboundRecovered: recovered,
    inboundAbandoned: abandoned,
  };
}

async function recoverInboundComments(now: Date, queue: QueueLike) {
  const cutoff = new Date(now.getTime() - DELIVERY_CONFIG.inboundRecoveryAgeMs);
  const stuck = await prisma.inboundComment.findMany({
    where: { status: "RECEIVED", receivedAt: { lt: cutoff } },
    orderBy: { receivedAt: "asc" },
    take: DELIVERY_CONFIG.schedulerBatchSize,
  });

  let recovered = 0;
  let abandoned = 0;

  for (const comment of stuck) {
    const deadline = computeDeliveryDeadline(comment.commentedAt);
    const exhausted = comment.attempts >= MAX_INBOUND_RECOVERY_ATTEMPTS;

    if (exhausted || deadline.getTime() <= now.getTime()) {
      const closed = await prisma.inboundComment.updateMany({
        where: { id: comment.id, status: "RECEIVED" },
        data: {
          status: "IGNORED",
          outcome: exhausted ? "RECOVERY_EXHAUSTED" : "EXPIRED_BEFORE_PROCESSING",
          processedAt: now,
        },
      });
      if (closed.count > 0) {
        abandoned++;
        logEvent("error", "intake.comment_abandoned", {
          inboundCommentId: comment.id,
          commentId: comment.commentId,
          reason: exhausted ? "RECOVERY_EXHAUSTED" : "EXPIRED_BEFORE_PROCESSING",
        });
      }
      continue;
    }

    const bumped = await prisma.inboundComment.updateMany({
      where: { id: comment.id, status: "RECEIVED", attempts: comment.attempts },
      data: { attempts: { increment: 1 } },
    });
    if (bumped.count === 0) continue; // another scheduler pass took it

    await queue.add(
      PROCESS_COMMENT_JOB,
      {
        instagramAccountId: comment.instagramAccountId,
        commentId: comment.commentId,
        commentText: comment.commentText,
        commenterId: comment.commenterId,
        commenterName: comment.commenterUsername ?? undefined,
        mediaId: comment.mediaId,
        commentedAt: comment.commentedAt.toISOString(),
      },
      {
        jobId: `${processCommentJobId(comment.instagramAccountId, comment.commentId)}-r${comment.attempts + 1}`,
      }
    );
    recovered++;
  }

  return { recovered, abandoned };
}

/**
 * Starts the periodic scheduler in a long-running worker process. Runs once
 * immediately (recovering anything lost while the worker or Redis was down)
 * and then on an interval; passes never overlap within one process.
 */
export function startDeliveryScheduler(intervalMs = DELIVERY_CONFIG.schedulerIntervalMs) {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runSchedulerPass();
      if (Object.values(result).some((n) => n > 0)) {
        logEvent("info", "scheduler.pass", { ...result });
      }
    } catch (error) {
      logEvent("error", "scheduler.pass_failed", { error: describeError(error) });
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(timer);
}

export interface DeliveryBacklog {
  pendingDue: number;
  pendingDeferred: number;
  sending: number;
  unknown: number;
  expiredLast7Days: number;
  oldestPendingDeadline: Date | null;
  rateLimitDeferrals: number;
}

/** Workspace-scoped backlog summary for administrators. */
export async function getDeliveryBacklog(workspaceId: string, now: Date = new Date()): Promise<DeliveryBacklog> {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [pendingDue, pendingDeferred, sending, unknown, expiredLast7Days, oldest, deferrals] =
    await Promise.all([
      prisma.deliveryJob.count({ where: { workspaceId, status: "PENDING", scheduledAt: { lte: now } } }),
      prisma.deliveryJob.count({ where: { workspaceId, status: "PENDING", scheduledAt: { gt: now } } }),
      prisma.deliveryJob.count({ where: { workspaceId, status: "SENDING" } }),
      prisma.deliveryJob.count({ where: { workspaceId, status: "UNKNOWN" } }),
      prisma.deliveryJob.count({ where: { workspaceId, status: "EXPIRED", updatedAt: { gte: weekAgo } } }),
      prisma.deliveryJob.findFirst({
        where: { workspaceId, status: "PENDING" },
        orderBy: { deadlineAt: "asc" },
        select: { deadlineAt: true },
      }),
      prisma.deliveryJob.aggregate({
        where: { workspaceId, status: "PENDING" },
        _sum: { rateLimitDeferrals: true },
      }),
    ]);

  return {
    pendingDue,
    pendingDeferred,
    sending,
    unknown,
    expiredLast7Days,
    oldestPendingDeadline: oldest?.deadlineAt ?? null,
    rateLimitDeferrals: deferrals._sum.rateLimitDeferrals ?? 0,
  };
}
