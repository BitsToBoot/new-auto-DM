import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getEffectivePlan, PLAN_LIMITS } from "@/lib/billing/plans";
import {
  calculateCtr,
  normalizeTopKeywords,
  summarizeDmStatuses,
} from "@/lib/tracking/analytics";

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const weekStart = new Date(todayStart);
  weekStart.setUTCDate(weekStart.getUTCDate() - 6);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const requestedInstagramAccountId =
    request.nextUrl.searchParams.get("instagramAccountId");
  const selectedAccountId =
    requestedInstagramAccountId && requestedInstagramAccountId !== "all"
      ? requestedInstagramAccountId
      : null;
  const accountFilter = selectedAccountId
    ? { instagramAccountId: selectedAccountId }
    : {};

  const [
    workspace,
    instagramAccount,
    instagramAccounts,
    totalAutomations,
    activeAutomations,
    dmsSentToday,
    dmsSentWeek,
    dmsSentMonth,
    totalDMs,
    dmStatusCountsThisMonth,
    clicksThisMonth,
    totalClicks,
    topKeywordRows,
    recentLogs,
  ] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        name: true,
        plan: true,
        subscriptionStatus: true,
        dmsSentThisPeriod: true,
      },
    }),
    prisma.instagramAccount.findFirst({
      where: { workspaceId },
      orderBy: { connectedAt: "desc" },
      select: {
        id: true,
        username: true,
        instagramId: true,
        tokenExpiresAt: true,
        webhookSubscribed: true,
      },
    }),
    prisma.instagramAccount.findMany({
      where: { workspaceId },
      orderBy: { connectedAt: "desc" },
      select: {
        id: true,
        username: true,
        instagramId: true,
        name: true,
        tokenExpiresAt: true,
        webhookSubscribed: true,
      },
    }),
    prisma.automation.count({ where: { workspaceId, ...accountFilter } }),
    prisma.automation.count({
      where: { workspaceId, isActive: true, ...accountFilter },
    }),
    prisma.dmLog.count({
      where: {
        workspaceId,
        status: "SENT",
        createdAt: { gte: todayStart },
        ...accountFilter,
      },
    }),
    prisma.dmLog.count({
      where: {
        workspaceId,
        status: "SENT",
        createdAt: { gte: weekStart },
        ...accountFilter,
      },
    }),
    prisma.dmLog.count({
      where: {
        workspaceId,
        status: "SENT",
        createdAt: { gte: monthStart },
        ...accountFilter,
      },
    }),
    prisma.dmLog.count({
      where: { workspaceId, status: "SENT", ...accountFilter },
    }),
    prisma.dmLog.groupBy({
      by: ["status"],
      where: { workspaceId, createdAt: { gte: monthStart }, ...accountFilter },
      _count: { _all: true },
    }),
    prisma.linkClick.count({
      where: { workspaceId, createdAt: { gte: monthStart }, ...accountFilter },
    }),
    prisma.linkClick.count({ where: { workspaceId, ...accountFilter } }),
    prisma.dmLog.groupBy({
      by: ["matchedKeyword"],
      where: { workspaceId, matchedKeyword: { not: null }, ...accountFilter },
      _count: { _all: true },
    }),
    prisma.dmLog.findMany({
      where: { workspaceId, ...accountFilter },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: {
        automation: { select: { name: true } },
        instagramAccount: { select: { username: true } },
      },
    }),
  ]);

  // Single aggregate query replacing 7 sequential per-day counts.
  // Two branches (with/without account filter) to avoid nesting $queryRaw,
  // which Prisma does not support.
  type DailyRow = { day: Date; count: bigint };
  const rawDailyRows = await (selectedAccountId
    ? prisma.$queryRaw<DailyRow[]>`
        SELECT DATE_TRUNC('day', "createdAt") AS day, COUNT(*)::bigint AS count
        FROM "DmLog"
        WHERE "workspaceId" = ${workspaceId}
          AND status = 'SENT'
          AND "createdAt" >= ${weekStart}
          AND "instagramAccountId" = ${selectedAccountId}
        GROUP BY DATE_TRUNC('day', "createdAt")
        ORDER BY day ASC
      `
    : prisma.$queryRaw<DailyRow[]>`
        SELECT DATE_TRUNC('day', "createdAt") AS day, COUNT(*)::bigint AS count
        FROM "DmLog"
        WHERE "workspaceId" = ${workspaceId}
          AND status = 'SENT'
          AND "createdAt" >= ${weekStart}
        GROUP BY DATE_TRUNC('day', "createdAt")
        ORDER BY day ASC
      `);

  // Build a full 7-day series, filling 0 for days with no data.
  const countByDay = new Map<string, number>(
    rawDailyRows.map((r: any) => [r.day.toISOString().slice(0, 10), Number(r.count)])
  );
  const dailyDMs: { date: string; count: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = new Date(todayStart);
    dayStart.setUTCDate(dayStart.getUTCDate() - i);
    const isoDate = dayStart.toISOString().slice(0, 10);
    dailyDMs.push({
      date: dayStart.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }),
      count: countByDay.get(isoDate) ?? 0,
    });
  }

  const effectivePlan = workspace
    ? getEffectivePlan(workspace.plan, workspace.subscriptionStatus)
    : "FREE";
  const monthlyStatusSummary = summarizeDmStatuses(
    dmStatusCountsThisMonth.map((row: any) => ({
      status: row.status,
      _count: row._count._all,
    }))
  );
  const topKeywords = normalizeTopKeywords(
    topKeywordRows.map((row: any) => ({
      matchedKeyword: row.matchedKeyword,
      _count: row._count._all,
    }))
  );

  return NextResponse.json({
    success: true,
    data: {
      workspace,
      instagramAccount,
      instagramAccounts,
      selectedInstagramAccountId: selectedAccountId,
      plan: effectivePlan,
      planLimits: PLAN_LIMITS[effectivePlan],
      totalAutomations,
      activeAutomations,
      dmsSentToday,
      dmsSentWeek,
      dmsSentMonth,
      dmsSkippedMonth: monthlyStatusSummary.skipped,
      dmsFailedMonth: monthlyStatusSummary.failed,
      totalDMs,
      clicksThisMonth,
      totalClicks,
      ctrThisMonth: calculateCtr(clicksThisMonth, dmsSentMonth),
      topKeywords,
      dailyDMs,
      recentLogs,
    },
  });
}
