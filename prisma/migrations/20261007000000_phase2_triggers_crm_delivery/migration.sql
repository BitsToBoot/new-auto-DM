-- Phase 2: Production Triggers (ANY_POST, NEXT_POST, SPECIFIC_POST), Multiple Keywords, Message Variations, Contact CRM, Delivery Jobs & Attempts, Tracked Links
-- Additive and backward compatible with Phase 1 data.

-- 1. Automation updates
ALTER TABLE "Automation"
  ALTER COLUMN "postId" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "consumedPostId" TEXT,
  ADD COLUMN IF NOT EXISTS "consumedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "publicReplyMessage" TEXT;

CREATE INDEX IF NOT EXISTS "Automation_instagramAccountId_triggerScope_isActive_idx"
  ON "Automation"("instagramAccountId", "triggerScope", "isActive");

-- Backfill any missing reportShareSlug deterministically so GET /api/automations is purely read-only
UPDATE "Automation"
  SET "reportShareSlug" = md5(random()::text || id::text)
  WHERE "reportShareSlug" IS NULL;

-- 2. Normalized Keywords
CREATE TABLE IF NOT EXISTS "AutomationKeyword" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "normalizedKeyword" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationKeyword_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AutomationKeyword_automationId_normalizedKeyword_key"
  ON "AutomationKeyword"("automationId", "normalizedKeyword");
CREATE INDEX IF NOT EXISTS "AutomationKeyword_automationId_idx"
  ON "AutomationKeyword"("automationId");
CREATE INDEX IF NOT EXISTS "AutomationKeyword_normalizedKeyword_idx"
  ON "AutomationKeyword"("normalizedKeyword");

DO $$ BEGIN
  ALTER TABLE "AutomationKeyword"
    ADD CONSTRAINT "AutomationKeyword_automationId_fkey"
    FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. Message Variations
CREATE TABLE IF NOT EXISTS "AutomationMessageVariation" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationMessageVariation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AutomationMessageVariation_automationId_idx"
  ON "AutomationMessageVariation"("automationId");

DO $$ BEGIN
  ALTER TABLE "AutomationMessageVariation"
    ADD CONSTRAINT "AutomationMessageVariation_automationId_fkey"
    FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 4. Contact CRM
