import { prisma } from "@/lib/db/client";
import { matchCommentAgainstKeywords } from "@/lib/automation/matcher";
import {
  CandidateAutomation,
  MatchedAutomationResult,
  selectWinningAutomation,
} from "@/lib/automation/policy";

export interface ResolveAutomationInput {
  instagramAccountId: string;
  mediaId: string;
  commentText: string;
}

/**
 * Atomically attempts to claim an unconsumed NEXT_POST automation for this mediaId.
 * Concurrency-safe: only one worker can set consumedPostId for this automation.
 */
export async function claimNextPostAutomation(
  automationId: string,
  mediaId: string
): Promise<boolean> {
  const result = await prisma.automation.updateMany({
    where: {
      id: automationId,
      triggerScope: "NEXT_POST",
      isActive: true,
      consumedPostId: null,
    },
    data: {
      consumedPostId: mediaId,
      consumedAt: new Date(),
    },
  });

  return result.count > 0;
}

/**
 * Resolves the single winning automation for a comment on a media item.
 * Evaluates SPECIFIC_POST, NEXT_POST (with atomic DB claim), and ANY_POST.
 */
export async function resolveAutomationForComment(
  input: ResolveAutomationInput
): Promise<MatchedAutomationResult | null> {
  const { instagramAccountId, mediaId, commentText } = input;

  // Retrieve candidate automations for this Instagram account
  // 1. SPECIFIC_POST / SPECIFIC_MEDIA matching mediaId
  // 2. NEXT_POST (either unconsumed or already consumed by this mediaId)
  // 3. ANY_POST
  const automations = await prisma.automation.findMany({
    where: {
      instagramAccountId,
      isActive: true,
      OR: [
        {
          triggerScope: { in: ["SPECIFIC_POST", "SPECIFIC_MEDIA"] },
          postId: mediaId,
        },
        {
          triggerScope: "NEXT_POST",
          OR: [{ consumedPostId: null }, { consumedPostId: mediaId }],
        },
        {
          triggerScope: "ANY_POST",
        },
      ],
    },
    include: {
      keywordsList: {
        select: { keyword: true, normalizedKeyword: true },
      },
      variations: {
        where: { isActive: true },
        select: { id: true, message: true, isActive: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  if (!automations || automations.length === 0) {
    return null;
  }

  const matches: MatchedAutomationResult[] = [];

  for (const auto of automations) {
    // If NEXT_POST and not yet consumed, attempt atomic claim
    if (auto.triggerScope === "NEXT_POST" && !auto.consumedPostId) {
      const claimed = await claimNextPostAutomation(auto.id, mediaId);
      if (!claimed) {
        // Double check if another worker claimed it for THIS SAME mediaId
        const recheck = await prisma.automation.findUnique({
          where: { id: auto.id },
          select: { consumedPostId: true },
        });
        if (recheck?.consumedPostId !== mediaId) {
          // Claimed by a different post, skip
          continue;
        }
      }
    }

    // Match keywords: prioritize normalized keywordsList if available, fallback to keywords array
    const candidateKeywords =
      auto.keywordsList && auto.keywordsList.length > 0
        ? auto.keywordsList.map((k: any) => k.keyword)
        : auto.keywords;

    const { matched, matchedKeyword } = matchCommentAgainstKeywords(
      commentText,
      candidateKeywords,
      auto.wholeWordMatch
    );

    if (matched && matchedKeyword) {
      matches.push({
        automation: auto as CandidateAutomation,
        matchedKeyword,
      });
    }
  }

  return selectWinningAutomation(matches);
}
