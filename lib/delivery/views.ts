/**
 * Read model for delivery logs. Maps the canonical DeliveryJob onto the shape
 * the dashboard and logs UI already consume (previously served from DmLog), so
 * the API contract is unchanged while DmLog is retired.
 */

export const deliveryLogInclude = {
  automation: { select: { name: true, keywords: true } },
  instagramAccount: { select: { username: true } },
} as const;

export interface DeliveryLogRow {
  id: string;
  recipientId: string;
  recipientUsername: string | null;
  commentText: string | null;
  triggerId: string;
  status: string;
  lastError: string | null;
  errorCode: string | null;
  matchedKeyword: string | null;
  attemptCount: number;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  automation: { name: string; keywords: string[] };
  instagramAccount: { username: string };
}

export function toDeliveryLogView(job: DeliveryLogRow) {
  return {
    id: job.id,
    commenterId: job.recipientId,
    commenterName: job.recipientUsername,
    commentText: job.commentText ?? "",
    commentId: job.triggerId,
    matchedKeyword: job.matchedKeyword,
    status: job.status,
    errorMessage: job.lastError,
    errorCode: job.errorCode,
    attempts: job.attemptCount,
    dmSentAt: job.sentAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    automation: job.automation,
    instagramAccount: job.instagramAccount,
  };
}
