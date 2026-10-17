import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { formatCsvRow } from "@/lib/export/csv";

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const instagramAccountId = request.nextUrl.searchParams.get("instagramAccountId");
  const whereClause: any = {
    workspaceId,
    ...(instagramAccountId && instagramAccountId !== "all" ? { instagramAccountId } : {}),
  };

  const headers = [
    "Contact ID",
    "Instagram User ID",
    "Username",
    "Display Name",
    "Account",
    "First Seen At",
    "Last Seen At",
    "Last Interaction At",
  ];

  const BATCH_SIZE = 500;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Write CSV header
        controller.enqueue(encoder.encode(formatCsvRow(headers)));

        let cursor: string | undefined = undefined;
        let hasMore = true;

        while (hasMore) {
          const batch: any[] = await prisma.contact.findMany({
            where: whereClause,
            take: BATCH_SIZE,
            skip: cursor ? 1 : 0,
            cursor: cursor ? { id: cursor } : undefined,
            orderBy: { id: "asc" },
            include: {
              instagramAccount: {
                select: { username: true },
              },
            },
          });

          if (batch.length === 0) {
            hasMore = false;
            break;
          }

          let chunkText = "";
          for (const c of batch) {
            chunkText += formatCsvRow([
              c.id,
              c.instagramUserId,
              c.username || "",
              c.displayName || "",
              c.instagramAccount?.username || "",
              c.firstSeenAt?.toISOString() || "",
              c.lastSeenAt?.toISOString() || "",
              c.lastInteractionAt?.toISOString() || "",
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
      "Content-Disposition": `attachment; filename="contacts-${Date.now()}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
