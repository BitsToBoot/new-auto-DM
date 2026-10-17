import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";

type ContactDetailProps = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: NextRequest, { params }: ContactDetailProps) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { id } = await params;

  const contact = await prisma.contact.findFirst({
    where: { id, workspaceId },
    include: {
      instagramAccount: {
        select: { username: true, instagramId: true },
      },
      events: {
        orderBy: { createdAt: "desc" },
        take: 50,
      },
      deliveryJobs: {
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          status: true,
          matchedKeyword: true,
          messagePayload: true,
          sentAt: true,
          lastError: true,
          createdAt: true,
          automation: {
            select: { name: true, id: true },
          },
        },
      },
      _count: {
        select: { events: true, deliveryJobs: true, linkClicks: true },
      },
    },
  });

  if (!contact) {
    return NextResponse.json(
      { success: false, error: "Contact not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({
    success: true,
    data: contact,
  });
}
