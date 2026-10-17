import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { searchParams } = request.nextUrl;
  const q = searchParams.get("q")?.trim() || "";
  const instagramAccountId = searchParams.get("instagramAccountId");
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "20", 10)));
  const skip = (page - 1) * limit;

  const whereClause: any = {
    workspaceId,
    ...(instagramAccountId && instagramAccountId !== "all" ? { instagramAccountId } : {}),
  };

  if (q) {
    whereClause.OR = [
      { username: { contains: q, mode: "insensitive" } },
      { displayName: { contains: q, mode: "insensitive" } },
      { instagramUserId: { contains: q } },
    ];
  }

  const [total, contacts] = await Promise.all([
    prisma.contact.count({ where: whereClause }),
    prisma.contact.findMany({
      where: whereClause,
      include: {
        instagramAccount: {
          select: { username: true, instagramId: true },
        },
        _count: {
          select: { events: true, deliveryJobs: true, linkClicks: true },
        },
      },
      orderBy: { lastInteractionAt: "desc" },
      skip,
      take: limit,
    }),
  ]);

  return NextResponse.json({
    success: true,
    data: contacts,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
}
