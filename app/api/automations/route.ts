import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getEffectivePlan, PLAN_LIMITS } from "@/lib/billing/plans";
import { calculateCtr, normalizeTopKeywords } from "@/lib/tracking/analytics";
import { buildTrackedUrl } from "@/lib/tracking/message";
import { generateTrackedLinkSlug } from "@/lib/tracking/server";
import { isSafeDestinationUrl } from "@/lib/tracking/links";
import { buildReportUrl, generateReportShareSlug } from "@/lib/reports/share";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";
import {
  validateAndNormalizeKeywords,
  MAX_KEYWORDS_PER_AUTOMATION,
} from "@/lib/automation/matcher";

const createAutomationSchema = z.object({
  name: z.string().min(1).max(100),
  goal: z.string().min(1).max(120).optional().nullable(),
  instagramAccountId: z.string().min(1).optional().nullable(),
  triggerScope: z
    .enum(["SPECIFIC_POST", "SPECIFIC_MEDIA", "NEXT_POST", "ANY_POST"])
    .optional()
    .default("SPECIFIC_POST"),
  postId: z.string().min(1).optional().nullable(),
  postUrl: z.string().url().optional().nullable(),
  keywords: z.array(z.string().min(1).max(100)).min(1).max(MAX_KEYWORDS_PER_AUTOMATION),
  dmMessage: z.string().min(1).max(1000),
  variations: z.array(z.string().min(1).max(1000)).max(10).optional(),
  publicReplyMessage: z.string().max(500).optional().nullable(),
  trackedDestinationUrl: z.string().url().optional().nullable(),
  isActive: z.boolean().optional().default(true),
  wholeWordMatch: z.boolean().optional().default(true),
});

const updateAutomationSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  goal: z.string().min(1).max(120).optional().nullable(),
  triggerScope: z
    .enum(["SPECIFIC_POST", "SPECIFIC_MEDIA", "NEXT_POST", "ANY_POST"])
    .optional(),
  postId: z.string().min(1).optional().nullable(),
  postUrl: z.string().url().optional().nullable(),
  keywords: z.array(z.string().min(1).max(100)).min(1).max(MAX_KEYWORDS_PER_AUTOMATION).optional(),
  dmMessage: z.string().min(1).max(1000).optional(),
  variations: z.array(z.string().min(1).max(1000)).max(10).optional(),
  publicReplyMessage: z.string().max(500).optional().nullable(),
  isActive: z.boolean().optional(),
  wholeWordMatch: z.boolean().optional(),
  reportShareEnabled: z.boolean().optional(),
});

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  const instagramAccountId =
    request.nextUrl.searchParams.get("instagramAccountId");
  const accountFilter =
    instagramAccountId && instagramAccountId !== "all"
      ? { instagramAccountId }
      : {};

  const automations = await prisma.automation.findMany({
    where: { workspaceId, ...accountFilter },
    include: {
      instagramAccount: {
        select: { username: true, instagramId: true },
      },
      keywordsList: {
        select: { id: true, keyword: true, normalizedKeyword: true },
      },
      variations: {
        select: { id: true, message: true, isActive: true },
      },
      _count: {
        select: { dmLogs: true, deliveryJobs: true },
      },
      trackedLinks: {
        select: {
          id: true,
          slug: true,
          label: true,
          destinationUrl: true,
          active: true,
          _count: { select: { clicks: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // GET is strictly read-only.
  // Aggregations use SQL GROUP BY.
  const [statusCounts, clickCounts, keywordCounts] = await Promise.all([
    prisma.dmLog.groupBy({
      by: ["automationId", "status"],
      where: { workspaceId },
      _count: { _all: true },
    }),
    prisma.linkClick.groupBy({
      by: ["automationId"],
      where: { workspaceId },
      _count: { _all: true },
    }),
    prisma.dmLog.groupBy({
      by: ["automationId", "matchedKeyword"],
      where: { workspaceId, matchedKeyword: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const analytics = new Map<
    string,
    {
      sent: number;
      skipped: number;
      failed: number;
      clicks: number;
      topKeywords: { keyword: string; count: number }[];
    }
  >();

  for (const automation of automations) {
    analytics.set(automation.id, {
      sent: 0,
      skipped: 0,
      failed: 0,
      clicks: 0,
      topKeywords: [],
    });
  }

  for (const row of statusCounts as any[]) {
    const item = analytics.get(row.automationId);
    if (!item) continue;
    const count = row._count._all;
    if (row.status === "SENT") item.sent += count;
    if (row.status === "FAILED") item.failed += count;
    if (row.status?.startsWith?.("SKIPPED_")) item.skipped += count;
  }

  for (const row of clickCounts as any[]) {
    const item = analytics.get(row.automationId);
    if (item) item.clicks = row._count._all;
  }

  // Pre-index keyword counts by automationId to avoid nested filtering
  const keywordsByAutomation = new Map<string, { matchedKeyword: string | null; count: number }[]>();
  for (const row of keywordCounts as any[]) {
    if (!keywordsByAutomation.has(row.automationId)) {
      keywordsByAutomation.set(row.automationId, []);
    }
    keywordsByAutomation.get(row.automationId)!.push({
      matchedKeyword: row.matchedKeyword,
      count: row._count._all,
    });
  }

  for (const automation of automations) {
    const item = analytics.get(automation.id);
    if (!item) continue;
    const rows = keywordsByAutomation.get(automation.id) ?? [];
    item.topKeywords = normalizeTopKeywords(
      rows.map((row) => ({
        matchedKeyword: row.matchedKeyword,
        _count: row.count,
      })),
      3
    );
  }

  return NextResponse.json({
    success: true,
    data: automations.map((automation: any) => {
      const item = analytics.get(automation.id) ?? {
        sent: 0,
        skipped: 0,
        failed: 0,
        clicks: 0,
        topKeywords: [],
      };

      return {
        ...automation,
        trackedLinks: automation.trackedLinks.map((link: any) => ({
          ...link,
          trackedUrl: buildTrackedUrl(link.slug),
        })),
        reportUrl: automation.reportShareSlug
          ? buildReportUrl(automation.reportShareSlug)
          : null,
        analytics: {
          ...item,
          ctr: calculateCtr(item.clicks, item.sent),
        },
      };
    }),
  });
}

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can create campaigns" },
      { status: 403 }
    );
  }

  const workspaceId = context.workspaceId;

  const body = await request.json();
  const parsed = createAutomationSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid input",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  const data = parsed.data;

  // Validate SPECIFIC_POST post ID requirement
  if (
    (data.triggerScope === "SPECIFIC_POST" || data.triggerScope === "SPECIFIC_MEDIA") &&
    !data.postId
  ) {
    return NextResponse.json(
      { success: false, error: "Selected Instagram post is required for specific post trigger" },
      { status: 400 }
    );
  }

  // Server-side keyword validation & normalization
  const keywordValidation = validateAndNormalizeKeywords(data.keywords);
  if (!keywordValidation.valid) {
    return NextResponse.json(
      { success: false, error: keywordValidation.error },
      { status: 400 }
    );
  }

  // Destination URL validation
  if (data.trackedDestinationUrl && !isSafeDestinationUrl(data.trackedDestinationUrl)) {
    return NextResponse.json(
      { success: false, error: "Invalid or unsafe destination URL. Only http and https URLs are supported." },
      { status: 400 }
    );
  }

  const requestedInstagramAccountId =
    data.instagramAccountId && data.instagramAccountId !== "all"
      ? data.instagramAccountId
      : null;

  const [workspace, instagramAccount, automationCount] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { plan: true, subscriptionStatus: true },
    }),
    requestedInstagramAccountId
      ? prisma.instagramAccount.findFirst({
          where: { id: requestedInstagramAccountId, workspaceId },
        })
      : prisma.instagramAccount.findFirst({
          where: { workspaceId },
          orderBy: { connectedAt: "desc" },
        }),
    prisma.automation.count({ where: { workspaceId } }),
  ]);

  if (!workspace) {
    return NextResponse.json(
      { success: false, error: "Workspace not found" },
      { status: 404 }
    );
  }

  if (!instagramAccount) {
    return NextResponse.json(
      { success: false, error: "Connect Instagram before creating campaigns" },
      { status: 400 }
    );
  }

  const effectivePlan = getEffectivePlan(
    workspace.plan,
    workspace.subscriptionStatus
  );
  const limit = PLAN_LIMITS[effectivePlan];

  if (automationCount >= limit.maxAutomations) {
    return NextResponse.json(
      {
        success: false,
        error: `Plan limit reached. Your ${effectivePlan} plan allows up to ${limit.maxAutomations} campaign(s).`,
      },
      { status: 403 }
    );
  }

  const { trackedDestinationUrl, variations } = data;
  const rawKeywords = keywordValidation.keywords.map((k) => k.raw);

  // Transactionally create Automation, Keywords, Message Variations, and TrackedLink
  const automation = await prisma.$transaction(async (tx: any) => {
    const created = await tx.automation.create({
      data: {
        name: data.name,
        goal: data.goal,
        triggerScope: data.triggerScope,
        postId: data.postId || null,
        postUrl: data.postUrl || null,
        keywords: rawKeywords,
        dmMessage: data.dmMessage,
        publicReplyMessage: data.publicReplyMessage || null,
        isActive: data.isActive,
        wholeWordMatch: data.wholeWordMatch,
        workspaceId,
        instagramAccountId: instagramAccount.id,
        reportShareSlug: generateReportShareSlug(),
        ...(trackedDestinationUrl
          ? {
              trackedLinks: {
                create: {
                  workspaceId,
                  slug: generateTrackedLinkSlug(),
                  label: "Primary campaign link",
                  destinationUrl: trackedDestinationUrl,
                  active: true,
                },
              },
            }
          : {}),
      },
    });

    // Create normalized keywords
    await tx.automationKeyword.createMany({
      data: keywordValidation.keywords.map((k) => ({
        automationId: created.id,
        keyword: k.raw,
        normalizedKeyword: k.normalized,
      })),
      skipDuplicates: true,
    });

    // Create variations if provided
    if (variations && variations.length > 0) {
      await tx.automationMessageVariation.createMany({
        data: variations.map((msg) => ({
          automationId: created.id,
          message: msg,
          isActive: true,
        })),
      });
    }

    return tx.automation.findUnique({
      where: { id: created.id },
      include: {
        keywordsList: true,
        variations: true,
        trackedLinks: true,
      },
    });
  });

  return NextResponse.json(
    { success: true, data: automation },
    { status: 201 }
  );
}

export async function PATCH(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can update campaigns" },
      { status: 403 }
    );
  }

  const workspaceId = context.workspaceId;

  const automationId = request.nextUrl.searchParams.get("id");
  if (!automationId) {
    return NextResponse.json(
      { success: false, error: "Missing campaign ID" },
      { status: 400 }
    );
  }

  const body = await request.json();
  const parsed = updateAutomationSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid input",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  const existing = await prisma.automation.findFirst({
    where: { id: automationId, workspaceId },
  });

  if (!existing) {
    return NextResponse.json(
      { success: false, error: "Campaign not found" },
      { status: 404 }
    );
  }

  const data = parsed.data;

  // Handle keyword updates if specified
  let keywordValidationResult = null;
  if (data.keywords) {
    keywordValidationResult = validateAndNormalizeKeywords(data.keywords);
    if (!keywordValidationResult.valid) {
      return NextResponse.json(
        { success: false, error: keywordValidationResult.error },
        { status: 400 }
      );
    }
  }

  const updated = await prisma.$transaction(async (tx: any) => {
    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.goal !== undefined) updateData.goal = data.goal;
    if (data.triggerScope !== undefined) updateData.triggerScope = data.triggerScope;
    if (data.postId !== undefined) updateData.postId = data.postId;
    if (data.postUrl !== undefined) updateData.postUrl = data.postUrl;
    if (data.dmMessage !== undefined) updateData.dmMessage = data.dmMessage;
    if (data.publicReplyMessage !== undefined) updateData.publicReplyMessage = data.publicReplyMessage;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.wholeWordMatch !== undefined) updateData.wholeWordMatch = data.wholeWordMatch;
    if (data.reportShareEnabled !== undefined) updateData.reportShareEnabled = data.reportShareEnabled;

    if (keywordValidationResult) {
      updateData.keywords = keywordValidationResult.keywords.map((k) => k.raw);
      // Replace existing normalized keywords
      await tx.automationKeyword.deleteMany({ where: { automationId } });
      await tx.automationKeyword.createMany({
        data: keywordValidationResult.keywords.map((k) => ({
          automationId,
          keyword: k.raw,
          normalizedKeyword: k.normalized,
        })),
        skipDuplicates: true,
      });
    }

    if (data.variations) {
      await tx.automationMessageVariation.deleteMany({ where: { automationId } });
      if (data.variations.length > 0) {
        await tx.automationMessageVariation.createMany({
          data: data.variations.map((msg) => ({
            automationId,
            message: msg,
            isActive: true,
          })),
        });
      }
    }

    return tx.automation.update({
      where: { id: automationId },
      data: updateData,
      include: {
        keywordsList: true,
        variations: true,
      },
    });
  });

  return NextResponse.json({ success: true, data: updated });
}

export async function DELETE(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can delete campaigns" },
      { status: 403 }
    );
  }

  const workspaceId = context.workspaceId;

  const automationId = request.nextUrl.searchParams.get("id");
  if (!automationId) {
    return NextResponse.json(
      { success: false, error: "Missing campaign ID" },
      { status: 400 }
    );
  }

  const existing = await prisma.automation.findFirst({
    where: { id: automationId, workspaceId },
  });

  if (!existing) {
    return NextResponse.json(
      { success: false, error: "Campaign not found" },
      { status: 404 }
    );
  }

  await prisma.automation.delete({ where: { id: automationId } });

  return NextResponse.json({ success: true, data: { deleted: true } });
}
