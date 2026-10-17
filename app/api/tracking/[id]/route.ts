import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";

type TrackingDetailProps = {
  params: Promise<{ id: string }>;
};

const updateLinkSchema = z.object({
  active: z.boolean().optional(),
  label: z.string().max(100).optional().nullable(),
});

export async function PATCH(request: NextRequest, { params }: TrackingDetailProps) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { id } = await params;
  const existing = await prisma.trackedLink.findFirst({
    where: { id, workspaceId },
  });

  if (!existing) {
    return NextResponse.json(
      { success: false, error: "Tracked link not found" },
      { status: 404 }
    );
  }

  const body = await request.json();
  const parsed = updateLinkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const updated = await prisma.trackedLink.update({
    where: { id },
    data: parsed.data,
  });

  return NextResponse.json({ success: true, data: updated });
}

export async function DELETE(_request: NextRequest, { params }: TrackingDetailProps) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { id } = await params;
  const existing = await prisma.trackedLink.findFirst({
    where: { id, workspaceId },
  });

  if (!existing) {
    return NextResponse.json(
      { success: false, error: "Tracked link not found" },
      { status: 404 }
    );
  }

  await prisma.trackedLink.delete({ where: { id } });

  return NextResponse.json({ success: true, data: { deleted: true } });
}
