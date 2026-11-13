import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getRequestIp, hashClickIp } from "@/lib/tracking/server";
import { isSafeDestinationUrl } from "@/lib/tracking/links";
import { recordContactEvent } from "@/lib/crm/contacts";
import { verifyDeliveryAttribution } from "@/lib/tracking/attribution";

type RedirectRouteProps = {
  params: Promise<{ slug: string }>;
};

export async function GET(request: NextRequest, { params }: RedirectRouteProps) {
  const { slug } = await params;
  const url = new URL(request.url);
  const requestedDeliveryJobId = url.searchParams.get("d");
  const attributionSignature = url.searchParams.get("s");

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

  // Delivery attribution is accepted only when (1) the signature binds this
  // delivery ID to this tracked link, and (2) the delivery belongs to the same
  // workspace, Instagram account and campaign as the link. Anything else is
  // recorded as an unattributed click; the redirect is never blocked.
  let deliveryJobId: string | null = null;
  let contactId: string | null = null;
  if (
    requestedDeliveryJobId &&
    verifyDeliveryAttribution(requestedDeliveryJobId, slug, attributionSignature)
  ) {
    const job = await prisma.deliveryJob.findUnique({
      where: { id: requestedDeliveryJobId },
      select: {
        id: true,
        contactId: true,
        workspaceId: true,
        instagramAccountId: true,
        automationId: true,
      },
    });
    if (
      job &&
      job.workspaceId === trackedLink.workspaceId &&
      job.automationId === trackedLink.automationId &&
      job.instagramAccountId === trackedLink.automation.instagramAccountId
    ) {
      deliveryJobId = job.id;
      contactId = job.contactId;
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
        deliveryJobId,
        contactId,
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
        metadata: { slug, destinationUrl: trackedLink.destinationUrl, deliveryJobId },
      });
    }
  } catch (err) {
    // Non-blocking error logging for click tracking
    console.error("[redirect][click-record-failed]", err);
  }

  return NextResponse.redirect(trackedLink.destinationUrl, { status: 302 });
}
