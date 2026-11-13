import { prisma } from "@/lib/db/client";
import type { DmStatus } from "@/app/generated/prisma/client";

/**
 * DeliveryJob state machine (DeliveryJob is the canonical delivery record).
 *
 *   PENDING --claim--> SENDING --> SENT
 *      ^                  |------> UNKNOWN   (ambiguous outcome, never retried)
 *      |                  |------> FAILED    (definite permanent failure)
 *      +---- reschedule --+                  (definite rejection: rate limit / transient)
 *   PENDING --> EXPIRED | FAILED | SKIPPED_PLAN_LIMIT  (closed before any send)
 *   (created as) SKIPPED_DEDUP                         (duplicate recipient)
 *
 * Every transition is a conditional update on the current status, so a stale
 * or concurrent writer can never overwrite a newer state. `dedupKey` is
 * released whenever a job ends WITHOUT a DM having (possibly) been sent, so the
 * recipient can be reached by a later comment.
 */

export const ACTIVE_DEDUP_STATUSES: DmStatus[] = ["PENDING", "SENDING", "SENT", "UNKNOWN"];

export class DeliveryStateConflictError extends Error {
  constructor(jobId: string, expected: DmStatus, target: DmStatus) {
    super(`DeliveryJob ${jobId} was not in ${expected}; refusing transition to ${target}`);
    this.name = "DeliveryStateConflictError";
  }
}

export type AttemptErrorType = "RATE_LIMITED" | "RETRYABLE" | "PERMANENT" | "AMBIGUOUS";

interface AttemptRecord {
  attemptNumber: number;
  startedAt: Date;
  errorMessage?: string | null;
  errorCode?: string | null;
}

/**
 * PENDING -> SENDING. Returns the claimed job, or null if another worker
 * claimed it first or it is no longer PENDING. Increments attemptCount, which
 * becomes the attempt number for this send.
 */
export async function claimForSending(jobId: string) {
  const claimed = await prisma.deliveryJob.updateMany({
    where: { id: jobId, status: "PENDING" },
    data: {
      status: "SENDING",
      processingStartedAt: new Date(),
      attemptCount: { increment: 1 },
    },
  });
  if (claimed.count === 0) return null;
  return prisma.deliveryJob.findUnique({ where: { id: jobId } });
}

async function transitionFromSending(
  jobId: string,
  target: DmStatus,
  data: Record<string, unknown>,
  attempt: AttemptRecord & { status: DmStatus; errorType?: AttemptErrorType; metaMessageId?: string | null }
) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const updated = await tx.deliveryJob.updateMany({
      where: { id: jobId, status: "SENDING" },
      data: { ...data, status: target },
    });
    if (updated.count === 0) {
      throw new DeliveryStateConflictError(jobId, "SENDING", target);
    }
    await tx.deliveryAttempt.create({
      data: {
        deliveryJobId: jobId,
        attemptNumber: attempt.attemptNumber,
        status: attempt.status,
        metaMessageId: attempt.metaMessageId ?? null,
        errorCode: attempt.errorCode ?? null,
        errorType: attempt.errorType ?? null,
        errorMessage: attempt.errorMessage ?? null,
        startedAt: attempt.startedAt,
        completedAt: now,
      },
    });
  });
}

/** SENDING -> SENT. */
export async function markSent(
  jobId: string,
  metaMessageId: string | null,
  attempt: AttemptRecord
) {
  await transitionFromSending(
    jobId,
    "SENT",
    { sentAt: new Date(), metaMessageId, lastError: null, errorCode: null },
    { ...attempt, status: "SENT", metaMessageId }
  );
}

/** SENDING -> UNKNOWN. Keeps the dedupKey: the DM may have been delivered. */
export async function markUnknown(jobId: string, attempt: AttemptRecord) {
  await transitionFromSending(
    jobId,
    "UNKNOWN",
    { lastError: attempt.errorMessage ?? null, errorCode: attempt.errorCode ?? null },
    { ...attempt, status: "UNKNOWN", errorType: "AMBIGUOUS" }
  );
}

/** SENDING -> FAILED (definite, permanent rejection). */
export async function markFailedAfterSend(jobId: string, attempt: AttemptRecord) {
  await transitionFromSending(
    jobId,
    "FAILED",
    {
      lastError: attempt.errorMessage ?? null,
      errorCode: attempt.errorCode ?? null,
      dedupKey: null,
    },
    { ...attempt, status: "FAILED", errorType: "PERMANENT" }
  );
}

/**
 * SENDING -> PENDING after a DEFINITE rejection (Meta rate limit, transient
 * Meta error, or a connection that never reached Meta).
 */
export async function rescheduleAfterAttempt(
  jobId: string,
  scheduledAt: Date,
  attempt: AttemptRecord & { rateLimited: boolean }
) {
  await transitionFromSending(
    jobId,
    "PENDING",
    {
      scheduledAt,
      processingStartedAt: null,
      lastError: attempt.errorMessage ?? null,
      errorCode: attempt.errorCode ?? null,
      ...(attempt.rateLimited ? { rateLimitDeferrals: { increment: 1 } } : {}),
    },
    {
      ...attempt,
      status: "FAILED",
      errorType: attempt.rateLimited ? "RATE_LIMITED" : "RETRYABLE",
    }
  );
}

/**
 * PENDING -> PENDING with a later scheduledAt, before any send was attempted
 * (our own throughput limit). Returns false if the job is no longer PENDING.
 */
export async function deferPending(jobId: string, scheduledAt: Date, reason: string) {
  const result = await prisma.deliveryJob.updateMany({
    where: { id: jobId, status: "PENDING" },
    data: {
      scheduledAt,
      lastError: reason,
      errorCode: "RATE_LIMIT_DEFERRED",
      rateLimitDeferrals: { increment: 1 },
    },
  });
  return result.count > 0;
}

/** Closes a PENDING job without sending (EXPIRED, FAILED, SKIPPED_PLAN_LIMIT). */
export async function closePending(
  jobId: string,
  status: Extract<DmStatus, "EXPIRED" | "FAILED" | "SKIPPED_PLAN_LIMIT">,
  reason: string,
  errorCode: string
) {
  const result = await prisma.deliveryJob.updateMany({
    where: { id: jobId, status: "PENDING" },
    data: { status, lastError: reason, errorCode, dedupKey: null },
  });
  return result.count > 0;
}
