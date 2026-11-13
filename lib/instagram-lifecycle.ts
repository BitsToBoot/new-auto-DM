import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { unsubscribeInstagramAccountFromWebhooks } from "@/lib/meta/client";
import { logEvent, describeError } from "@/lib/ops/logger";

/**
 * Instagram account lifecycle: CONNECTED -> DISCONNECTING -> DISCONNECTED.
 *
 * Disconnect never deletes data. The account row, its campaigns, deliveries,
 * contacts and click analytics are all preserved.
 *
 * Order of operations:
 *  1. Move to DISCONNECTING (conditional update). From this moment the worker
 *     ignores new comments for the account and refuses to send queued jobs.
 *  2. Cancel PENDING deliveries (FAILED / ACCOUNT_DISCONNECTED), releasing
 *     their dedup keys.
 *  3. Best-effort Meta webhook unsubscription through the adapter. Its outcome
 *     is recorded separately and is never reported as success when it failed.
 *  4. Clear the stored token (the existing credential lifecycle: an empty token
 *     is never used or refreshed) and move to DISCONNECTED.
 *
 * Idempotent: disconnecting an already DISCONNECTED account is a no-op.
 */

/**
 * Connects (or reconnects) an Instagram account after OAuth.
 * - Same workspace: the existing row is reused and returned to CONNECTED, so
 *   reconnecting never creates a duplicate and keeps all history attached.
 * - A DISCONNECTED row owned by another workspace is archived (its unique
 *   instagramId is renamed) so that workspace keeps its history, and a fresh
 *   row is created for the new workspace. Callers must have already checked
 *   canConnectInstagramAccount, which forbids taking over a CONNECTED account.
 */
export async function connectInstagramAccount(input: {
  workspaceId: string;
  instagramId: string;
  username: string;
  name: string | null;
  encryptedToken: string;
  tokenExpiresAt: Date;
  webhookSubscribed: boolean;
}) {
  const connectedFields = {
    username: input.username,
    name: input.name,
    accessToken: input.encryptedToken,
    tokenExpiresAt: input.tokenExpiresAt,
    webhookSubscribed: input.webhookSubscribed,
    status: "CONNECTED" as const,
    connectedAt: new Date(),
    disconnectedAt: null,
    disconnectReason: null,
    webhookUnsubscribedAt: null,
    webhookUnsubscribeError: null,
  };

  return prisma.$transaction(async (tx) => {
    const existing = await tx.instagramAccount.findUnique({
      where: { instagramId: input.instagramId },
    });

    if (existing && existing.workspaceId === input.workspaceId) {
      return tx.instagramAccount.update({
        where: { id: existing.id },
        data: connectedFields,
      });
    }

    if (existing) {
      if (existing.status !== "DISCONNECTED") {
        throw new Error("Instagram account is connected to another workspace");
      }
      await tx.instagramAccount.update({
        where: { id: existing.id },
        data: { instagramId: `archived-${existing.id}` },
      });
    }

    return tx.instagramAccount.create({
      data: {
        ...connectedFields,
        workspaceId: input.workspaceId,
        instagramId: input.instagramId,
      },
    });
  });
}

export type DisconnectResult =
  | { status: "NOT_FOUND" }
  | { status: "ALREADY_DISCONNECTED"; accountId: string }
  | {
      status: "DISCONNECTED";
      accountId: string;
      cancelledDeliveries: number;
      webhookUnsubscribed: boolean;
      webhookUnsubscribeError: string | null;
    };

export async function disconnectInstagramAccount(input: {
  workspaceId: string;
  accountId: string;
  reason?: string;
}): Promise<DisconnectResult> {
  const { workspaceId, accountId } = input;
  const reason = input.reason ?? "USER_REQUESTED";

  const account = await prisma.instagramAccount.findFirst({
    where: { id: accountId, workspaceId },
  });
  if (!account) return { status: "NOT_FOUND" };
  if (account.status === "DISCONNECTED") {
    return { status: "ALREADY_DISCONNECTED", accountId };
  }

  // 1. Stop processing immediately. DISCONNECTING is re-enterable so a
  //    disconnect interrupted mid-way can be completed by retrying.
  await prisma.instagramAccount.updateMany({
    where: { id: accountId, workspaceId, status: { in: ["CONNECTED", "DISCONNECTING"] } },
    data: { status: "DISCONNECTING", disconnectReason: reason },
  });

  // 2. Queued (PENDING) deliveries must not send through this account. Jobs
  //    already SENDING finish their single in-flight request.
  const cancelled = await prisma.deliveryJob.updateMany({
    where: { instagramAccountId: accountId, status: "PENDING" },
    data: {
      status: "FAILED",
      errorCode: "ACCOUNT_DISCONNECTED",
      lastError: "Instagram account was disconnected before the DM was sent",
      dedupKey: null,
    },
  });

  // 3. External unsubscription (separate from local status).
  let webhookUnsubscribed = false;
  let webhookUnsubscribeError: string | null = null;
  if (account.accessToken) {
    try {
      const result = await unsubscribeInstagramAccountFromWebhooks(
        account.instagramId,
        decryptToken(account.accessToken)
      );
      webhookUnsubscribed = Boolean(result?.success);
      if (!webhookUnsubscribed) {
        webhookUnsubscribeError = "Meta did not confirm the webhook unsubscription";
      }
    } catch (error) {
      webhookUnsubscribeError = describeError(error);
    }
  } else {
    webhookUnsubscribeError = "No stored token; webhook unsubscription could not be attempted";
  }

  const now = new Date();

  // 4. Clear credentials and finish.
  await prisma.instagramAccount.update({
    where: { id: accountId },
    data: {
      status: "DISCONNECTED",
      disconnectedAt: now,
      accessToken: "",
      tokenExpiresAt: null,
      webhookSubscribed: webhookUnsubscribed ? false : account.webhookSubscribed,
      webhookUnsubscribedAt: webhookUnsubscribed ? now : null,
      webhookUnsubscribeError,
    },
  });

  if (webhookUnsubscribeError) {
    logEvent("warn", "instagram.webhook_unsubscribe_failed", {
      workspaceId,
      accountId,
      error: webhookUnsubscribeError,
    });
    // Visible in diagnostics. Incoming webhooks for this account are ignored by
    // the worker regardless; reconnecting and disconnecting again retries.
    await prisma.operationalEvent.create({
      data: {
        workspaceId,
        source: "SYSTEM",
        level: "WARNING",
        message: `Instagram @${account.username} was disconnected locally, but Meta webhook unsubscription failed: ${webhookUnsubscribeError}. Manual remediation may be required.`,
        payload: { instagramAccountId: accountId, reason },
      },
    });
  }

  return {
    status: "DISCONNECTED",
    accountId,
    cancelledDeliveries: cancelled.count,
    webhookUnsubscribed,
    webhookUnsubscribeError,
  };
}
