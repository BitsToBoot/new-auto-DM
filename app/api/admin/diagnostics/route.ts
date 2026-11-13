import { NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getDMQueue } from "@/lib/queue/client";
import { getWorkerAlerts, getWorkerHealth } from "@/lib/ops/worker-health";
import { getDeliveryBacklog } from "@/lib/delivery/scheduler";

export const runtime = "nodejs";

export async function GET() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const [
    queueCounts,
    workerHealth,
    workerAlerts,
    webhookFailures,
    billingEvents,
    dmFailures,
    tokenRefreshFailures,
    operationalEvents,
    deliveryBacklog,
    disconnectedAccounts,
  ] = await Promise.all([
    getDMQueue().getJobCounts("waiting", "active", "delayed", "failed"),
    getWorkerHealth(),
    getWorkerAlerts(10),
    prisma.webhookEvent.findMany({
      where: { workspaceId, status: "FAILED" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        object: true,
        errorMessage: true,
        createdAt: true,
        processedAt: true,
      },
    }),
    prisma.billingEvent.findMany({
      where: { workspaceId },
      orderBy: { processedAt: "desc" },
      take: 10,
      select: {
        id: true,
        stripeEventId: true,
        type: true,
        processedAt: true,
      },
    }),
    prisma.deliveryJob
      .findMany({
        where: {
          workspaceId,
          status: {
            in: ["FAILED", "UNKNOWN", "EXPIRED", "SKIPPED_PLAN_LIMIT", "SKIPPED_RATE_LIMIT"],
          },
        },
        orderBy: { updatedAt: "desc" },
        take: 10,
        select: {
          id: true,
          status: true,
          triggerId: true,
          commentText: true,
          lastError: true,
          errorCode: true,
          updatedAt: true,
          automation: { select: { name: true } },
        },
      })
      .then((rows) =>
        rows.map((row) => ({
          id: row.id,
          status: row.status,
          commentId: row.triggerId,
          commentText: row.commentText ?? "",
          errorMessage: row.lastError,
          errorCode: row.errorCode,
          updatedAt: row.updatedAt,
          automation: row.automation,
        }))
      ),
    prisma.operationalEvent.findMany({
      where: { workspaceId, source: "TOKEN_REFRESH", level: "ERROR" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        message: true,
        createdAt: true,
        payload: true,
      },
    }),
    prisma.operationalEvent.findMany({
      where: {
        OR: [{ workspaceId }, { workspaceId: null }],
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        source: true,
        level: true,
        message: true,
        createdAt: true,
        resolvedAt: true,
      },
    }),
    getDeliveryBacklog(workspaceId),
    prisma.instagramAccount.findMany({
      where: { workspaceId, status: { not: "CONNECTED" } },
      select: {
        id: true,
        username: true,
        status: true,
        disconnectedAt: true,
        webhookSubscribed: true,
        webhookUnsubscribeError: true,
      },
    }),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      queueCounts,
      workerHealth,
      workerAlerts,
      webhookFailures,
      billingEvents,
      dmFailures,
      tokenRefreshFailures,
      operationalEvents,
      deliveryBacklog,
      disconnectedAccounts,
    },
  });
}
