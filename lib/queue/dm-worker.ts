import { Worker, type Job } from "bullmq";
import { getDMQueue, getRedisConnection, type ProcessCommentJob } from "./client";
import { prisma } from "@/lib/db/client";
import { MetaApiError, sendPrivateReply, replyToComment } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { matchKeywords } from "@/lib/utils/keyword-matcher";
import { releaseDMSlot, reserveDMSlot } from "@/lib/utils/rate-limiter";
import {
  releaseWorkspaceDMReservation,
  reserveWorkspaceDMSend,
} from "@/lib/billing/usage";
import { recordWorkerAlert } from "@/lib/ops/worker-health";
import { renderMessageWithTracking } from "@/lib/tracking/message";
import { claimNextPostAutomation } from "@/lib/automation/resolver";
import { upsertContact, recordContactEvent } from "@/lib/crm/contacts";
import { claimDeliveryJob } from "@/lib/delivery/claim";
import {
  transitionToSent,
  transitionToPermanentFailure,
  transitionToRetryable,
  transitionToUnknown,
} from "@/lib/delivery/state";

// Exponential backoff delays for BullMQ retries (ms).
const BACKOFF_DELAYS = [5 * 60 * 1000, 15 * 60 * 1000, 45 * 60 * 1000];

function logWhere(automationId: string, commentId: string) {
  return { automationId_commentId: { automationId, commentId } } as const;
}

