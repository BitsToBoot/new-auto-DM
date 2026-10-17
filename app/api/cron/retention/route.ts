import { NextRequest, NextResponse } from "next/server";
import { cleanupExpiredWebhookEvents } from "@/lib/ops/retention";

export async function POST(request: NextRequest) {
  // Validate CRON_SECRET if configured
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const days = searchParams.get("days") ? parseInt(searchParams.get("days")!, 10) : 30;

  try {
    const result = await cleanupExpiredWebhookEvents({ retentionDays: days });
    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
