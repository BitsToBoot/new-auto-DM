import type { Plan, SubscriptionStatus } from "@/app/generated/prisma/client";
import { getEffectivePlan, PLAN_LIMITS } from "@/lib/billing/plans";
import { prisma } from "@/lib/db/client";

export function getInstagramAccountLimit(
  plan: Plan,
  subscriptionStatus: SubscriptionStatus
) {
  return PLAN_LIMITS[getEffectivePlan(plan, subscriptionStatus)]
    .maxInstagramAccounts;
}

export async function canConnectInstagramAccount({
  workspaceId,
  plan,
  subscriptionStatus,
  instagramId,
}: {
  workspaceId: string;
  plan: Plan;
  subscriptionStatus: SubscriptionStatus;
  instagramId: string;
}) {
  const existingAccount = await prisma.instagramAccount.findUnique({
    where: { instagramId },
    select: { workspaceId: true, status: true },
  });

  // A CONNECTED (or mid-disconnect) account belongs to its workspace. A
  // DISCONNECTED one may be connected elsewhere: the callback archives the old
  // row so that workspace keeps its history.
  if (
    existingAccount &&
    existingAccount.workspaceId !== workspaceId &&
    existingAccount.status !== "DISCONNECTED"
  ) {
    return {
      allowed: false,
      reason: "already_connected" as const,
      limit: getInstagramAccountLimit(plan, subscriptionStatus),
    };
  }

  if (existingAccount?.workspaceId === workspaceId) {
    return {
      allowed: true,
      reason: null,
      limit: getInstagramAccountLimit(plan, subscriptionStatus),
    };
  }

  const limit = getInstagramAccountLimit(plan, subscriptionStatus);
  const currentCount = await prisma.instagramAccount.count({
    where: { workspaceId, status: "CONNECTED" },
  });

  return {
    allowed: currentCount < limit,
    reason: currentCount < limit ? null : ("plan_limit" as const),
    limit,
  };
}

export async function getWorkspaceInstagramAccount(
  workspaceId: string,
  instagramAccountId?: string | null
) {
  if (instagramAccountId && instagramAccountId !== "all") {
    return prisma.instagramAccount.findFirst({
      where: { id: instagramAccountId, workspaceId, status: "CONNECTED" },
    });
  }

  return prisma.instagramAccount.findFirst({
    where: { workspaceId, status: "CONNECTED" },
    orderBy: { connectedAt: "desc" },
  });
}

