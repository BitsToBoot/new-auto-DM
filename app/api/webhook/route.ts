import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getDMQueue } from "@/lib/queue/client";
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
 * POST — Receive and enqueue Meta comment events.
 *
 * Design contract:
 *  1. Verify HMAC signature.
 *  2. Parse payload into typed comment events.
 *  3. Bulk-enqueue all events into BullMQ in a single call.
 *     BullMQ deduplicates by jobId so duplicate webhooks are safe.
 *  4. Persist a WebhookEvent audit row (QUEUED) asynchronously — the
 *     HTTP 200 is returned before this write completes so Meta never
 *     times out waiting for us.
 *
 * What this handler intentionally does NOT do:
 *  - automation matching        (worker responsibility)
 *  - token lookup               (worker responsibility)
 *  - Meta API calls             (worker responsibility)
 *  - per-event DB queries       (creates sequential blocking under burst)
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

  // Bulk-enqueue. BullMQ ignores jobs whose jobId already exists in the queue,
  // so duplicate Meta webhooks cannot produce duplicate queue entries.
  if (commentEvents.length > 0) {
    const queue = getDMQueue();
    await queue.addBulk(
      commentEvents.map((event) => ({
        name: "process-comment",
        data: {
          instagramAccountId: event.instagramAccountId,
          commentId: event.commentId,
          commentText: event.commentText,
          commenterId: event.commenterId,
          commenterName: event.commenterName,
          mediaId: event.mediaId,
        },
        opts: {
          // Stable jobId: BullMQ treats duplicate IDs as no-ops (idempotent enqueue).
          jobId: `comment-${event.instagramAccountId}-${event.commentId}`,
        },
      }))
    );
  }

  // Persist audit row in the background — do not await so Meta gets an
  // immediate 200 regardless of DB latency.
  persistWebhookAudit(payload, commentEvents.length).catch((err: unknown) => {
    console.error(
      "[Webhook] Failed to persist audit row:",
      err instanceof Error ? err.message : err
    );
  });

  return NextResponse.json({ success: true }, { status: 200 });
}

async function persistWebhookAudit(
  payload: unknown,
  eventCount: number
): Promise<void> {
  const object =
    typeof payload === "object" && payload && "object" in payload
      ? String((payload as Record<string, unknown>).object)
      : null;

  await prisma.webhookEvent.create({
    data: {
      object,
      payload: payload as Prisma.InputJsonValue,
      // QUEUED means we have enqueued the jobs; the worker tracks deeper state.
      status: eventCount > 0 ? "QUEUED" : "PENDING",
    },
  });
}
