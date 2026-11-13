import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateAndNormalizeKeywords,
  normalizeKeyword,
  matchCommentAgainstKeywords,
  MAX_KEYWORDS_PER_AUTOMATION,
} from "@/lib/automation/matcher";
import {
  selectWinningAutomation,
  CandidateAutomation,
  MatchedAutomationResult,
} from "@/lib/automation/policy";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    automation: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

import {
  claimNextPostAutomation,
  resolveAutomationForComment,
} from "@/lib/automation/resolver";

describe("Phase 2 — Keyword Normalization & Validation", () => {
  it("normalizes keywords deterministically by stripping emojis, lowercase and whitespace", () => {
    expect(normalizeKeyword("  🔥 VIP Access!  ")).toBe("vip access");
    expect(normalizeKeyword("DISCOUNT20")).toBe("discount20");
    expect(normalizeKeyword("hello   world")).toBe("hello world");
  });

  it("enforces maximum 20 keywords server-side", () => {
    const twentyKeywords = Array.from({ length: 20 }, (_, i) => `keyword${i + 1}`);
    const validResult = validateAndNormalizeKeywords(twentyKeywords);
    expect(validResult.valid).toBe(true);
    expect(validResult.keywords.length).toBe(20);

    const twentyOneKeywords = [...twentyKeywords, "keyword21"];
    const invalidResult = validateAndNormalizeKeywords(twentyOneKeywords);
    expect(invalidResult.valid).toBe(false);
    expect(invalidResult.error).toContain(`at most ${MAX_KEYWORDS_PER_AUTOMATION} keywords`);
  });

  it("rejects duplicate keywords that normalize to the same value", () => {
    const duplicates = ["PROMO", "promo", " Promo! "];
    const result = validateAndNormalizeKeywords(duplicates);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Duplicate keyword detected");
  });

  it("matches keywords with whole-word or partial matching", () => {
    const keywords = ["link", "discount"];
    expect(matchCommentAgainstKeywords("Send me the link please!", keywords, true).matched).toBe(true);
    expect(matchCommentAgainstKeywords("Send me the link please!", keywords, true).matchedKeyword).toBe("link");
    expect(matchCommentAgainstKeywords("Blink and you miss it", keywords, true).matched).toBe(false);
    expect(matchCommentAgainstKeywords("Blink and you miss it", keywords, false).matched).toBe(true);
  });
});

describe("Phase 2 — Automation Priority & Deterministic Winner Selection", () => {
  it("selects SPECIFIC_POST over NEXT_POST and ANY_POST", () => {
    const specific: CandidateAutomation = {
      id: "auto_specific",
      workspaceId: "ws_1",
      instagramAccountId: "acc_1",
      triggerType: "COMMENT",
      triggerScope: "SPECIFIC_POST",
      postId: "media_123",
      keywords: ["LINK"],
      dmMessage: "Specific message",
      isActive: true,
      wholeWordMatch: true,
      createdAt: new Date("2026-06-01T10:00:00Z"),
    };

    const next: CandidateAutomation = {
      id: "auto_next",
      workspaceId: "ws_1",
      instagramAccountId: "acc_1",
      triggerType: "COMMENT",
      triggerScope: "NEXT_POST",
      consumedPostId: "media_123",
      keywords: ["LINK"],
      dmMessage: "Next message",
      isActive: true,
      wholeWordMatch: true,
      createdAt: new Date("2026-05-01T10:00:00Z"),
    };

    const anyPost: CandidateAutomation = {
      id: "auto_any",
      workspaceId: "ws_1",
      instagramAccountId: "acc_1",
      triggerType: "COMMENT",
      triggerScope: "ANY_POST",
      keywords: ["LINK"],
      dmMessage: "Any message",
      isActive: true,
      wholeWordMatch: true,
      createdAt: new Date("2026-04-01T10:00:00Z"),
    };

    const matches: MatchedAutomationResult[] = [
      { automation: anyPost, matchedKeyword: "LINK" },
      { automation: next, matchedKeyword: "LINK" },
      { automation: specific, matchedKeyword: "LINK" },
    ];

    const winner = selectWinningAutomation(matches);
    expect(winner?.automation.id).toBe("auto_specific");
  });

  it("selects NEXT_POST over ANY_POST when no specific post rule exists", () => {
    const next: CandidateAutomation = {
      id: "auto_next",
      workspaceId: "ws_1",
      instagramAccountId: "acc_1",
      triggerType: "COMMENT",
      triggerScope: "NEXT_POST",
      consumedPostId: "media_123",
      keywords: ["LINK"],
      dmMessage: "Next message",
      isActive: true,
      wholeWordMatch: true,
      createdAt: new Date("2026-05-01T10:00:00Z"),
    };

    const anyPost: CandidateAutomation = {
      id: "auto_any",
      workspaceId: "ws_1",
      instagramAccountId: "acc_1",
      triggerType: "COMMENT",
      triggerScope: "ANY_POST",
      keywords: ["LINK"],
      dmMessage: "Any message",
      isActive: true,
      wholeWordMatch: true,
      createdAt: new Date("2026-04-01T10:00:00Z"),
    };

    const winner = selectWinningAutomation([
      { automation: anyPost, matchedKeyword: "LINK" },
      { automation: next, matchedKeyword: "LINK" },
    ]);
    expect(winner?.automation.id).toBe("auto_next");
  });

  it("breaks ties deterministically using oldest createdAt", () => {
    const older: CandidateAutomation = {
      id: "auto_older",
      workspaceId: "ws_1",
      instagramAccountId: "acc_1",
      triggerType: "COMMENT",
      triggerScope: "ANY_POST",
      keywords: ["LINK"],
      dmMessage: "Older message",
      isActive: true,
      wholeWordMatch: true,
      createdAt: new Date("2026-01-01T10:00:00Z"),
    };

    const newer: CandidateAutomation = {
      id: "auto_newer",
      workspaceId: "ws_1",
      instagramAccountId: "acc_1",
      triggerType: "COMMENT",
      triggerScope: "ANY_POST",
      keywords: ["LINK"],
      dmMessage: "Newer message",
      isActive: true,
      wholeWordMatch: true,
      createdAt: new Date("2026-02-01T10:00:00Z"),
    };

    const winner = selectWinningAutomation([
      { automation: newer, matchedKeyword: "LINK" },
      { automation: older, matchedKeyword: "LINK" },
    ]);
    expect(winner?.automation.id).toBe("auto_older");
  });
});

