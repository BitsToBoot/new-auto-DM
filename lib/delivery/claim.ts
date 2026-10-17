import { prisma } from "@/lib/db/client";
import { selectMessageVariation, renderDmMessage } from "@/lib/delivery/renderer";
import { CandidateAutomation } from "@/lib/automation/policy";

export interface ClaimDeliveryJobInput {
  workspaceId: string;
  instagramAccountId: string;
  automation: CandidateAutomation;
  contactId?: string | null;
  commentId: string;
  commenterId: string;
  commenterName?: string | null;
  commentText: string;
  matchedKeyword: string;
  trackedUrl?: string | null;
}

export type ClaimDeliveryJobOutcome =
  | { success: true; deliveryJob: any; isNew: boolean }
  | { success: false; reason: "ALREADY_COMPLETED" | "IN_FLIGHT_UNKNOWN" | "CLAIM_RACE" | "MAX_ATTEMPTS"; status?: string };

/**
 * Atomically creates and claims a delivery job for sending.
 * - Idempotency guaranteed by @@unique([automationId, triggerId])
 * - Preserves already-persisted messagePayload across retries (NEVER re-selects a variation on retry)
 * - Transitions status: PENDING -> SENDING atomically via conditional update
 */
export async function claimDeliveryJob(
  input: ClaimDeliveryJobInput
): Promise<ClaimDeliveryJobOutcome> {
  const {
    workspaceId,
    instagramAccountId,
    automation,
    contactId,
    commentId,
    commenterId,
    commenterName,
    matchedKeyword,
    trackedUrl,
  } = input;

  let job = await prisma.deliveryJob.findUnique({
    where: {
      automationId_triggerId: {
        automationId: automation.id,
        triggerId: commentId,
      },
    },
  });

  let isNew = false;

  if (!job) {
    // Select variation and render message payload BEFORE creating the job
    const { variationId, template } = selectMessageVariation(
      automation.variations,
      automation.dmMessage
    );

    const messagePayload = renderDmMessage(template, {
      username: commenterName,
      displayName: commenterName,
      trackedUrl,
    });

    try {
      job = await prisma.deliveryJob.create({
        data: {
          workspaceId,
          instagramAccountId,
          automationId: automation.id,
          contactId: contactId || null,
          triggerId: commentId,
          recipientId: commenterId,
          recipientUsername: commenterName || null,
          matchedKeyword,
          messagePayload,
          selectedVariationId: variationId || null,
          status: "PENDING",
        },
      });
      isNew = true;
    } catch (err: any) {
      // Handle P2002 duplicate creation race condition
      if (err?.code === "P2002") {
        job = await prisma.deliveryJob.findUnique({
          where: {
            automationId_triggerId: {
              automationId: automation.id,
              triggerId: commentId,
            },
          },
        });
      } else {
        throw err;
      }
    }
  }

  if (!job) {
    return { success: false, reason: "CLAIM_RACE" };
  }

  // Check existing terminal or in-flight states
  if (job.status === "SENT") {
    return { success: false, reason: "ALREADY_COMPLETED", status: "SENT" };
  }

  if (job.status === "UNKNOWN") {
    return { success: false, reason: "IN_FLIGHT_UNKNOWN", status: "UNKNOWN" };
  }

  if (job.status === "SENDING") {
    // In-flight from another worker or previous worker crashed mid-dispatch.
    // Transition to UNKNOWN to prevent duplicate send.
    await prisma.deliveryJob.update({
      where: { id: job.id },
      data: {
        status: "UNKNOWN",
        lastError: "Worker crashed or timed out while SENDING in flight; manual review required.",
      },
    });
    return { success: false, reason: "IN_FLIGHT_UNKNOWN", status: "UNKNOWN" };
  }

  if (job.status === "FAILED" && job.attemptCount >= 3) {
    return { success: false, reason: "MAX_ATTEMPTS", status: "FAILED" };
  }

  // Atomic claim: only succeed if still PENDING or FAILED (retryable)
  const claimResult = await prisma.deliveryJob.updateMany({
    where: {
      id: job.id,
      status: { in: ["PENDING", "FAILED"] },
    },
    data: {
      status: "SENDING",
      processingStartedAt: new Date(),
    },
  });

  if (claimResult.count === 0) {
    return { success: false, reason: "CLAIM_RACE" };
  }

  const claimedJob = await prisma.deliveryJob.findUnique({
    where: { id: job.id },
  });

  return { success: true, deliveryJob: claimedJob, isNew };
}
