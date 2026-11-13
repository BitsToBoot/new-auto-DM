/**
 * Re-runs the idempotent DmLog -> DeliveryJob backfill and verifies coverage.
 *
 *   npm run db:backfill-deliveries
 *
 * Run after deploying the new worker, once every old worker (which still wrote
 * DmLog) has been stopped. Exits non-zero if any DmLog row is not represented
 * by a DeliveryJob, so it can gate the later migration that retires DmLog.
 */
import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.local" });

import {
  backfillDeliveryJobsFromDmLog,
  verifyDeliveryBackfill,
} from "@/lib/delivery/backfill";

async function main() {
  const affected = await backfillDeliveryJobsFromDmLog();
  console.log("Backfill statements affected rows:", affected);

  const verification = await verifyDeliveryBackfill();
  console.log("Verification:", verification);

  if (!verification.consistent) {
    console.error(`${verification.missing} DmLog row(s) have no DeliveryJob. Do not retire DmLog yet.`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("Backfill failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
