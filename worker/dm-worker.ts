import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.local" });

import { createDMWorker } from "@/lib/queue/dm-worker";
import { recordWorkerHeartbeat } from "@/lib/ops/worker-health";
import { startDeliveryScheduler } from "@/lib/delivery/scheduler";
import os from "node:os";

const worker = createDMWorker();
// Durable recovery: re-enqueues due PENDING deliveries and unprocessed comments
// from PostgreSQL (covers Redis restarts and worker crashes), expires jobs past
// their private-reply deadline, and marks interrupted sends UNKNOWN.
const stopScheduler = startDeliveryScheduler();
const startedAt = new Date().toISOString();
const HEARTBEAT_INTERVAL_MS = 30_000;

console.log("[DM Worker] Started");

async function heartbeat() {
  try {
    await recordWorkerHeartbeat({
      pid: process.pid,
      hostname: os.hostname(),
      startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Heartbeat failed:", message);
  }
}

void heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);

async function shutdown(signal: string) {
  console.log(`[DM Worker] ${signal} received, closing worker`);
  clearInterval(heartbeatTimer);
  stopScheduler();
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