DO $$ BEGIN
  CREATE TYPE "ContactEventType" AS ENUM ('COMMENT', 'DM_SENT', 'PUBLIC_REPLY', 'LINK_CLICK', 'AUTOMATION_TRIGGERED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "Contact" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "instagramUserId" TEXT NOT NULL,
    "username" TEXT,
    "displayName" TEXT,
    "profilePicUrl" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastInteractionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Contact_workspaceId_instagramAccountId_instagramUserId_key"
  ON "Contact"("workspaceId", "instagramAccountId", "instagramUserId");
CREATE INDEX IF NOT EXISTS "Contact_workspaceId_lastInteractionAt_idx"
  ON "Contact"("workspaceId", "lastInteractionAt");
CREATE INDEX IF NOT EXISTS "Contact_instagramAccountId_lastInteractionAt_idx"
  ON "Contact"("instagramAccountId", "lastInteractionAt");
CREATE INDEX IF NOT EXISTS "Contact_workspaceId_username_idx"
  ON "Contact"("workspaceId", "username");

DO $$ BEGIN
  ALTER TABLE "Contact"
    ADD CONSTRAINT "Contact_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Contact"
    ADD CONSTRAINT "Contact_instagramAccountId_fkey"
    FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "ContactEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "type" "ContactEventType" NOT NULL,
    "referenceId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ContactEvent_contactId_createdAt_idx"
  ON "ContactEvent"("contactId", "createdAt");
CREATE INDEX IF NOT EXISTS "ContactEvent_workspaceId_createdAt_idx"
  ON "ContactEvent"("workspaceId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "ContactEvent"
    ADD CONSTRAINT "ContactEvent_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ContactEvent"
    ADD CONSTRAINT "ContactEvent_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 5. Delivery Jobs & Attempts
CREATE TABLE IF NOT EXISTS "DeliveryJob" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "contactId" TEXT,
    "triggerType" "TriggerType" NOT NULL DEFAULT 'COMMENT',
    "triggerId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "recipientUsername" TEXT,
    "status" "DmStatus" NOT NULL DEFAULT 'PENDING',
    "matchedKeyword" TEXT,
    "messagePayload" TEXT NOT NULL,
    "selectedVariationId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processingStartedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "metaMessageId" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DeliveryJob_automationId_triggerId_key"
  ON "DeliveryJob"("automationId", "triggerId");
CREATE INDEX IF NOT EXISTS "DeliveryJob_workspaceId_createdAt_idx"
  ON "DeliveryJob"("workspaceId", "createdAt");
CREATE INDEX IF NOT EXISTS "DeliveryJob_instagramAccountId_status_createdAt_idx"
  ON "DeliveryJob"("instagramAccountId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "DeliveryJob_automationId_createdAt_idx"
  ON "DeliveryJob"("automationId", "createdAt");
CREATE INDEX IF NOT EXISTS "DeliveryJob_status_scheduledAt_idx"
  ON "DeliveryJob"("status", "scheduledAt");
CREATE INDEX IF NOT EXISTS "DeliveryJob_recipientId_createdAt_idx"
  ON "DeliveryJob"("recipientId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "DeliveryJob"
    ADD CONSTRAINT "DeliveryJob_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "DeliveryJob"
    ADD CONSTRAINT "DeliveryJob_instagramAccountId_fkey"
    FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "DeliveryJob"
    ADD CONSTRAINT "DeliveryJob_automationId_fkey"
    FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "DeliveryJob"
    ADD CONSTRAINT "DeliveryJob_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "DeliveryJob"
    ADD CONSTRAINT "DeliveryJob_selectedVariationId_fkey"
    FOREIGN KEY ("selectedVariationId") REFERENCES "AutomationMessageVariation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "DeliveryAttempt" (
    "id" TEXT NOT NULL,
    "deliveryJobId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" "DmStatus" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "metaMessageId" TEXT,
    "errorCode" TEXT,
    "errorType" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DeliveryAttempt_deliveryJobId_attemptNumber_key"
  ON "DeliveryAttempt"("deliveryJobId", "attemptNumber");
CREATE INDEX IF NOT EXISTS "DeliveryAttempt_deliveryJobId_idx"
  ON "DeliveryAttempt"("deliveryJobId");

DO $$ BEGIN
  ALTER TABLE "DeliveryAttempt"
    ADD CONSTRAINT "DeliveryAttempt_deliveryJobId_fkey"
    FOREIGN KEY ("deliveryJobId") REFERENCES "DeliveryJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 6. TrackedLink & LinkClick updates
ALTER TABLE "TrackedLink"
  ADD COLUMN IF NOT EXISTS "active" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "LinkClick"
  ADD COLUMN IF NOT EXISTS "deliveryJobId" TEXT,
  ADD COLUMN IF NOT EXISTS "contactId" TEXT;

CREATE INDEX IF NOT EXISTS "LinkClick_deliveryJobId_idx"
  ON "LinkClick"("deliveryJobId");
CREATE INDEX IF NOT EXISTS "LinkClick_contactId_idx"
  ON "LinkClick"("contactId");

DO $$ BEGIN
  ALTER TABLE "LinkClick"
    ADD CONSTRAINT "LinkClick_deliveryJobId_fkey"
    FOREIGN KEY ("deliveryJobId") REFERENCES "DeliveryJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "LinkClick"
    ADD CONSTRAINT "LinkClick_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 7. WebhookEvent updates
ALTER TABLE "WebhookEvent"
  ADD COLUMN IF NOT EXISTS "externalEventId" TEXT,
  ADD COLUMN IF NOT EXISTS "eventType" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "WebhookEvent_externalEventId_key"
  ON "WebhookEvent"("externalEventId");
CREATE INDEX IF NOT EXISTS "WebhookEvent_createdAt_idx"
  ON "WebhookEvent"("createdAt");
