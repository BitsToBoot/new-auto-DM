import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { generateTrackedLinkSlug } from "@/lib/tracking/server";
import { isSafeDestinationUrl } from "@/lib/tracking/links";
import { buildTrackedUrl } from "@/lib/tracking/message";

const createTrackedLinkSchema = z.object({
  automationId: z.string().min(1),
  destinationUrl: z.string().url(),
  label: z.string().max(100).optional().nullable(),
});

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const automationId = request.nextUrl.searchParams.get("automationId");

  const links = await prisma.trackedLink.findMany({
    where: {
      workspaceId,
      ...(automationId ? { automationId } : {}),
    },
    include: {
      automation: {
        select: { name: true },
      },
      _count: {
        select: { clicks: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    success: true,
    data: links.map((link: any) => ({
      ...link,
      trackedUrl: buildTrackedUrl(link.slug),
      clickCount: link._count.clicks,
    })),
  });
}

export async function POST(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const body = await request.json();
  const parsed = createTrackedLinkSchema.safeParse(body);

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

  const { automationId, destinationUrl, label } = parsed.data;

  // Validate destination URL safety (reject javascript:, data:, etc.)
  if (!isSafeDestinationUrl(destinationUrl)) {
    return NextResponse.json(
      { success: false, error: "Invalid or unsafe destination URL. Only http and https URLs are allowed." },
      { status: 400 }
    );
  }

  // Verify automation belongs to workspace
  const automation = await prisma.automation.findFirst({
    where: { id: automationId, workspaceId },
  });

  if (!automation) {
    return NextResponse.json(
      { success: false, error: "Automation not found" },
      { status: 404 }
    );
  }

  const slug = generateTrackedLinkSlug();

  const link = await prisma.trackedLink.create({
    data: {
      workspaceId,
      automationId,
      destinationUrl,
      label: label || null,
      slug,
      active: true,
    },
  });

  return NextResponse.json(
    {
      success: true,
      data: {
        ...link,
        trackedUrl: buildTrackedUrl(link.slug),
      },
    },
    { status: 201 }
  );
}
