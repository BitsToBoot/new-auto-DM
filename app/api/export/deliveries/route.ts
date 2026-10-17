import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { formatCsvRow } from "@/lib/export/csv";

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const automationId = request.nextUrl.searchParams.get("automationId");
  const whereClause: any = {
    workspaceId,
    ...(automationId ? { automationId } : {}),
  };

  const headers = [
    "Delivery ID",
    "Automation Name",
    "Status",
    "Recipient ID",
    "Recipient Username",
    "Matched Keyword",
    "Attempts",
    "Created At",
    "Sent At",
    "Error",
  ];

  const BATCH_SIZE = 500;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(formatCsvRow(headers)));

        let cursor: string | undefined = undefined;
        let hasMore = true;

        while (hasMore) {
          const batch: any[] = await prisma.deliveryJob.findMany({
            where: whereClause,
            take: BATCH_SIZE,
            skip: cursor ? 1 : 0,
            cursor: cursor ? { id: cursor } : undefined,
            orderBy: { id: "asc" },
            include: {
              automation: { select: { name: true } },
            },
          });

          if (batch.length === 0) {
            hasMore = false;
            break;
          }

          let chunkText = "";
          for (const d of batch) {
            chunkText += formatCsvRow([
              d.id,
              d.automation?.name || "",
              d.status,
              d.recipientId,
              d.recipientUsername || "",
              d.matchedKeyword || "",
              d.attemptCount,
              d.createdAt?.toISOString() || "",
              d.sentAt?.toISOString() || "",
              d.lastError || "",
            ]);
          }

          controller.enqueue(encoder.encode(chunkText));
          cursor = batch[batch.length - 1].id;

          if (batch.length < BATCH_SIZE) {
            hasMore = false;
          }
        }

        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="deliveries-${Date.now()}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
