import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    contact: {
      upsert: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
    },
    contactEvent: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

import { upsertContact, recordContactEvent } from "@/lib/crm/contacts";

describe("Phase 2 — Contact CRM", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("idempotently creates or updates contact scoped by workspace + account + igUser", async () => {
    const mockContact = {
      id: "contact_1",
      workspaceId: "ws_alpha",
      instagramAccountId: "acc_beta",
      instagramUserId: "user_gamma",
      username: "creative_artist",
      displayName: "Creative Artist",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      lastInteractionAt: new Date(),
    };

    mockPrisma.contact.upsert.mockResolvedValue(mockContact);

    const contact = await upsertContact({
      workspaceId: "ws_alpha",
      instagramAccountId: "acc_beta",
      instagramUserId: "user_gamma",
      username: "creative_artist",
      displayName: "Creative Artist",
    });

    expect(contact.id).toBe("contact_1");
    expect(mockPrisma.contact.upsert).toHaveBeenCalledWith({
      where: {
        workspaceId_instagramAccountId_instagramUserId: {
          workspaceId: "ws_alpha",
          instagramAccountId: "acc_beta",
          instagramUserId: "user_gamma",
        },
      },
      create: expect.objectContaining({
        workspaceId: "ws_alpha",
        instagramAccountId: "acc_beta",
        instagramUserId: "user_gamma",
        username: "creative_artist",
      }),
      update: expect.objectContaining({
        lastSeenAt: expect.any(Date),
        lastInteractionAt: expect.any(Date),
        username: "creative_artist",
      }),
    });
  });

  it("records contact events for CRM interaction history", async () => {
    mockPrisma.contactEvent.create.mockResolvedValue({ id: "evt_1" });

    await recordContactEvent({
      workspaceId: "ws_alpha",
      contactId: "contact_1",
      instagramAccountId: "acc_beta",
      type: "AUTOMATION_TRIGGERED",
      referenceId: "comment_123",
      metadata: { keyword: "INFO" },
    });

    expect(mockPrisma.contactEvent.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "ws_alpha",
        contactId: "contact_1",
        instagramAccountId: "acc_beta",
        type: "AUTOMATION_TRIGGERED",
        referenceId: "comment_123",
        metadata: { keyword: "INFO" },
      },
    });
  });
});
