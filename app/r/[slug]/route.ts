import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getRequestIp, hashClickIp } from "@/lib/tracking/server";
import { isSafeDestinationUrl } from "@/lib/tracking/links";
import { recordContactEvent } from "@/lib/crm/contacts";

type RedirectRouteProps = {
  params: Promise<{ slug: string }>;
};

export async function GET(request: NextRequest, { params }: RedirectRouteProps) {
  const { slug } = await params;
  const url = new URL(request.url);
  const deliveryJobId = url.searchParams.get("d") || undefined;

  const trackedLink = await prisma.trackedLink.findUnique({
    where: { slug },
    select: {
      id: true,
      workspaceId: true,
      automationId: true,
      destinationUrl: true,
      active: true,
      automation: {
        select: {
          instagramAccountId: true,
        },
      },
    },
  });

  if (!trackedLink || trackedLink.active === false) {
    return NextResponse.redirect(new URL("/", request.url), { status: 302 });
  }

  // Validate destination URL safety
  if (!isSafeDestinationUrl(trackedLink.destinationUrl)) {
    return NextResponse.redirect(new URL("/", request.url), { status: 302 });
  }

  // Resolve optional delivery job and contact attribution
  let contactId: string | undefined = undefined;
  if (deliveryJobId) {
    const job = await prisma.deliveryJob.findUnique({
      where: { id: deliveryJobId },
      select: { contactId: true, workspaceId: true },
    });
    if (job && job.workspaceId === trackedLink.workspaceId) {
      contactId = job.contactId || undefined;
    }
  }

  // Record click
  try {
    const click = await prisma.linkClick.create({
      data: {
        workspaceId: trackedLink.workspaceId,
        automationId: trackedLink.automationId,
        instagramAccountId: trackedLink.automation.instagramAccountId,
        trackedLinkId: trackedLink.id,
        deliveryJobId: deliveryJobId || null,
        contactId: contactId || null,
        ipHash: hashClickIp(getRequestIp(request)),
        userAgent: request.headers.get("user-agent"),
        referrer: request.headers.get("referer"),
      },
    });

    if (contactId) {
      await recordContactEvent({
        workspaceId: trackedLink.workspaceId,
        contactId,
        instagramAccountId: trackedLink.automation.instagramAccountId,
        type: "LINK_CLICK",
        referenceId: click.id,
        metadata: { slug, destinationUrl: trackedLink.destinationUrl },
      }).catch(() => null);
    }
  } catch (err) {
    // Non-blocking error logging for click tracking
    console.error("[redirect][click-record-failed]", err);
  }

  return NextResponse.redirect(trackedLink.destinationUrl, { status: 302 });
}
