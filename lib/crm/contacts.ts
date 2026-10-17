import { prisma } from "@/lib/db/client";
import { ContactEventType } from "@/app/generated/prisma/client";

export interface UpsertContactInput {
  workspaceId: string;
  instagramAccountId: string;
  instagramUserId: string;
  username?: string | null;
  displayName?: string | null;
}

export interface RecordContactEventInput {
  workspaceId: string;
  contactId: string;
  instagramAccountId: string;
  type: ContactEventType;
  referenceId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Idempotently resolves or creates a contact for a workspace + account + IG user.
 * Updates lastSeenAt and lastInteractionAt on interaction.
 */
export async function upsertContact(input: UpsertContactInput) {
  const { workspaceId, instagramAccountId, instagramUserId, username, displayName } = input;
  const now = new Date();

  return prisma.contact.upsert({
    where: {
      workspaceId_instagramAccountId_instagramUserId: {
        workspaceId,
        instagramAccountId,
        instagramUserId,
      },
    },
    create: {
      workspaceId,
      instagramAccountId,
      instagramUserId,
      username: username || null,
      displayName: displayName || null,
      firstSeenAt: now,
      lastSeenAt: now,
      lastInteractionAt: now,
    },
    update: {
      lastSeenAt: now,
      lastInteractionAt: now,
      ...(username ? { username } : {}),
      ...(displayName ? { displayName } : {}),
    },
  });
}

/**
 * Records a contact event in the CRM audit trail.
 */
export async function recordContactEvent(input: RecordContactEventInput) {
  const { workspaceId, contactId, instagramAccountId, type, referenceId, metadata } = input;

  return prisma.contactEvent.create({
    data: {
      workspaceId,
      contactId,
      instagramAccountId,
      type,
      referenceId: referenceId || null,
      metadata: metadata ? (metadata as any) : undefined,
    },
  });
}
