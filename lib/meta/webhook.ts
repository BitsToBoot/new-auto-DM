import { createHmac, timingSafeEqual } from "crypto";

export function verifyWebhookSignature(
  payload: string,
  signature: string | null
): boolean {
  if (!signature) return false;

  const appSecret = process.env.FACEBOOK_APP_SECRET;
  if (!appSecret) {
    throw new Error("FACEBOOK_APP_SECRET environment variable is required");
  }

  const expectedSignature =
    "sha256=" + createHmac("sha256", appSecret).update(payload).digest("hex");

  try {
    return timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch {
    return false;
  }
}

export interface WebhookCommentEvent {
  instagramAccountId: string;
  commentId: string;
  commentText: string;
  commenterId: string;
  commenterName?: string;
  mediaId: string;
  /** ISO timestamp of the comment (webhook entry time), used for the
   *  private-reply eligibility deadline. */
  commentedAt: string;
}

interface WebhookEntry {
  id: string;
  time: number;
  changes?: Array<{
    field: string;
    value: {
      id?: string;
      comment_id?: string;
      text?: string;
      from?: {
        id?: string;
        username?: string;
      };
      media?: {
        id?: string;
      };
      media_id?: string;
    };
  }>;
}

interface WebhookPayload {
  object: string;
  entry: WebhookEntry[];
}

function isNonEmptyId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128;
}

/**
 * Converts the webhook entry time to an ISO string. Meta sends Unix seconds;
 * millisecond values are tolerated. Missing, invalid or future-skewed values
 * fall back to the receive time (never later than now, so the deadline is never
 * extended beyond Meta's window).
 */
export function resolveCommentTime(entryTime: unknown, receivedAt: Date = new Date()): string {
  const raw = typeof entryTime === "number" ? entryTime : Number(entryTime);
  if (!Number.isFinite(raw) || raw <= 0) return receivedAt.toISOString();
  const ms = raw > 1e12 ? raw : raw * 1000;
  return new Date(Math.min(ms, receivedAt.getTime())).toISOString();
}

export function parseCommentEvents(
  payload: WebhookPayload,
  receivedAt: Date = new Date()
): WebhookCommentEvent[] {
  const events: WebhookCommentEvent[] = [];

  if (payload.object !== "instagram") {
    return events;
  }

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "comments") continue;

      const value = change.value;
      const commentId = value?.id ?? value?.comment_id;
      const mediaId = value?.media?.id ?? value?.media_id;
      const commenterId = value?.from?.id;

      if (
        !isNonEmptyId(entry.id) ||
        !isNonEmptyId(commentId) ||
        !isNonEmptyId(mediaId) ||
        !isNonEmptyId(commenterId)
      ) {
        continue;
      }

      events.push({
        instagramAccountId: entry.id,
        commentId,
        commentText: value.text ?? "",
        commenterId,
        commenterName:
          typeof value.from?.username === "string" ? value.from.username : undefined,
        mediaId,
        commentedAt: resolveCommentTime(entry.time, receivedAt),
      });
    }
  }

  return events;
}
