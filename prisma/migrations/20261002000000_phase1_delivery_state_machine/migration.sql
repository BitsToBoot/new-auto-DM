-- Phase 1: Delivery state machine + webhook lifecycle + trigger model
-- All changes are ADDITIVE. No existing data is modified or dropped.

-- 1. Extend DmStatus with delivery-safety states
ALTER TYPE "DmStatus" ADD VALUE IF NOT EXISTS 'SENDING';
ALTER TYPE "DmStatus" ADD VALUE IF NOT EXISTS 'UNKNOWN';

-- 2. Extend WebhookStatus with an explicit QUEUED state
ALTER TYPE "WebhookStatus" ADD VALUE IF NOT EXISTS 'QUEUED';

-- 3. Trigger-type enum for extensible automation triggers
DO $$ BEGIN
  CREATE TYPE "TriggerType" AS ENUM ('COMMENT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 4. Add trigger fields to Automation (Phase 1 defaults match all existing rows)
ALTER TABLE "Automation"
  ADD COLUMN IF NOT EXISTS "triggerType"  "TriggerType" NOT NULL DEFAULT 'COMMENT',
  ADD COLUMN IF NOT EXISTS "triggerScope" TEXT NOT NULL DEFAULT 'SPECIFIC_MEDIA';

-- 5. Composite index for the worker's primary automation lookup:
--    WHERE "instagramAccountId" = $1 AND "postId" = $2 AND "isActive" = true
--    This replaces the two narrower single-column indexes below.
CREATE INDEX IF NOT EXISTS "Automation_instagramAccountId_postId_isActive_idx"
  ON "Automation"("instagramAccountId", "postId", "isActive");

-- Drop the now-redundant single-column indexes (covered by the composite above)
DROP INDEX IF EXISTS "Automation_instagramAccountId_idx";
DROP INDEX IF EXISTS "Automation_postId_idx";