describe("Phase 2 — NEXT_POST Atomic Claim Concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("claims the unconsumed post atomically with count 1", async () => {
    mockPrisma.automation.updateMany.mockResolvedValue({ count: 1 });

    const publishedAt = new Date("2026-05-02T10:00:00.000Z");
    const claimed = await claimNextPostAutomation("auto_next_1", "media_999", publishedAt);
    expect(claimed).toBe(true);
    expect(mockPrisma.automation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "auto_next_1",
        triggerScope: "NEXT_POST",
        isActive: true,
        consumedPostId: null,
        // Never let a post published before the campaign consume it.
        createdAt: { lte: new Date(publishedAt.getTime() + 999) },
      },
      data: {
        consumedPostId: "media_999",
        consumedAt: expect.any(Date),
      },
    });
  });

  it("rejects claim when concurrent worker already claimed the post (count 0)", async () => {
    mockPrisma.automation.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.automation.findUnique.mockResolvedValue({ consumedPostId: "media_other" });

    const claimed = await claimNextPostAutomation("auto_next_1", "media_999", new Date());
    expect(claimed).toBe(false);
  });

  it("treats a concurrent claim by the SAME media as a win", async () => {
    mockPrisma.automation.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.automation.findUnique.mockResolvedValue({ consumedPostId: "media_999" });

    expect(await claimNextPostAutomation("auto_next_1", "media_999", new Date())).toBe(true);
  });

  it("resolves automation for comment across SPECIFIC, NEXT, and ANY triggers", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        id: "auto_any_1",
        workspaceId: "ws_1",
        instagramAccountId: "acc_1",
        triggerType: "COMMENT",
        triggerScope: "ANY_POST",
        keywords: ["DISCOUNT"],
        dmMessage: "Discount info",
        isActive: true,
        wholeWordMatch: true,
        createdAt: new Date("2026-05-01"),
        keywordsList: [{ keyword: "DISCOUNT", normalizedKeyword: "discount" }],
        variations: [],
        trackedLinks: [],
      },
    ]);

    const getMediaPublishedAt = vi.fn();
    const result = await resolveAutomationForComment({
      instagramAccountId: "acc_1",
      mediaId: "post_888",
      commentText: "Give me the discount!",
      getMediaPublishedAt,
    });
    // No NEXT_POST candidate: the media publish time is never fetched.
    expect(getMediaPublishedAt).not.toHaveBeenCalled();

    expect(result).not.toBeNull();
    expect(result?.automation.id).toBe("auto_any_1");
    expect(result?.matchedKeyword).toBe("DISCOUNT");
  });
});
