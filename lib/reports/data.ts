import { prisma } from "@/lib/db/client";
import {
  calculateCtr,
  normalizeTopKeywords,
  summarizeDmStatuses,
} from "@/lib/tracking/analytics";
import { buildReportUrl, isReportBranded } from "@/lib/reports/share";

function getHostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function getDayWindow(daysAgo: number) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - daysAgo);

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  return { start, end };
}

export async function getCampaignReportBySlug(shareSlug: string) {
  const automation = await prisma.automation.findFirst({
    where: {
      reportShareSlug: shareSlug,
      reportShareEnabled: true,
    },
    select: {
      id: true,
      workspaceId: true,
      name: true,
      goal: true,
      postUrl: true,
      keywords: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
      reportShareSlug: true,
      workspace: {
        select: {
          name: true,
          plan: true,
          subscriptionStatus: true,
        },
      },
      instagramAccount: {
        select: {
          username: true,
        },
      },
      trackedLinks: {
        select: {
          id: true,
          slug: true,
          destinationUrl: true,
          _count: { select: { clicks: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!automation || !automation.reportShareSlug) {
    return null;
  }

  const [statusRows, clickCount, keywordRows, latestSentLog] =
    await Promise.all([
      prisma.dmLog.groupBy({
        by: ["status"],
        where: {
          workspaceId: automation.workspaceId,
          automationId: automation.id,
        },
        _count: { _all: true },
      }),
      prisma.linkClick.count({
        where: {
          workspaceId: automation.workspaceId,
          automationId: automation.id,
        },
      }),
      prisma.dmLog.groupBy({
        by: ["matchedKeyword"],
        where: {
          workspaceId: automation.workspaceId,
          automationId: automation.id,
          matchedKeyword: { not: null },
        },
        _count: { _all: true },
      }),
      prisma.dmLog.findFirst({
        where: {
          workspaceId: automation.workspaceId,
          automationId: automation.id,
          status: "SENT",
        },
        orderBy: { dmSentAt: "desc" },
        select: { dmSentAt: true, createdAt: true },
      }),
    ]);

  const statusSummary = summarizeDmStatuses(
    statusRows.map((row: any) => ({
      status: row.status,
      _count: row._count._all,
    }))
  );
  const topKeywords = normalizeTopKeywords(
    keywordRows.map((row: any) => ({
      matchedKeyword: row.matchedKeyword,
      _count: row._count._all,
    }))
  );
  // Two aggregate queries replace 14 per-day counts (7 days × 2 tables).
  const sevenDaysAgo = getDayWindow(6).start;

  type DailyAgg = { day: Date; count: bigint };
  const [rawDmDays, rawClickDays] = await Promise.all([
    prisma.$queryRaw<DailyAgg[]>`
      SELECT DATE_TRUNC('day', "createdAt") AS day, COUNT(*)::bigint AS count
      FROM "DmLog"
      WHERE "workspaceId" = ${automation.workspaceId}
        AND "automationId" = ${automation.id}
        AND status = 'SENT'
        AND "createdAt" >= ${sevenDaysAgo}
      GROUP BY DATE_TRUNC('day', "createdAt")
      ORDER BY day ASC
    `,
    prisma.$queryRaw<DailyAgg[]>`
      SELECT DATE_TRUNC('day', "createdAt") AS day, COUNT(*)::bigint AS count
      FROM "LinkClick"
      WHERE "workspaceId" = ${automation.workspaceId}
        AND "automationId" = ${automation.id}
        AND "createdAt" >= ${sevenDaysAgo}
      GROUP BY DATE_TRUNC('day', "createdAt")
      ORDER BY day ASC
    `,
  ]);

  const dmByDay = new Map(rawDmDays.map((r: any) => [r.day.toISOString().slice(0, 10), Number(r.count)]));
  const clickByDay = new Map(rawClickDays.map((r: any) => [r.day.toISOString().slice(0, 10), Number(r.count)]));

  const daily = Array.from({ length: 7 }, (_, index) => {
    const daysAgo = 6 - index;
    const { start } = getDayWindow(daysAgo);
    const iso = start.toISOString().slice(0, 10);
    return {
      date: start.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
      sent: dmByDay.get(iso) ?? 0,
      clicks: clickByDay.get(iso) ?? 0,
    };
  });


  return {
    shareSlug: automation.reportShareSlug,
    reportUrl: buildReportUrl(automation.reportShareSlug),
    generatedAt: new Date(),
    branded: isReportBranded(
      automation.workspace.plan,
      automation.workspace.subscriptionStatus
    ),
    workspace: {
      name: automation.workspace.name,
    },
    campaign: {
      name: automation.name,
      goal: automation.goal,
      postUrl: automation.postUrl,
      keywords: automation.keywords,
      isActive: automation.isActive,
      createdAt: automation.createdAt,
      updatedAt: automation.updatedAt,
      instagramUsername: automation.instagramAccount.username,
    },
    metrics: {
      sent: statusSummary.sent,
      skipped: statusSummary.skipped,
      failed: statusSummary.failed,
      clicks: clickCount,
      ctr: calculateCtr(clickCount, statusSummary.sent),
      latestSentAt: latestSentLog?.dmSentAt ?? latestSentLog?.createdAt ?? null,
    },
    topKeywords,
    daily,
    trackedLinks: automation.trackedLinks.map((link: any) => ({
      slug: link.slug,
      destinationHost: getHostname(link.destinationUrl),
      clicks: link._count.clicks,
    })),
  };
}
