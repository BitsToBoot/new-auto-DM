import { Worker, type Job } from "bullmq";
import {
  getRedisConnection,
  isDeliverJob,
  type DMQueueJobData,
  type ProcessCommentJob,
} from "./client";
import { prisma } from "@/lib/db/client";
import {
  MetaApiError,
  MetaNetworkError,
  PERMANENT_META_ERROR_CODES,
  RateLimitError,
  getMediaPublishedAt,
  replyToComment,
  sendPrivateReply,
} from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { releaseDMSlot, reserveDMSlot } from "@/lib/utils/rate-limiter";
import {
  releaseWorkspaceDMReservation,
  reserveWorkspaceDMSend,
} from "@/lib/billing/usage";
import { recordWorkerAlert } from "@/lib/ops/worker-health";
import { logEvent, describeError } from "@/lib/ops/logger";
import { resolveAutomationForComment } from "@/lib/automation/resolver";
import { upsertContact, recordContactEvent } from "@/lib/crm/contacts";
import { createDeliveryJobForComment } from "@/lib/delivery/intake";
import {
  assertWithinMetaLimit,
  findPlaceholders,
  MessageRenderError,
} from "@/lib/delivery/renderer";
import {
  claimForSending,
  closePending,
  deferPending,
  markFailedAfterSend,
  markSent,
  markUnknown,
  rescheduleAfterAttempt,
} from "@/lib/delivery/state";
import { enqueueDelivery } from "@/lib/delivery/scheduler";
import { DELIVERY_CONFIG, computeBackoffMs } from "@/lib/config/delivery";

/**
 * DM worker.
 *
 * Intake (`process-comment`): durable per-comment idempotency (InboundComment),
 * account lifecycle and creator self-comment checks, canonical campaign
 * resolution, then creation of the canonical DeliveryJob. No Meta send happens
 * unless that DeliveryJob row exists.
 *
 * Delivery (`deliver`): loads a PENDING DeliveryJob, enforces deadline,
 * account, campaign, message and token checks, reserves throughput and plan
 * usage, atomically claims PENDING -> SENDING, sends through the Meta adapter
 * and persists the result. Failures fail closed:
 *  - Definite rejection (Meta rate limit / transient error / no connection):
 *    rescheduled durably in PostgreSQL with backoff, bounded by the deadline.
 *  - Ambiguous outcome (timeout, reset, unreadable response): UNKNOWN, never
 *    retried automatically.
 *  - Crash after the send but before persistence: the job stays SENDING and the
 *    scheduler moves it to UNKNOWN; it is never re-sent.
 */

// Backoff for BullMQ-level retries of infrastructure errors (DB/Redis
// unavailable before any send). Delivery retries are rescheduled in PostgreSQL.
const BACKOFF_DELAYS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000];

const PERSIST_AFTER_SEND_RETRIES = 3;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const mediaPublishedAtCache = new Map<string, Date>();
const MEDIA_CACHE_LIMIT = 5000;

async function getCachedMediaPublishedAt(accessToken: string, mediaId: string): Promise<Date | null> {
  const cached = mediaPublishedAtCache.get(mediaId);
  if (cached) return cached;

  try {
    const publishedAt = await getMediaPublishedAt(accessToken, mediaId);
    if (mediaPublishedAtCache.size >= MEDIA_CACHE_LIMIT) {
      const oldest = mediaPublishedAtCache.keys().next().value;
      if (oldest !== undefined) mediaPublishedAtCache.delete(oldest);
    }
    mediaPublishedAtCache.set(mediaId, publishedAt);
    return publishedAt;
  } catch (error) {
    // A permanent Meta error means the publish time is unknowable: NEXT_POST
    // is simply ineligible. Anything else is transient: throw so the comment
    // is retried rather than resolved to a different winner.
    if (error instanceof MetaApiError && PERMANENT_META_ERROR_CODES.has(error.code)) {
      logEvent("warn", "intake.media_timestamp_unavailable", {
        mediaId,
        metaCode: error.code,
      });
      return null;
    }
    throw error;
  }
}

/** Test hook. */
export function clearMediaPublishedAtCache() {
  mediaPublishedAtCache.clear();
}

