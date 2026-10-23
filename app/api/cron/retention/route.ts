import { NextRequest, NextResponse } from "next/server";
import { cleanupExpiredWebhookEvents } from "@/lib/ops/retention";

const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 365;

async function handleRetention(request: NextRequest) {
  // Validate CRON_SECRET — fail closed in production when unset
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json(
        { error: "CRON_SECRET not configured" },
        { status: 401 }
      );
    }
    // In development, allow unauthenticated access when CRON_SECRET is not set
  } else if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const rawDays = searchParams.get("days");
  let days = 30;

  if (rawDays !== null) {
    days = parseInt(rawDays, 10);
    if (isNaN(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
      return NextResponse.json(
        { error: `days must be an integer between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}` },
        { status: 400 }
      );
    }
  }

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

export async function GET(request: NextRequest) {
  return handleRetention(request);
}

export async function POST(request: NextRequest) {
  return handleRetention(request);
}
