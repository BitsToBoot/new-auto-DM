import { prisma } from "@/lib/db/client";

/**
 * DmLog -> DeliveryJob backfill (Stage C of the DmLog retirement).
 *
 * Every statement is idempotent, so the backfill can be re-run safely, for
 * example after old workers that still wrote DmLog have been drained during a
 * rolling deploy. The same statements are embedded in the
 * `20261109000000_delivery_engine_remediation` migration; a test keeps the two
 * in sync.
 *
 * Rules:
 * - Comment context (text, sent time) is copied onto existing DeliveryJobs.
 * - Where DmLog and DeliveryJob drifted, DmLog wins when it recorded SENT or
 *   when DeliveryJob was still non-terminal (DeliveryJob writes used to be
 *   silently swallowed, DmLog writes were not).
 * - DmLog rows without a DeliveryJob are inserted. Their message text was never
 *   stored, so legacy PENDING rows are closed as FAILED and legacy SENDING rows
 *   as UNKNOWN: they are never auto-sent by the new engine.
 * - Active jobs get a dedupKey (one per campaign + recipient); surplus PENDING
 *   duplicates are closed as SKIPPED_DEDUP so they can never be sent.
 */
export const DELIVERY_BACKFILL_STATEMENTS: readonly string[] = [
  `UPDATE "DeliveryJob" AS dj
SET "commentText" = COALESCE(dj."commentText", dl."commentText"),
    "legacyDmLogId" = COALESCE(dj."legacyDmLogId", dl."id"),
    "sentAt" = COALESCE(dj."sentAt", dl."dmSentAt"),
    "status" = CASE
      WHEN dl."status" <> dj."status"
        AND (dl."status" = 'SENT' OR dj."status" IN ('PENDING', 'SENDING'))
      THEN dl."status"
      ELSE dj."status"
    END,
    "lastError" = COALESCE(dj."lastError", dl."errorMessage")
FROM "DmLog" AS dl
WHERE dj."automationId" = dl."automationId"
  AND dj."triggerId" = dl."commentId"
  AND (dj."legacyDmLogId" IS NULL OR dj."commentText" IS NULL)`,

  `INSERT INTO "DeliveryJob" (
  "id", "workspaceId", "instagramAccountId", "automationId", "triggerType",
  "triggerId", "recipientId", "recipientUsername", "status", "matchedKeyword",
  "messagePayload", "attemptCount", "scheduledAt", "sentAt", "lastError",
  "createdAt", "updatedAt", "commentText", "legacyDmLogId"
)
SELECT
  'legacy_' || dl."id", dl."workspaceId", dl."instagramAccountId", dl."automationId", 'COMMENT',
  dl."commentId", dl."commenterId", dl."commenterName",
  CASE dl."status"
    WHEN 'PENDING' THEN 'FAILED'::"DmStatus"
    WHEN 'SENDING' THEN 'UNKNOWN'::"DmStatus"
    ELSE dl."status"
  END,
  dl."matchedKeyword",
  '', dl."attempts", dl."createdAt", dl."dmSentAt",
  CASE dl."status"
    WHEN 'PENDING' THEN 'Legacy pending DmLog record; not migrated for automatic delivery'
    WHEN 'SENDING' THEN 'Legacy in-flight DmLog record; outcome unknown'
    ELSE dl."errorMessage"
  END,
  dl."createdAt", dl."updatedAt", dl."commentText", dl."id"
FROM "DmLog" AS dl
WHERE NOT EXISTS (
  SELECT 1 FROM "DeliveryJob" AS dj
  WHERE dj."automationId" = dl."automationId" AND dj."triggerId" = dl."commentId"
)
ON CONFLICT DO NOTHING`,

  `UPDATE "DeliveryJob"
SET "deadlineAt" = COALESCE("commentedAt", "createdAt") + INTERVAL '7 days' - INTERVAL '1 hour'
WHERE "deadlineAt" IS NULL`,

  `WITH ranked AS (
  SELECT "id", "automationId", "recipientId",
    ROW_NUMBER() OVER (
      PARTITION BY "automationId", "recipientId"
      ORDER BY CASE "status"
        WHEN 'SENT' THEN 0 WHEN 'UNKNOWN' THEN 1 WHEN 'SENDING' THEN 2 ELSE 3
      END, "createdAt", "id"
    ) AS rn
  FROM "DeliveryJob"
  WHERE "status" IN ('PENDING', 'SENDING', 'SENT', 'UNKNOWN')
)
UPDATE "DeliveryJob" AS dj
SET "dedupKey" = dj."automationId" || ':' || dj."recipientId"
FROM ranked
WHERE ranked."id" = dj."id"
  AND ranked.rn = 1
  AND dj."dedupKey" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "DeliveryJob" AS other
    WHERE other."dedupKey" = dj."automationId" || ':' || dj."recipientId"
  )`,

  `UPDATE "DeliveryJob" AS dj
SET "status" = 'SKIPPED_DEDUP',
    "dedupOfDeliveryJobId" = keeper."id",
    "lastError" = 'Duplicate recipient for this campaign (closed during DeliveryJob migration)'
FROM "DeliveryJob" AS keeper
WHERE keeper."dedupKey" = dj."automationId" || ':' || dj."recipientId"
  AND keeper."id" <> dj."id"
  AND dj."status" = 'PENDING'
  AND dj."dedupKey" IS NULL`,
];

export interface DeliveryBackfillVerification {
  dmLogRows: number;
  dmLogRowsWithDeliveryJob: number;
  missing: number;
  consistent: boolean;
}

/** Runs the idempotent backfill statements in order. */
export async function backfillDeliveryJobsFromDmLog(): Promise<number[]> {
  const affected: number[] = [];
  for (const statement of DELIVERY_BACKFILL_STATEMENTS) {
    affected.push(await prisma.$executeRawUnsafe(statement));
  }
  return affected;
}

/**
 * Stage E: verifies every DmLog row is represented by a DeliveryJob. DmLog may
 * only be retired once `consistent` is true in production.
 */
export async function verifyDeliveryBackfill(): Promise<DeliveryBackfillVerification> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ total: bigint | number; covered: bigint | number }>
  >(`SELECT
  (SELECT COUNT(*) FROM "DmLog") AS total,
  (SELECT COUNT(*) FROM "DmLog" AS dl WHERE EXISTS (
    SELECT 1 FROM "DeliveryJob" AS dj
    WHERE dj."automationId" = dl."automationId" AND dj."triggerId" = dl."commentId"
  )) AS covered`);

  const total = Number(rows[0]?.total ?? 0);
  const covered = Number(rows[0]?.covered ?? 0);
  return {
    dmLogRows: total,
    dmLogRowsWithDeliveryJob: covered,
    missing: total - covered,
    consistent: total === covered,
  };
}