function formatError(error: unknown): string {
  if (error instanceof MetaApiError) return `Meta API ${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

/** Releases a reservation; a failure here must not mask the primary outcome. */
async function releaseSafely(label: string, ids: Record<string, unknown>, release: () => Promise<unknown>) {
  try {
    await release();
  } catch (error) {
    logEvent("error", "delivery.reservation_release_failed", {
      reservation: label,
      ...ids,
      error: describeError(error),
    });
  }
}

/** Non-critical bookkeeping after the canonical state is already durable. */
async function bestEffort(label: string, ids: Record<string, unknown>, action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    logEvent("warn", `delivery.${label}_failed`, { ...ids, error: describeError(error) });
  }
}

async function withPersistRetries<T>(action: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PERSIST_AFTER_SEND_RETRIES; attempt++) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }
  throw lastError;
}

function jitterMs(maxMs: number) {
  return Math.floor(Math.random() * maxMs);
}

// ─── Intake ──────────────────────────────────────────────────────────────────

export type IntakeOutcome =
  | "ALREADY_PROCESSED"
  | "UNKNOWN_ACCOUNT"
  | "ACCOUNT_NOT_CONNECTED"
  | "MISSING_COMMENTER_ID"
  | "SELF_COMMENT"
  | "NO_MATCHING_CAMPAIGN"
  | "CREATED"
  | "EXISTING"
  | "DEDUPLICATED"
  | "INVALID_MESSAGE"
  | "EXPIRED";

function isValidInstagramId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export async function processCommentJob(
  data: ProcessCommentJob,
  options: { deliverInline?: boolean } = {}
): Promise<IntakeOutcome> {
  const deliverInline = options.deliverInline ?? true;
  const commentedAt = data.commentedAt ? new Date(data.commentedAt) : new Date();
  const ids = { instagramAccountId: data.instagramAccountId, commentId: data.commentId };

  // Durable per-comment idempotency. The webhook normally creates this row;
  // jobs enqueued before the InboundComment table existed create it here.
  const inbound = await prisma.inboundComment.upsert({
    where: {
      instagramAccountId_commentId: {
        instagramAccountId: data.instagramAccountId,
        commentId: data.commentId,
      },
    },
    create: {
      instagramAccountId: data.instagramAccountId,
      commentId: data.commentId,
      mediaId: data.mediaId,
      commenterId: typeof data.commenterId === "string" ? data.commenterId : "",
      commenterUsername: data.commenterName ?? null,
      commentText: data.commentText ?? "",
      commentedAt: Number.isFinite(commentedAt.getTime()) ? commentedAt : new Date(),
    },
    update: {},
  });

  if (inbound.status !== "RECEIVED") return "ALREADY_PROCESSED";

  const finish = async (status: "PROCESSED" | "IGNORED", outcome: IntakeOutcome) => {
    await prisma.inboundComment.updateMany({
      where: { id: inbound.id, status: "RECEIVED" },
      data: { status, outcome, processedAt: new Date() },
    });
    if (status === "IGNORED") logEvent("info", "intake.comment_ignored", { ...ids, outcome });
    return outcome;
  };

  const account = await prisma.instagramAccount.findUnique({
    where: { instagramId: data.instagramAccountId },
  });
  if (!account) return finish("IGNORED", "UNKNOWN_ACCOUNT");
  if (account.status !== "CONNECTED") return finish("IGNORED", "ACCOUNT_NOT_CONNECTED");

  if (!isValidInstagramId(data.commenterId)) {
    return finish("IGNORED", "MISSING_COMMENTER_ID");
  }

  // Creator's own comment: compare stable Instagram user IDs, never usernames.
  // The webhook entry ID is the receiving account in the same ID space as
  // `from.id`; the stored account ID is checked as well.
  if (data.commenterId === data.instagramAccountId || data.commenterId === account.instagramId) {
    return finish("IGNORED", "SELF_COMMENT");
  }

  let decryptedToken: string | null | undefined;
  const resolved = await resolveAutomationForComment({
    instagramAccountId: account.id,
    mediaId: data.mediaId,
    commentText: data.commentText ?? "",
    getMediaPublishedAt: async () => {
      if (decryptedToken === undefined) {
        try {
          decryptedToken = account.accessToken ? decryptToken(account.accessToken) : null;
        } catch (error) {
          logEvent("error", "intake.token_decrypt_failed", { ...ids, error: describeError(error) });
          decryptedToken = null;
        }
      }
      return decryptedToken ? getCachedMediaPublishedAt(decryptedToken, data.mediaId) : null;
    },
  });

  if (!resolved) return finish("IGNORED", "NO_MATCHING_CAMPAIGN");

  const { automation, matchedKeyword } = resolved;
  const contact = await upsertContact({
    workspaceId: automation.workspaceId,
    instagramAccountId: account.id,
    instagramUserId: data.commenterId,
    username: data.commenterName,
    displayName: data.commenterName,
  });

  const result = await createDeliveryJobForComment({
    workspaceId: automation.workspaceId,
    instagramAccountId: account.id,
    automation,
    contactId: contact.id,
    commentId: data.commentId,
    commenterId: data.commenterId,
    commenterName: data.commenterName,
    commentText: data.commentText ?? "",
    mediaId: data.mediaId,
    matchedKeyword,
    commentedAt: inbound.commentedAt,
  });

  if (result.outcome !== "EXISTING") {
    await recordContactEvent({
      workspaceId: automation.workspaceId,
      contactId: contact.id,
      instagramAccountId: account.id,
      type: "AUTOMATION_TRIGGERED",
      referenceId: data.commentId,
      metadata: {
        mediaId: data.mediaId,
        matchedKeyword,
        deliveryJobId: result.job.id,
        outcome: result.outcome,
      },
    });
  }

  if (result.outcome === "DEDUPLICATED") {
    logEvent("info", "intake.recipient_deduplicated", {
      ...ids,
      deliveryJobId: result.job.id,
      existingDeliveryJobId: result.existingJobId,
    });
  } else if (result.outcome === "INVALID_MESSAGE" || result.outcome === "EXPIRED") {
    logEvent("warn", "intake.delivery_not_sendable", {
      ...ids,
      deliveryJobId: result.job.id,
      outcome: result.outcome,
      errorCode: result.job.errorCode,
    });
  }

  await finish("PROCESSED", result.outcome);

  if (deliverInline && result.job.status === "PENDING") {
    await deliverDeliveryJob(result.job.id);
  }

  return result.outcome;
}

// ─── Delivery ────────────────────────────────────────────────────────────────

export type DeliveryOutcome =
  | "NOT_FOUND"
  | "NOT_PENDING"
  | "NOT_DUE"
  | "EXPIRED"
  | "ACCOUNT_DISCONNECTED"
  | "CAMPAIGN_INACTIVE"
  | "INVALID_MESSAGE"
  | "NO_TOKEN"
  | "DECRYPT_FAILED"
  | "RATE_LIMIT_DEFERRED"
  | "PLAN_LIMIT"
  | "CLAIM_LOST"
  | "SENT"
  | "UNKNOWN"
  | "FAILED"
  | "RESCHEDULED";

async function enqueueOrLog(job: { id: string; scheduledAt: Date; deadlineAt: Date | null }) {
  try {
    await enqueueDelivery(job);
  } catch (error) {
    // The job is durably PENDING in PostgreSQL; the scheduler will enqueue it.
    logEvent("warn", "delivery.enqueue_failed_scheduler_will_recover", {
      deliveryJobId: job.id,
      error: describeError(error),
    });
  }
}

export async function deliverDeliveryJob(deliveryJobId: string): Promise<DeliveryOutcome> {
  const job = await prisma.deliveryJob.findUnique({
    where: { id: deliveryJobId },
    include: {
      instagramAccount: true,
      automation: { select: { id: true, isActive: true, publicReplyMessage: true } },
    },
  });

  if (!job) {
    logEvent("warn", "delivery.job_not_found", { deliveryJobId });
    return "NOT_FOUND";
  }
  if (job.status !== "PENDING") return "NOT_PENDING";

  const ids = {
    deliveryJobId: job.id,
    workspaceId: job.workspaceId,
    automationId: job.automationId,
    commentId: job.triggerId,
  };
  const now = new Date();

  if (job.scheduledAt.getTime() > now.getTime() + 1000) {
    await enqueueOrLog(job);
    return "NOT_DUE";
  }

  if (job.deadlineAt && job.deadlineAt.getTime() <= now.getTime()) {
    await closePending(
      job.id,
      "EXPIRED",
      "Private-reply eligibility window closed before the DM could be sent",
      "DEADLINE_PASSED"
    );
    return "EXPIRED";
  }

  const account = job.instagramAccount;
  if (account.status !== "CONNECTED") {
    await closePending(job.id, "FAILED", "Instagram account is disconnected", "ACCOUNT_DISCONNECTED");
    return "ACCOUNT_DISCONNECTED";
  }

  if (!job.automation.isActive) {
    await closePending(job.id, "FAILED", "Campaign was paused before the DM was sent", "CAMPAIGN_INACTIVE");
    return "CAMPAIGN_INACTIVE";
  }

  // Never send unresolved placeholders or over-limit text (also covers rows
  // rendered by older code before canonical rendering existed).
  try {
    if (!job.messagePayload.trim()) {
      throw new MessageRenderError("EMPTY_MESSAGE", "Delivery has no rendered message");
    }
    const leftover = findPlaceholders(job.messagePayload);
    if (leftover.length > 0) {
      throw new MessageRenderError(
        "UNSUPPORTED_PLACEHOLDER",
        `Rendered message still contains placeholder(s): ${leftover.map((p) => `{${p}}`).join(", ")}`
      );
    }
    assertWithinMetaLimit(job.messagePayload);
  } catch (error) {
    if (!(error instanceof MessageRenderError)) throw error;
    await closePending(job.id, "FAILED", error.message, error.code);
    return "INVALID_MESSAGE";
  }

  if (!account.accessToken) {
    await closePending(job.id, "FAILED", "No Instagram access token available", "NO_TOKEN");
    return "NO_TOKEN";
  }

  let accessToken: string;
  try {
    accessToken = decryptToken(account.accessToken);
  } catch {
    await closePending(job.id, "FAILED", "Failed to decrypt Instagram access token", "DECRYPT_FAILED");
    return "DECRYPT_FAILED";
  }

  // Our own throughput limit. Blocked => defer durably until the window resets.
  const slot = await reserveDMSlot(account.instagramId);
  if (!slot.allowed) {
    const scheduledAt = new Date(now.getTime() + slot.requeueDelayMs + jitterMs(30_000));
    if (await deferPending(job.id, scheduledAt, "Hourly DM throughput limit reached; deferred until the window resets")) {
      await enqueueOrLog({ id: job.id, scheduledAt, deadlineAt: job.deadlineAt });
    }
    return "RATE_LIMIT_DEFERRED";
  }

  const releaseSlot = () =>
    releaseSafely("rate_slot", ids, () => releaseDMSlot(account.instagramId));

  let usage: Awaited<ReturnType<typeof reserveWorkspaceDMSend>>;
  try {
    usage = await reserveWorkspaceDMSend(job.workspaceId);
  } catch (error) {
    await releaseSlot();
    throw error;
  }
  const releaseUsage = () =>
    releaseSafely("monthly_usage", ids, () =>
      releaseWorkspaceDMReservation(job.workspaceId, usage.periodStart)
    );

  if (!usage.allowed) {
    await releaseSlot();
    await closePending(job.id, "SKIPPED_PLAN_LIMIT", `Monthly DM limit reached (${usage.limit})`, "PLAN_LIMIT");
    return "PLAN_LIMIT";
  }

  // Fail closed: no durable SENDING state => no send.
  let claimed: Awaited<ReturnType<typeof claimForSending>>;
  try {
    claimed = await claimForSending(job.id);
  } catch (error) {
    await releaseUsage();
    await releaseSlot();
    throw error;
  }
  if (!claimed) {
    await releaseUsage();
    await releaseSlot();
    return "CLAIM_LOST";
  }

  const attempt = { attemptNumber: claimed.attemptCount, startedAt: new Date() };

  let metaMessageId: string | null;
  try {
    const response = await sendPrivateReply(
      accessToken,
      account.instagramId,
      job.triggerId,
      job.messagePayload
    );
    metaMessageId = response?.message_id ?? null;
  } catch (error) {
    return handleSendFailure(error, {
      job: { ...job, attemptCount: claimed.attemptCount },
      attempt,
      ids,
      releaseUsage,
      releaseSlot,
      accountInstagramId: account.instagramId,
      accountUsername: account.username,
    });
  }

  // The DM was accepted by Meta. Persist SENT; if that keeps failing the job
  // stays SENDING and is later marked UNKNOWN: it is never re-sent.
  try {
    await withPersistRetries(() => markSent(job.id, metaMessageId, attempt));
  } catch (error) {
    logEvent("error", "delivery.sent_but_not_persisted", { ...ids, error: describeError(error) });
    await bestEffort("worker_alert", ids, () =>
      recordWorkerAlert({
        level: "error",
        message: `DM ${job.id} was accepted by Meta but SENT could not be persisted; it will be marked UNKNOWN and not re-sent`,
        commentId: job.triggerId,
      })
    );
    throw error;
  }

  if (job.contactId) {
    await bestEffort("contact_event", ids, () =>
      recordContactEvent({
        workspaceId: job.workspaceId,
        contactId: job.contactId!,
        instagramAccountId: job.instagramAccountId,
        type: "DM_SENT",
        referenceId: job.triggerId,
        metadata: { deliveryJobId: job.id },
      })
    );
  }

  if (job.automation.publicReplyMessage) {
    try {
      await replyToComment(accessToken, job.triggerId, job.automation.publicReplyMessage);
      if (job.contactId) {
        await bestEffort("contact_event", ids, () =>
          recordContactEvent({
            workspaceId: job.workspaceId,
            contactId: job.contactId!,
            instagramAccountId: job.instagramAccountId,
            type: "PUBLIC_REPLY",
            referenceId: job.triggerId,
          })
        );
      }
    } catch (error) {
      logEvent("warn", "delivery.public_reply_failed", { ...ids, error: formatError(error) });
    }
  }

  return "SENT";
}

interface SendFailureContext {
  job: {
    id: string;
    workspaceId: string;
    instagramAccountId: string;
    attemptCount: number;
    rateLimitDeferrals: number;
    deadlineAt: Date | null;
  };
  attempt: { attemptNumber: number; startedAt: Date };
  ids: Record<string, unknown>;
  releaseUsage: () => Promise<void>;
  releaseSlot: () => Promise<void>;
  accountInstagramId: string;
  accountUsername: string;
}

async function handleSendFailure(error: unknown, ctx: SendFailureContext): Promise<DeliveryOutcome> {
  const { job, attempt, ids } = ctx;
  const message = formatError(error);

  // Ambiguous: Meta may have accepted the message. Keep usage, never retry.
  const ambiguous =
    (error instanceof MetaNetworkError && error.ambiguous) ||
    !(error instanceof MetaApiError || error instanceof MetaNetworkError);
  if (ambiguous) {
    logEvent("warn", "delivery.ambiguous_outcome", { ...ids, error: message });
    await withPersistRetries(() =>
      markUnknown(job.id, {
        ...attempt,
        errorMessage: `Ambiguous outcome: ${message}`,
        errorCode: error instanceof MetaNetworkError ? error.causeCode ?? "NETWORK" : "UNCLASSIFIED",
      })
    );
    return "UNKNOWN";
  }

  // Definite rejection from here on: the DM was not sent.
  await ctx.releaseUsage();

  if (error instanceof RateLimitError) {
    const delay =
      error.retryAfterMs !== undefined
        ? error.retryAfterMs + jitterMs(30_000)
        : computeBackoffMs(job.rateLimitDeferrals);
    const scheduledAt = new Date(Date.now() + delay);
    await withPersistRetries(() =>
      rescheduleAfterAttempt(job.id, scheduledAt, {
        ...attempt,
        rateLimited: true,
        errorMessage: message,
        errorCode: String(error.code),
      })
    );
    logEvent("warn", "delivery.meta_rate_limited", { ...ids, retryAt: scheduledAt, retryAfterMs: error.retryAfterMs });
    await enqueueOrLog({ id: job.id, scheduledAt, deadlineAt: job.deadlineAt });
    return "RESCHEDULED";
  }

  await ctx.releaseSlot();

  if (error instanceof MetaApiError && PERMANENT_META_ERROR_CODES.has(error.code)) {
    await withPersistRetries(() =>
      markFailedAfterSend(job.id, { ...attempt, errorMessage: message, errorCode: String(error.code) })
    );
    if (error.code === 190) await handleRevokedToken(ctx, error);
    return "FAILED";
  }

  // Transient Meta error, or the connection never reached Meta.
  const errorCode = error instanceof MetaApiError ? String(error.code) : (error as MetaNetworkError).causeCode ?? "NETWORK";
  // Only transient failures count toward the cap; Meta rate-limit rejections
  // are bounded by the eligibility deadline instead.
  const transientAttempts =
    (await prisma.deliveryAttempt.count({
      where: { deliveryJobId: job.id, errorType: "RETRYABLE" },
    })) + 1;
  if (transientAttempts >= DELIVERY_CONFIG.maxTransientAttempts) {
    await withPersistRetries(() =>
      markFailedAfterSend(job.id, {
        ...attempt,
        errorMessage: `${message} (gave up after ${transientAttempts} transient failures)`,
        errorCode,
      })
    );
    return "FAILED";
  }

  const scheduledAt = new Date(Date.now() + computeBackoffMs(transientAttempts));
  await withPersistRetries(() =>
    rescheduleAfterAttempt(job.id, scheduledAt, {
      ...attempt,
      rateLimited: false,
      errorMessage: message,
      errorCode,
    })
  );
  await enqueueOrLog({ id: job.id, scheduledAt, deadlineAt: job.deadlineAt });
  return "RESCHEDULED";
}

async function handleRevokedToken(ctx: SendFailureContext, error: MetaApiError) {
  await bestEffort("token_expiry_mark", ctx.ids, () =>
    prisma.instagramAccount.updateMany({
      where: { instagramId: ctx.accountInstagramId },
      data: { tokenExpiresAt: new Date(0) },
    })
  );
  await bestEffort("operational_event", ctx.ids, () =>
    prisma.operationalEvent.create({
      data: {
        workspaceId: ctx.job.workspaceId,
        source: "WORKER",
        level: "ERROR",
        message: `Instagram token expired or revoked for @${ctx.accountUsername}: ${error.message}`,
        payload: {
          instagramAccountId: ctx.job.instagramAccountId,
          errorCode: error.code,
        },
      },
    })
  );
}

// ─── Worker wiring ───────────────────────────────────────────────────────────

export async function processQueueJob(job: Job<DMQueueJobData>): Promise<void> {
  if (isDeliverJob(job.data)) {
    await deliverDeliveryJob(job.data.deliveryJobId);
    return;
  }
  await processCommentJob(job.data);
}

async function recordWorkerFailure(job: Job<DMQueueJobData> | undefined, error: Error) {
  const data = job?.data;
  const instagramAccountId = data && !isDeliverJob(data) ? data.instagramAccountId : null;
  const commentId = data && !isDeliverJob(data) ? data.commentId : null;
  const deliveryJobId = data && isDeliverJob(data) ? data.deliveryJobId : null;

  logEvent("error", "worker.job_failed", {
    jobId: job?.id ?? null,
    attemptsMade: job?.attemptsMade ?? null,
    instagramAccountId,
    commentId,
    deliveryJobId,
    error: describeError(error),
  });

  try {
    const account = instagramAccountId
      ? await prisma.instagramAccount.findUnique({
          where: { instagramId: instagramAccountId },
          select: { workspaceId: true },
        })
      : null;

    await prisma.operationalEvent.create({
      data: {
        workspaceId: account?.workspaceId ?? null,
        source: "WORKER",
        level: "ERROR",
        message: `DM worker job ${job?.id ?? "unknown"} failed: ${error.message}`,
        payload: {
          jobId: job?.id ?? null,
          attemptsMade: job?.attemptsMade ?? null,
          instagramAccountId,
          commentId,
          deliveryJobId,
        },
      },
    });

    await recordWorkerAlert({
      level: "error",
      message: error.message,
      jobId: job?.id,
      instagramAccountId: instagramAccountId ?? undefined,
      commentId: commentId ?? undefined,
    });
  } catch (logError) {
    logEvent("error", "worker.failure_record_failed", { error: describeError(logError) });
  }
}

let workerInstance: Worker<DMQueueJobData> | null = null;

export function getDMWorker(): Worker<DMQueueJobData> {
  if (workerInstance) return workerInstance;

  workerInstance = new Worker<DMQueueJobData>(
    "dm-queue",
    async (job: Job<DMQueueJobData>) => {
      await processQueueJob(job);
    },
    {
      connection: getRedisConnection(),
      concurrency: 5,
      limiter: { max: 10, duration: 1000 },
      settings: {
        backoffStrategies: {
          exponentialish: (attemptsMade: number) => {
            const index = Math.min(attemptsMade - 1, BACKOFF_DELAYS.length - 1);
            return BACKOFF_DELAYS[Math.max(0, index)];
          },
        },
      } as any,
    }
  );

  workerInstance.on("failed", (job, error) => {
    void recordWorkerFailure(job, error);
  });

  workerInstance.on("error", (error) => {
    logEvent("error", "worker.error", { error: describeError(error) });
  });

  return workerInstance;
}

export function createDMWorker(): Worker<DMQueueJobData> {
  workerInstance = null;
  return getDMWorker();
}
