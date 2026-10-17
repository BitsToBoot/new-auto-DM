import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  renderDmMessage,
  selectMessageVariation,
} from "@/lib/delivery/renderer";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    deliveryJob: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    deliveryAttempt: {
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

import { claimDeliveryJob } from "@/lib/delivery/claim";
import {
  transitionToSent,
  transitionToUnknown,
  transitionToRetryable,
} from "@/lib/delivery/state";

describe("Phase 2 — Message Variations & Rendering", () => {
  it("renders {username}, {name}, and {link} placeholders deterministically", () => {
    const template = "Hey {username} ({name})! Click here: {link}";
    const rendered = renderDmMessage(template, {
      username: "alex99",
      displayName: "Alex Johnson",
      trackedUrl: "https://campaigncue.com/r/xyz123",
    });

    expect(rendered).toBe("Hey @alex99 (Alex Johnson)! Click here: https://campaigncue.com/r/xyz123");
  });

  it("falls back gracefully when placeholders are not provided", () => {
    const template = "Hey {name}! Hope you like this.";
    const rendered = renderDmMessage(template, {});
    expect(rendered).toBe("Hey friend! Hope you like this.");
  });

  it("selects only active variations and ignores inactive ones", () => {
    const variations = [
      { id: "var_1", message: "Active Variation", isActive: true },
      { id: "var_2", message: "Inactive Variation", isActive: false },
    ];

    const selected = selectMessageVariation(variations, "Fallback default");
    expect(selected.variationId).toBe("var_1");
    expect(selected.template).toBe("Active Variation");
  });

  it("falls back to default automation.dmMessage if no active variations exist", () => {
    const variations = [
      { id: "var_2", message: "Inactive Variation", isActive: false },
    ];

    const selected = selectMessageVariation(variations, "Fallback default");
    expect(selected.variationId).toBeNull();
    expect(selected.template).toBe("Fallback default");
  });
});

describe("Phase 2 — Delivery Job & Retry Message Stability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists selected variation in delivery job upon initial claim", async () => {
    mockPrisma.deliveryJob.findUnique.mockResolvedValue(null);
    mockPrisma.deliveryJob.create.mockResolvedValue({
      id: "job_new_1",
      automationId: "auto_1",
      triggerId: "comment_1",
      messagePayload: "Rendered message variation A",
      selectedVariationId: "var_A",
      status: "PENDING",
      attemptCount: 0,
    });
    mockPrisma.deliveryJob.updateMany.mockResolvedValue({ count: 1 });

    const outcome = await claimDeliveryJob({
      workspaceId: "ws_1",
      instagramAccountId: "acc_1",
      automation: {
        id: "auto_1",
        workspaceId: "ws_1",
        instagramAccountId: "acc_1",
        triggerType: "COMMENT",
        triggerScope: "SPECIFIC_POST",
        keywords: ["VIP"],
        dmMessage: "Fallback DM",
        isActive: true,
        wholeWordMatch: true,
        createdAt: new Date(),
        variations: [
          { id: "var_A", message: "Rendered message variation A", isActive: true },
        ],
      },
      commentId: "comment_1",
      commenterId: "user_1",
      commenterName: "alex",
      commentText: "VIP",
      matchedKeyword: "VIP",
    });

    expect(outcome.success).toBe(true);
    expect(mockPrisma.deliveryJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          selectedVariationId: "var_A",
          messagePayload: "Rendered message variation A",
          status: "PENDING",
        }),
      })
    );
  });

  it("reuses the exact same persisted message on retry without re-selecting a variation", async () => {
    const existingJob = {
      id: "job_retry_1",
      automationId: "auto_1",
      triggerId: "comment_1",
      messagePayload: "Original Persisted Variation B",
      selectedVariationId: "var_B",
      status: "FAILED",
      attemptCount: 1,
    };

    mockPrisma.deliveryJob.findUnique.mockResolvedValue(existingJob);
    mockPrisma.deliveryJob.updateMany.mockResolvedValue({ count: 1 });

    const outcome = await claimDeliveryJob({
      workspaceId: "ws_1",
      instagramAccountId: "acc_1",
      automation: {
        id: "auto_1",
        workspaceId: "ws_1",
        instagramAccountId: "acc_1",
        triggerType: "COMMENT",
        triggerScope: "SPECIFIC_POST",
        keywords: ["VIP"],
        dmMessage: "Fallback DM",
        isActive: true,
        wholeWordMatch: true,
        createdAt: new Date(),
        variations: [
          { id: "var_A", message: "Different variation A", isActive: true },
          { id: "var_B", message: "Different variation B", isActive: true },
        ],
      },
      commentId: "comment_1",
      commenterId: "user_1",
      commenterName: "alex",
      commentText: "VIP",
      matchedKeyword: "VIP",
    });

    expect(outcome.success).toBe(true);
    // Never calls create on retry
    expect(mockPrisma.deliveryJob.create).not.toHaveBeenCalled();
    // Claimed deliveryJob retains the original messagePayload
    if (outcome.success) {
      expect(outcome.deliveryJob.messagePayload).toBe("Original Persisted Variation B");
    }
  });

  it("records delivery attempts on state transitions", async () => {
    mockPrisma.deliveryJob.update.mockResolvedValue({});
    mockPrisma.deliveryAttempt.create.mockResolvedValue({});

    await transitionToSent("job_123", "meta_msg_999", 1, new Date());
    expect(mockPrisma.deliveryJob.update).toHaveBeenCalledWith({
      where: { id: "job_123" },
      data: expect.objectContaining({ status: "SENT", metaMessageId: "meta_msg_999" }),
    });
    expect(mockPrisma.deliveryAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        deliveryJobId: "job_123",
        status: "SENT",
        metaMessageId: "meta_msg_999",
      }),
    });

    await transitionToUnknown("job_123", 2, "Network timeout", undefined, new Date());
    expect(mockPrisma.deliveryJob.update).toHaveBeenCalledWith({
      where: { id: "job_123" },
      data: expect.objectContaining({ status: "UNKNOWN" }),
    });

    await transitionToRetryable("job_123", 2, "500 Server error", "500", new Date());
    expect(mockPrisma.deliveryJob.update).toHaveBeenCalledWith({
      where: { id: "job_123" },
      data: expect.objectContaining({ status: "PENDING" }),
    });
  });
});
