import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getDMQueue, PROCESS_COMMENT_JOB } from "@/lib/queue/client";
import { logEvent, describeError } from "@/lib/ops/logger";
import { parseCommentEvents, verifyWebhookSignature } from "@/lib/meta/webhook";
import { Prisma } from "@/app/generated/prisma/client";

/**
 * GET — Meta webhook verification handshake.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json(
    { success: false, error: "Verification failed" },
    { status: 403 }
  );
}

/**
 * POST — Receive Meta comment events.
 *
 * Design contract:
 *  1. Verify HMAC signature.
 *  2. Parse payload into typed comment events.
 *  3. Durably persist one InboundComment row per comment (single createMany,
 *     skipDuplicates). This is the comment-level idempotency record and the
 *     source of truth for pending intake: Redis is never the only place a
 *     comment exists.
 *  4. Bulk-enqueue the comments into BullMQ with deterministic job IDs. If
 *     Redis is unavailable the request still succeeds: the scheduler
 *     re-enqueues RECEIVED comments.
 *  5. Persist a WebhookEvent audit row.
 *
 * If step 3 fails we return 500 so Meta redelivers the webhook.
 *
 * What this handler intentionally does NOT do:
 *  - automation matching        (worker responsibility)
 *  - token lookup               (worker responsibility)
 *  - Meta API calls             (worker responsibility)
 */
export async function POST(request: NextRequest) {
  // Enforce a 1 MB body size limit to prevent memory exhaustion
  const contentLength = request.headers.get("content-length");
  const MAX_BODY_BYTES = 1_048_576; // 1 MB
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return NextResponse.json(
      { success: false, error: "Payload too large" },
      { status: 413 }
    );
  }

  const rawBody = await request.text();

  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { success: false, error: "Payload too large" },
      { status: 413 }
    );
  }

  const signature = request.headers.get("x-hub-signature-256");

  if (!verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json(
      { success: false, error: "Invalid signature" },
      { status: 401 }
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }

  // Parse events before touching the DB so malformed payloads are rejected fast.
  const commentEvents = parseCommentEvents(
    payload as Parameters<typeof parseCommentEvents>[0]
  );

  let enqueued = false;
  if (commentEvents.length > 0) {
    try {
      await prisma.inboundComment.createMany({
        data: commentEvents.map((event) => ({
          instagramAccountId: event.instagramAccountId,
          commentId: event.commentId,
          mediaId: event.mediaId,
          commenterId: event.commenterId,
          commenterUsername: event.commenterName ?? null,
          commentText: event.commentText,
          commentedAt: new Date(event.commentedAt),
        })),
        skipDuplicates: true,
      });
    } catch (error) {
      logEvent("error", "webhook.persist_failed", { error: describeError(error) });
      return NextResponse.json(
        { success: false, error: "Temporarily unable to accept events" },
        { status: 500 }
      );
    }

    try {
      await getDMQueue().addBulk(
        commentEvents.map((event) => ({
          name: PROCESS_COMMENT_JOB,
          data: {
            instagramAccountId: event.instagramAccountId,
            commentId: event.commentId,
            commentText: event.commentText,
            commenterId: event.commenterId,
            commenterName: event.commenterName,
            mediaId: event.mediaId,
            commentedAt: event.commentedAt,
          },
          opts: {
            // Stable jobId: BullMQ treats duplicate IDs as no-ops (idempotent enqueue).
            jobId: `comment-${event.instagramAccountId}-${event.commentId}`,
          },
        }))
      );
      enqueued = true;
    } catch (error) {
      // Comments are durably stored; the scheduler re-enqueues RECEIVED rows.
      logEvent("warn", "webhook.enqueue_failed_scheduler_will_recover", {
        count: commentEvents.length,
        error: describeError(error),
      });
    }
  }

  try {
    await persistWebhookAudit(payload, commentEvents.length > 0 && enqueued);
  } catch (error) {
    logEvent("warn", "webhook.audit_persist_failed", { error: describeError(error) });
  }

  return NextResponse.json({ success: true }, { status: 200 });
}

async function persistWebhookAudit(payload: unknown, queued: boolean): Promise<void> {
  const object =
    typeof payload === "object" && payload && "object" in payload
      ? String((payload as Record<string, unknown>).object)
      : null;

  await prisma.webhookEvent.create({
    data: {
      object,
      payload: payload as Prisma.InputJsonValue,
      // QUEUED: comments persisted and enqueued. PENDING: persisted only (or
      // no comment events); the scheduler handles recovery.
      status: queued ? "QUEUED" : "PENDING",
    },
  });
}
