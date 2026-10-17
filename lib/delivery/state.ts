import { prisma } from "@/lib/db/client";
import { DmStatus } from "@/app/generated/prisma/client";

export interface RecordDeliveryAttemptInput {
  deliveryJobId: string;
  attemptNumber: number;
  status: DmStatus;
  metaMessageId?: string | null;
  errorCode?: string | null;
  errorType?: string | null;
  errorMessage?: string | null;
  startedAt?: Date;
  completedAt?: Date;
}

/**
 * Persists an individual delivery attempt for operational observability.
 */
export async function recordDeliveryAttempt(input: RecordDeliveryAttemptInput) {
  const {
    deliveryJobId,
    attemptNumber,
    status,
    metaMessageId,
    errorCode,
    errorType,
    errorMessage,
    startedAt,
    completedAt,
  } = input;

  return prisma.deliveryAttempt.create({
    data: {
      deliveryJobId,
      attemptNumber,
      status,
      metaMessageId: metaMessageId || null,
      errorCode: errorCode || null,
      errorType: errorType || null,
      errorMessage: errorMessage || null,
      startedAt: startedAt || new Date(),
      completedAt: completedAt || new Date(),
    },
  });
}

/**
 * Transitions a delivery job to SENT.
 */
export async function transitionToSent(
  jobId: string,
  metaMessageId: string,
  attemptNumber: number,
  attemptStartedAt: Date
) {
  const now = new Date();

  await Promise.all([
    prisma.deliveryJob.update({
      where: { id: jobId },
      data: {
        status: "SENT",
        sentAt: now,
        metaMessageId,
        attemptCount: attemptNumber,
      },
    }),
    recordDeliveryAttempt({
      deliveryJobId: jobId,
      attemptNumber,
      status: "SENT",
      metaMessageId,
      startedAt: attemptStartedAt,
      completedAt: now,
    }),
  ]);
}

/**
 * Transitions a delivery job to PERMANENT FAILURE.
 */
export async function transitionToPermanentFailure(
  jobId: string,
  attemptNumber: number,
  errorMessage: string,
  errorCode?: string,
  attemptStartedAt?: Date
) {
  const now = new Date();

  await Promise.all([
    prisma.deliveryJob.update({
      where: { id: jobId },
      data: {
        status: "FAILED",
        lastError: errorMessage,
        attemptCount: attemptNumber,
      },
    }),
    recordDeliveryAttempt({
      deliveryJobId: jobId,
      attemptNumber,
      status: "FAILED",
      errorMessage,
      errorCode,
      errorType: "PERMANENT",
      startedAt: attemptStartedAt,
      completedAt: now,
    }),
  ]);
}

/**
 * Transitions a delivery job to UNKNOWN (ambiguous network or timeout outcome).
 * Critical: Never automatically retried.
 */
export async function transitionToUnknown(
  jobId: string,
  attemptNumber: number,
  errorMessage: string,
  errorCode?: string,
  attemptStartedAt?: Date
) {
  const now = new Date();

  await Promise.all([
    prisma.deliveryJob.update({
      where: { id: jobId },
      data: {
        status: "UNKNOWN",
        lastError: errorMessage,
        attemptCount: attemptNumber,
      },
    }),
    recordDeliveryAttempt({
      deliveryJobId: jobId,
      attemptNumber,
      status: "UNKNOWN",
      errorMessage,
      errorCode,
      errorType: "AMBIGUOUS_TIMEOUT",
      startedAt: attemptStartedAt,
      completedAt: now,
    }),
  ]);
}

/**
 * Transitions a delivery job to RETRYABLE (re-enqueued for later attempt).
 */
export async function transitionToRetryable(
  jobId: string,
  attemptNumber: number,
  errorMessage: string,
  errorCode?: string,
  attemptStartedAt?: Date
) {
  const now = new Date();

  await Promise.all([
    prisma.deliveryJob.update({
      where: { id: jobId },
      data: {
        status: "PENDING",
        lastError: errorMessage,
        attemptCount: attemptNumber,
      },
    }),
    recordDeliveryAttempt({
      deliveryJobId: jobId,
      attemptNumber,
      status: "FAILED",
      errorMessage,
      errorCode,
      errorType: "RETRYABLE",
      startedAt: attemptStartedAt,
      completedAt: now,
    }),
  ]);
}
