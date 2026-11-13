/**
 * BullMQ Queue Client
 *
 * BullMQ is the execution queue only. PostgreSQL is the source of truth:
 * every comment is persisted as an InboundComment before it is enqueued, and
 * every delivery is a DeliveryJob row. Anything lost from Redis is recovered
 * by the scheduler (lib/delivery/scheduler.ts).
 */

import { Queue } from "bullmq";
import Redis from "ioredis";

let connection: Redis | null = null;

export function getRedisConnection(): Redis {
  if (!connection) {
    connection = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null, // Required by BullMQ
    });
  }
  return connection;
}

// ─── DM Queue ───────────────────────────────────────────────────────────────────

export const PROCESS_COMMENT_JOB = "process-comment";
export const DELIVER_JOB = "deliver";

/** Intake: resolve the winning campaign for a comment and create its DeliveryJob. */
export interface ProcessCommentJob {
  instagramAccountId: string;
  commentId: string;
  commentText: string;
  commenterId: string;
  commenterName?: string;
  mediaId: string;
  /** ISO comment time; absent on jobs enqueued before this field existed. */
  commentedAt?: string;
  /** @deprecated Legacy rate-limit requeue counter; ignored. */
  requeueAttempt?: number;
}

/** Delivery: attempt to send one persisted DeliveryJob. */
export interface DeliverJob {
  deliveryJobId: string;
}

export type DMQueueJobData = ProcessCommentJob | DeliverJob;

export function isDeliverJob(data: DMQueueJobData): data is DeliverJob {
  return typeof (data as DeliverJob).deliveryJobId === "string";
}

/** Deterministic BullMQ job IDs (no colons: BullMQ reserves them). */
export function processCommentJobId(instagramAccountId: string, commentId: string) {
  return `comment-${instagramAccountId}-${commentId}`;
}

let dmQueue: Queue<DMQueueJobData> | null = null;

export function getDMQueue(): Queue<DMQueueJobData> {
  if (!dmQueue) {
    dmQueue = new Queue<DMQueueJobData>("dm-queue", {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 1000 }, // Keep last 1000 completed jobs
        removeOnFail: { count: 5000 }, // Keep last 5000 failed jobs
        // Bounded per-attempt retries for infrastructure errors (DB/Redis
        // unavailable before any send). Delivery retries and rate-limit
        // deferrals are rescheduled durably in PostgreSQL, not here.
        attempts: 3,
        backoff: {
          type: "exponentialish",
        },
      },
    });
  }
  return dmQueue;
}
