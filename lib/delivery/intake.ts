import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db/client";
import type { DmStatus } from "@/app/generated/prisma/client";
import { computeDeliveryDeadline } from "@/lib/config/delivery";
import {
  MessageRenderError,
  renderDmMessage,
  selectMessageVariation,
  type MessageVariationLike,
} from "@/lib/delivery/renderer";
import { buildDeliveryTrackedUrl } from "@/lib/tracking/attribution";

/**
 * Creates the canonical DeliveryJob for a comment that resolved to a campaign.
 *
 * Guarantees:
 * - Comment idempotency: @@unique([automationId, triggerId]); a replayed
 *   comment returns the existing job and never creates a second one.
 * - "DM each user once per campaign": the unique `dedupKey`
 *   ("<automationId>:<recipientId>") is held by at most one PENDING / SENDING /
 *   SENT / UNKNOWN job. A second comment from the same user is recorded as
 *   SKIPPED_DEDUP referencing the existing delivery. Different campaigns and
 *   different Instagram accounts never block each other (the key includes the
 *   campaign, and campaigns belong to one account).
 * - The variation and the fully rendered message (including the
 *   delivery-attributed tracked URL) are persisted before any send, so every
 *   retry sends identical text.
 * - Invalid messages (unresolvable placeholder, over Meta's byte limit) are
 *   recorded as FAILED rather than sent.
 */

export interface DeliveryAutomation {
  id: string;
  dmMessage: string;
  variations?: MessageVariationLike[];
  trackedLinks?: { slug: string; destinationUrl: string; active?: boolean }[];
}

export interface CreateDeliveryJobInput {
  workspaceId: string;
  /** Internal InstagramAccount.id */
  instagramAccountId: string;
  automation: DeliveryAutomation;
  contactId: string | null;
  commentId: string;
  commenterId: string;
  commenterName?: string | null;
  commentText: string;
  mediaId: string;
  matchedKeyword: string;
  commentedAt: Date;
  now?: Date;
}

export type DeliveryJobRecord = NonNullable<
  Awaited<ReturnType<typeof prisma.deliveryJob.findUnique>>
>;

export type CreateDeliveryJobOutcome =
  | { outcome: "CREATED"; job: DeliveryJobRecord }
  | { outcome: "EXISTING"; job: DeliveryJobRecord }
  | { outcome: "DEDUPLICATED"; job: DeliveryJobRecord; existingJobId: string }
  | { outcome: "INVALID_MESSAGE"; job: DeliveryJobRecord }
  | { outcome: "EXPIRED"; job: DeliveryJobRecord };

export function buildDedupKey(automationId: string, recipientId: string) {
  return `${automationId}:${recipientId}`;
}

export function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function findByTrigger(automationId: string, commentId: string) {
  return prisma.deliveryJob.findUnique({
    where: { automationId_triggerId: { automationId, triggerId: commentId } },
  });
}

export async function createDeliveryJobForComment(
  input: CreateDeliveryJobInput
): Promise<CreateDeliveryJobOutcome> {
  const { automation, commentId, commenterId } = input;
  const now = input.now ?? new Date();

  const existing = await findByTrigger(automation.id, commentId);
  if (existing) return { outcome: "EXISTING", job: existing };

  const id = randomUUID();
  const { variationId, template } = selectMessageVariation(
    automation.variations,
    automation.dmMessage,
    commentId
  );
  const trackedLink = automation.trackedLinks?.find((link) => link.active !== false);

  let status: DmStatus = "PENDING";
  let messagePayload = "";
  let lastError: string | null = null;
  let errorCode: string | null = null;

  try {
    messagePayload = renderDmMessage(template, {
      username: input.commenterName,
      displayName: input.commenterName,
      trackedUrl: trackedLink ? buildDeliveryTrackedUrl(trackedLink.slug, id) : null,
      destinationUrl: trackedLink?.destinationUrl ?? null,
    });
  } catch (error) {
    if (!(error instanceof MessageRenderError)) throw error;
    status = "FAILED";
    lastError = error.message;
    errorCode = error.code;
  }

  const deadlineAt = computeDeliveryDeadline(input.commentedAt);
  if (status === "PENDING" && deadlineAt.getTime() <= now.getTime()) {
    status = "EXPIRED";
    lastError = "Private-reply eligibility window closed before the comment was processed";
    errorCode = "DEADLINE_PASSED";
  }

  const baseData = {
    workspaceId: input.workspaceId,
    instagramAccountId: input.instagramAccountId,
    automationId: automation.id,
    contactId: input.contactId,
    triggerId: commentId,
    recipientId: commenterId,
    recipientUsername: input.commenterName || null,
    matchedKeyword: input.matchedKeyword,
    selectedVariationId: variationId,
    mediaId: input.mediaId,
    commentText: input.commentText,
    commentedAt: input.commentedAt,
    deadlineAt,
    scheduledAt: now,
  };

  // The dedup key is only claimed by a job that may actually send.
  const dedupKey = buildDedupKey(automation.id, commenterId);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const job = await prisma.deliveryJob.create({
        data: {
          ...baseData,
          id,
          status,
          messagePayload,
          lastError,
          errorCode,
          dedupKey: status === "PENDING" ? dedupKey : null,
        },
      });
      if (status === "FAILED") return { outcome: "INVALID_MESSAGE", job };
      if (status === "EXPIRED") return { outcome: "EXPIRED", job };
      return { outcome: "CREATED", job };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
    }

    // Unique violation: either this comment was already recorded (replay /
    // concurrent duplicate) or this user already holds the campaign's dedupKey.
    const replay = await findByTrigger(automation.id, commentId);
    if (replay) return { outcome: "EXISTING", job: replay };

    const holder = await prisma.deliveryJob.findUnique({ where: { dedupKey } });
    if (!holder) continue; // holder released the key meanwhile: try again

    try {
      const job = await prisma.deliveryJob.create({
        data: {
          ...baseData,
          id,
          status: "SKIPPED_DEDUP",
          messagePayload,
          dedupKey: null,
          dedupOfDeliveryJobId: holder.id,
          lastError: `Recipient already has delivery ${holder.id} (${holder.status}) for this campaign`,
          errorCode: "DUPLICATE_RECIPIENT",
        },
      });
      return { outcome: "DEDUPLICATED", job, existingJobId: holder.id };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await findByTrigger(automation.id, commentId);
      if (raced) return { outcome: "EXISTING", job: raced };
      throw error;
    }
  }

  throw new Error(
    `Could not create DeliveryJob for comment ${commentId}: dedup key contention did not settle`
  );
}
