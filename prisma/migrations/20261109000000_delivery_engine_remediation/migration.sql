-- Delivery engine remediation
-- Stage B: additive columns/tables only. Nothing is dropped; DmLog is kept.
-- Stage C: idempotent DmLog -> DeliveryJob backfill. The statements below are
-- kept identical to lib/delivery/backfill.ts (enforced by a test) and can be
-- re-run with: npm run db:backfill-deliveries

-- CreateEnum
CREATE TYPE "InstagramAccountStatus" AS ENUM ('CONNECTED', 'DISCONNECTING', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "InboundCommentStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED');

-- AlterEnum
ALTER TYPE "DmStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

-- AlterTable
ALTER TABLE "InstagramAccount" ADD COLUMN     "disconnectReason" TEXT,
ADD COLUMN     "disconnectedAt" TIMESTAMP(3),
ADD COLUMN     "status" "InstagramAccountStatus" NOT NULL DEFAULT 'CONNECTED',
ADD COLUMN     "webhookUnsubscribeError" TEXT,
ADD COLUMN     "webhookUnsubscribedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DeliveryJob" ADD COLUMN     "commentText" TEXT,
ADD COLUMN     "commentedAt" TIMESTAMP(3),
ADD COLUMN     "deadlineAt" TIMESTAMP(3),
ADD COLUMN     "dedupKey" TEXT,
ADD COLUMN     "dedupOfDeliveryJobId" TEXT,
ADD COLUMN     "errorCode" TEXT,
ADD COLUMN     "legacyDmLogId" TEXT,
ADD COLUMN     "mediaId" TEXT,
ADD COLUMN     "rateLimitDeferrals" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "InboundComment" (
    "id" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "commenterId" TEXT NOT NULL,
    "commenterUsername" TEXT,
    "commentText" TEXT NOT NULL,
    "commentedAt" TIMESTAMP(3) NOT NULL,
    "status" "InboundCommentStatus" NOT NULL DEFAULT 'RECEIVED',
    "outcome" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "InboundComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InboundComment_status_receivedAt_idx" ON "InboundComment"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboundComment_instagramAccountId_commentId_key" ON "InboundComment"("instagramAccountId", "commentId");

-- CreateIndex
CREATE INDEX "InstagramAccount_workspaceId_status_idx" ON "InstagramAccount"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryJob_dedupKey_key" ON "DeliveryJob"("dedupKey");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryJob_legacyDmLogId_key" ON "DeliveryJob"("legacyDmLogId");

-- CreateIndex
CREATE INDEX "DeliveryJob_status_deadlineAt_idx" ON "DeliveryJob"("status", "deadlineAt");

-- CreateIndex
CREATE INDEX "DeliveryJob_workspaceId_status_createdAt_idx" ON "DeliveryJob"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "DeliveryJob_workspaceId_sentAt_idx" ON "DeliveryJob"("workspaceId", "sentAt");

-- Backfill step 1
UPDATE "DeliveryJob" AS dj
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
  AND (dj."legacyDmLogId" IS NULL OR dj."commentText" IS NULL);

-- Backfill step 2
INSERT INTO "DeliveryJob" (
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
ON CONFLICT DO NOTHING;

-- Backfill step 3
UPDATE "DeliveryJob"
SET "deadlineAt" = COALESCE("commentedAt", "createdAt") + INTERVAL '7 days' - INTERVAL '1 hour'
WHERE "deadlineAt" IS NULL;

-- Backfill step 4
WITH ranked AS (
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
  );

-- Backfill step 5
UPDATE "DeliveryJob" AS dj
SET "status" = 'SKIPPED_DEDUP',
    "dedupOfDeliveryJobId" = keeper."id",
    "lastError" = 'Duplicate recipient for this campaign (closed during DeliveryJob migration)'
FROM "DeliveryJob" AS keeper
WHERE keeper."dedupKey" = dj."automationId" || ':' || dj."recipientId"
  AND keeper."id" <> dj."id"
  AND dj."status" = 'PENDING'
  AND dj."dedupKey" IS NULL;