function formatError(error: unknown): string {
  if (error instanceof MetaApiError) {
    return `Meta API ${error.code}: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

function isAmbiguousError(error: unknown): boolean {
  return !(error instanceof MetaApiError);
}

function isPermanentMetaError(error: MetaApiError): boolean {
  // 190 = invalid/expired token; 10 / 200 = permission error; 100 = param error
  return [190, 10, 200, 100].includes(error.code);
}

// ---------------------------------------------------------------------------

async function processComment(job: Job<ProcessCommentJob>): Promise<void> {
  const {
    instagramAccountId,
    commentId,
    commentText,
    commenterId,
    commenterName,
    mediaId,
  } = job.data;
  const requeueAttempt = job.data.requeueAttempt ?? 0;
  const attemptStartedAt = new Date();

  // 1. Primary lookup: SPECIFIC_POST matching this mediaId
  const automations = await prisma.automation.findMany({
    where: {
      postId: mediaId,
      isActive: true,
      instagramAccount: { instagramId: instagramAccountId },
    },
    include: {
      instagramAccount: true,
      workspace: true,
      trackedLinks: {
        select: {
          slug: true,
          destinationUrl: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  // 2. Fallback lookup: NEXT_POST or ANY_POST triggers
  if (automations.length === 0) {
    const broadAutomations = await prisma.automation.findMany({
      where: {
        isActive: true,
        instagramAccount: { instagramId: instagramAccountId },
        OR: [
          { triggerScope: "ANY_POST" },
          {
            triggerScope: "NEXT_POST",
            OR: [{ consumedPostId: null }, { consumedPostId: mediaId }],
          },
        ],
      },
      include: {
        instagramAccount: true,
        workspace: true,
        trackedLinks: {
          select: {
            slug: true,
            destinationUrl: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    automations.push(...broadAutomations);
  }

  if (automations.length === 0) return;

  // 3. RULE: one comment -> one winning automation.
  // Evaluate keywords and NEXT_POST consumption.
  let matchedAutomation: (typeof automations)[0] | null = null;
  let matchedKeywordStr: string | null = null;

  for (const auto of automations) {
    if (auto.triggerScope === "NEXT_POST" && !auto.consumedPostId) {
      const claimed = await claimNextPostAutomation(auto.id, mediaId).catch(() => true);
      if (!claimed) continue;
    }

    const { matched, matchedKeyword } = matchKeywords(
      commentText,
      auto.keywords,
      auto.wholeWordMatch
    );

    if (matched && matchedKeyword) {
      matchedAutomation = auto;
      matchedKeywordStr = matchedKeyword;
      break;
    }
  }

  if (!matchedAutomation || !matchedKeywordStr) return;

  const automation = matchedAutomation;
  const matchedKeyword = matchedKeywordStr;

  // 4. CRM Contact Upsert (non-blocking if mock environment)
  let contactId: string | null = null;
  try {
    const contact = await upsertContact({
      workspaceId: automation.workspaceId,
      instagramAccountId: automation.instagramAccountId,
      instagramUserId: commenterId,
      username: commenterName,
      displayName: commenterName,
    });
    contactId = contact.id;

    await recordContactEvent({
      workspaceId: automation.workspaceId,
      contactId: contact.id,
      instagramAccountId: automation.instagramAccountId,
      type: "AUTOMATION_TRIGGERED",
      referenceId: commentId,
      metadata: { mediaId, matchedKeyword },
    });
  } catch {
    // In mock testing environments where CRM tables may be absent, continue cleanly
  }

  // 5. DeliveryJob Claim & Variation Persistence
  let deliveryJobId: string | null = null;
  let persistedMessagePayload: string | null = null;
  try {
    const claimRes = await claimDeliveryJob({
      workspaceId: automation.workspaceId,
      instagramAccountId: automation.instagramAccountId,
      automation: automation as any,
      contactId,
      commentId,
      commenterId,
      commenterName,
      commentText,
      matchedKeyword,
    });
    if (claimRes.success) {
      deliveryJobId = claimRes.deliveryJob.id;
      persistedMessagePayload = claimRes.deliveryJob.messagePayload;
    } else if (claimRes.reason === "ALREADY_COMPLETED" || claimRes.reason === "IN_FLIGHT_UNKNOWN") {
      return;
    }
  } catch {
    // Falls through to DmLog state machine
  }

  // 6. DmLog Idempotency Check & Atomic Claim
  const existingLog = await prisma.dmLog.findUnique({
    where: logWhere(automation.id, commentId),
  });

  if (existingLog) {
    const { status } = existingLog;
    if (
      status === "SENT" ||
      status === "SKIPPED_DEDUP" ||
      status === "SKIPPED_PLAN_LIMIT" ||
      status === "SKIPPED_RATE_LIMIT" ||
      status === "SKIPPED_NO_MATCH" ||
      status === "UNKNOWN"
    ) {
      return;
    }

    if (status === "SENDING") {
      await prisma.dmLog.update({
        where: logWhere(automation.id, commentId),
        data: {
          status: "UNKNOWN",
          errorMessage:
            "Prior attempt reached Meta API but outcome was not confirmed. Manual review required.",
        },
      });
      return;
    }

    if (status === "FAILED") {
      const reset = await prisma.dmLog.updateMany({
        where: {
          automationId: automation.id,
          commentId,
          status: "FAILED",
        },
        data: {
          status: "PENDING",
          attempts: job.attemptsMade + 1,
          matchedKeyword,
          errorMessage: null,
        },
      });
      if (reset.count === 0) {
        return;
      }
    }
  } else {
    try {
      await prisma.dmLog.create({
        data: {
          workspaceId: automation.workspaceId,
          automationId: automation.id,
          instagramAccountId: automation.instagramAccountId,
          commenterId,
          commenterName,
          commentText,
          commentId,
          matchedKeyword,
          status: "PENDING",
          attempts: job.attemptsMade + 1,
          errorMessage: null,
        },
      });
    } catch (createErr: unknown) {
      const isUniqueViolation =
        (typeof createErr === "object" &&
          createErr !== null &&
          "code" in createErr &&
          (createErr as { code: string }).code === "P2002") ||
        (createErr instanceof Error &&
          createErr.message.includes("Unique constraint"));

      if (isUniqueViolation) {
        const recheck = await prisma.dmLog.findUnique({
          where: logWhere(automation.id, commentId),
        });
        if (!recheck || recheck.status !== "PENDING") {
          return;
        }
      } else {
        throw createErr;
      }
    }
  }

  // 7. Token guard
  if (!automation.instagramAccount.accessToken) {
    await prisma.dmLog.update({
      where: logWhere(automation.id, commentId),
      data: {
        status: "FAILED",
        errorMessage: "No Instagram access token available",
      },
    });
    return;
  }

  let accessToken: string;
  try {
    accessToken = decryptToken(automation.instagramAccount.accessToken);
  } catch {
    await prisma.dmLog.update({
      where: logWhere(automation.id, commentId),
      data: {
        status: "FAILED",
        errorMessage: "Failed to decrypt Instagram access token",
      },
    });
    return;
  }

  // 8. Monthly plan quota check
  const usage = await reserveWorkspaceDMSend(automation.workspaceId);
  if (!usage.allowed) {
    await prisma.dmLog.update({
      where: logWhere(automation.id, commentId),
      data: {
        status: "SKIPPED_PLAN_LIMIT",
        errorMessage: `Monthly DM limit reached (${usage.limit})`,
      },
    });
    return;
  }

  // 9. Hourly rate limit check
  let rateLimit;
  try {
    rateLimit = await reserveDMSlot(instagramAccountId, requeueAttempt);
  } catch (error) {
    await releaseWorkspaceDMReservation(automation.workspaceId, usage.periodStart);
    await prisma.dmLog.update({
      where: logWhere(automation.id, commentId),
      data: { status: "FAILED", errorMessage: formatError(error) },
    });
    throw error;
  }

  if (!rateLimit.allowed) {
    await releaseWorkspaceDMReservation(automation.workspaceId, usage.periodStart);

    if (rateLimit.shouldSkip) {
      await prisma.dmLog.update({
        where: logWhere(automation.id, commentId),
        data: {
          status: "SKIPPED_RATE_LIMIT",
          errorMessage: "Hourly Instagram DM rate limit reached; max retries exhausted",
        },
      });
      return;
    }

    if (rateLimit.shouldRequeue) {
      await prisma.dmLog.update({
        where: logWhere(automation.id, commentId),
        data: {
          status: "PENDING",
          errorMessage: "Hourly rate limit hit; retry scheduled",
        },
      });

      await getDMQueue().add(
        "process-comment",
        { ...job.data, requeueAttempt: requeueAttempt + 1 },
        {
          delay: rateLimit.requeueDelayMs,
          jobId: `comment:${instagramAccountId}:${commentId}:retry:${requeueAttempt + 1}`,
        }
      );
      return;
    }
  }

  // 10. Atomic delivery claim: PENDING -> SENDING
  const claim = await prisma.dmLog.updateMany({
    where: {
      automationId: automation.id,
      commentId,
      status: "PENDING",
    },
    data: { status: "SENDING" },
  });

  if (claim.count === 0) {
    await releaseWorkspaceDMReservation(automation.workspaceId, usage.periodStart);
    await releaseDMSlot(instagramAccountId);
    return;
  }

  // 11. Render message (or reuse persisted variation payload if set)
  const dmMessage =
    persistedMessagePayload ||
    renderMessageWithTracking({
      message: automation.dmMessage,
      commenterName,
      trackedLinks: automation.trackedLinks,
    });

  try {
    const metaResponse = await sendPrivateReply(
      accessToken,
      automation.instagramAccount.instagramId,
      commentId,
      dmMessage
    );

    const metaMsgId = (metaResponse as any)?.message_id || "sent";

    await prisma.dmLog.update({
      where: logWhere(automation.id, commentId),
      data: { status: "SENT", dmSentAt: new Date(), errorMessage: null },
    });

    if (deliveryJobId) {
      await transitionToSent(deliveryJobId, metaMsgId, job.attemptsMade + 1, attemptStartedAt).catch(() => {});
    }

    if (contactId) {
      await recordContactEvent({
        workspaceId: automation.workspaceId,
        contactId,
        instagramAccountId: automation.instagramAccountId,
        type: "DM_SENT",
        referenceId: commentId,
      }).catch(() => {});
    }

    // Optional public reply
    if (automation.publicReplyMessage) {
      try {
        await replyToComment(accessToken, commentId, automation.publicReplyMessage);
        if (contactId) {
          await recordContactEvent({
            workspaceId: automation.workspaceId,
            contactId,
            instagramAccountId: automation.instagramAccountId,
            type: "PUBLIC_REPLY",
            referenceId: commentId,
          }).catch(() => {});
        }
      } catch (replyErr) {
        console.warn("[dm-worker][public-reply-failed]", replyErr);
      }
    }
  } catch (error) {
    await releaseWorkspaceDMReservation(automation.workspaceId, usage.periodStart);

    if (isAmbiguousError(error)) {
      await prisma.dmLog.update({
        where: logWhere(automation.id, commentId),
        data: {
          status: "UNKNOWN",
          errorMessage: `Ambiguous network error: ${formatError(error)}`,
        },
      });

      if (deliveryJobId) {
        await transitionToUnknown(
          deliveryJobId,
          job.attemptsMade + 1,
          `Ambiguous network error: ${formatError(error)}`,
          undefined,
          attemptStartedAt
        ).catch(() => {});
      }
      return;
    }

    const metaError = error as MetaApiError;
    if (isPermanentMetaError(metaError)) {
      await releaseDMSlot(instagramAccountId);

      if (metaError.code === 190) {
        await prisma.instagramAccount.updateMany({
          where: { instagramId: automation.instagramAccount.instagramId },
          data: { tokenExpiresAt: new Date(0) },
        });

        await prisma.operationalEvent
          .create({
            data: {
              workspaceId: automation.workspaceId,
              source: "WORKER",
              level: "ERROR",
              message: `Instagram token expired or revoked for @${automation.instagramAccount.username}: ${metaError.message}`,
              payload: {
                instagramAccountId: automation.instagramAccountId,
                errorCode: metaError.code,
              },
            },
          })
          .catch(() => {});
      }

      await prisma.dmLog.update({
        where: logWhere(automation.id, commentId),
        data: { status: "FAILED", errorMessage: formatError(error) },
      });

      if (deliveryJobId) {
        await transitionToPermanentFailure(
          deliveryJobId,
          job.attemptsMade + 1,
          formatError(error),
          String(metaError.code),
          attemptStartedAt
        ).catch(() => {});
      }
      return;
    }

    // Transient Meta error -> retry via BullMQ
    await releaseDMSlot(instagramAccountId);

    await prisma.dmLog.update({
      where: logWhere(automation.id, commentId),
      data: {
        status: "FAILED",
        attempts: job.attemptsMade + 1,
        errorMessage: formatError(error),
      },
    });

    if (deliveryJobId) {
      await transitionToRetryable(
        deliveryJobId,
        job.attemptsMade + 1,
        formatError(error),
        String(metaError.code),
        attemptStartedAt
      ).catch(() => {});
    }

    throw error;
  }
}

// ---------------------------------------------------------------------------

async function recordWorkerFailure(
  job: Job<ProcessCommentJob> | undefined,
  error: Error
) {
  try {
    const instagramAccountId = job?.data.instagramAccountId;
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
          instagramAccountId: instagramAccountId ?? null,
          commentId: job?.data.commentId ?? null,
        },
      },
    });

    await recordWorkerAlert({
      level: "error",
      message: error.message,
      jobId: job?.id,
    });
  } catch (logError) {
    console.error("[dm-worker] Failed to record failure event:", logError);
  }
}

let workerInstance: Worker<ProcessCommentJob> | null = null;

export function getDMWorker(): Worker<ProcessCommentJob> {
  if (workerInstance) return workerInstance;

  workerInstance = new Worker<ProcessCommentJob>(
    "dm-queue",
    async (job: Job<ProcessCommentJob>) => {
      await processComment(job);
    },
    {
      connection: getRedisConnection(),
      concurrency: 5,
      limiter: { max: 10, duration: 1000 },
      settings: {
        backoffStrategies: {
          exponentialish: (attemptsMade: number) => {
            const index = Math.min(
              attemptsMade - 1,
              BACKOFF_DELAYS.length - 1
            );
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
    console.error("[dm-worker] Worker error:", error);
  });

  return workerInstance;
}

export function createDMWorker(): Worker<ProcessCommentJob> {
  workerInstance = null;
  return getDMWorker();
}
