import { prisma } from "@/lib/db/client";
import { matchCommentAgainstKeywords } from "@/lib/automation/matcher";
import {
  CandidateAutomation,
  MatchedAutomationResult,
  getScopePriority,
  sortMatchesByPriority,
} from "@/lib/automation/policy";

/**
 * Canonical campaign resolver. The DM worker and every other processing path
 * use `resolveAutomationForComment`; there is no second matching
 * implementation.
 *
 * Rules:
 * 1. Candidates are active campaigns of the given (internal) Instagram account.
 * 2. Keywords come from the canonical normalized `keywordsList`. The legacy
 *    `keywords` array is used only for rows created before keywordsList
 *    existed (empty keywordsList).
 * 3. Priority: SPECIFIC_POST/SPECIFIC_MEDIA > NEXT_POST > ANY_POST; ties are
 *    broken by oldest createdAt, then ID.
 * 4. NEXT_POST is evaluated only after its keyword matched AND only when no
 *    higher-priority campaign already won. It must be unconsumed (or already
 *    consumed by this same media), and the media must have been published at
 *    or after the campaign's creation. The claim is a conditional atomic
 *    update, so concurrent comments on different posts cannot both consume it.
 *    An ineligible NEXT_POST never blocks ANY_POST.
 */

export interface ResolveAutomationInput {
  /** Internal InstagramAccount.id (not the Instagram user ID). */
  instagramAccountId: string;
  mediaId: string;
  commentText: string;
  /**
   * Returns the media publication time. Called lazily, only when an
   * unconsumed NEXT_POST candidate needs it. Must throw on transient errors so
   * the comment is retried instead of being resolved with a wrong winner.
   * Returning null means "publication time unknowable" (NEXT_POST ineligible).
   */
  getMediaPublishedAt: () => Promise<Date | null>;
}

export type ResolvedAutomation = MatchedAutomationResult & {
  automation: CandidateAutomation & {
    trackedLinks: { id: string; slug: string; destinationUrl: string; active: boolean }[];
  };
};

/** Meta timestamps have second precision; compare at that precision. */
function floorToSecond(date: Date): number {
  return Math.floor(date.getTime() / 1000) * 1000;
}

export function isPublishedAfterCampaign(publishedAt: Date, campaignCreatedAt: Date): boolean {
  return publishedAt.getTime() >= floorToSecond(campaignCreatedAt);
}

/**
 * Atomically claims an unconsumed NEXT_POST campaign for `mediaId`. Only one
 * caller can move consumedPostId from NULL to a media ID. A claim by a
 * concurrent comment on the SAME media counts as success (the campaign belongs
 * to this post).
 */
export async function claimNextPostAutomation(
  automationId: string,
  mediaId: string,
  publishedAt: Date
): Promise<boolean> {
  const result = await prisma.automation.updateMany({
    where: {
      id: automationId,
      triggerScope: "NEXT_POST",
      isActive: true,
      consumedPostId: null,
      // Defense in depth: never let an older post consume the campaign.
      createdAt: { lte: new Date(floorToSecond(publishedAt) + 999) },
    },
    data: {
      consumedPostId: mediaId,
      consumedAt: new Date(),
    },
  });

  if (result.count > 0) return true;

  const current = await prisma.automation.findUnique({
    where: { id: automationId },
    select: { consumedPostId: true },
  });
  return current?.consumedPostId === mediaId;
}

export async function resolveAutomationForComment(
  input: ResolveAutomationInput
): Promise<ResolvedAutomation | null> {
  const { instagramAccountId, mediaId, commentText } = input;

  const automations = await prisma.automation.findMany({
    where: {
      instagramAccountId,
      isActive: true,
      OR: [
        { triggerScope: { in: ["SPECIFIC_POST", "SPECIFIC_MEDIA"] }, postId: mediaId },
        { triggerScope: "NEXT_POST", consumedPostId: null },
        { triggerScope: "NEXT_POST", consumedPostId: mediaId },
        { triggerScope: "ANY_POST" },
      ],
    },
    include: {
      keywordsList: { select: { keyword: true, normalizedKeyword: true } },
      variations: {
        where: { isActive: true },
        select: { id: true, message: true, isActive: true },
      },
      trackedLinks: {
        where: { active: true },
        select: { id: true, slug: true, destinationUrl: true, active: true },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  // 1. Keyword matching first: no side effects for non-matching comments.
  const matches: MatchedAutomationResult[] = [];
  for (const automation of automations) {
    if (getScopePriority(automation.triggerScope) > 3) continue; // unknown scope

    const keywords =
      automation.keywordsList.length > 0
        ? automation.keywordsList.map((k) => k.keyword)
        : automation.keywords;

    const { matched, matchedKeyword } = matchCommentAgainstKeywords(
      commentText,
      keywords,
      automation.wholeWordMatch
    );
    if (matched && matchedKeyword) {
      matches.push({ automation: automation as CandidateAutomation, matchedKeyword });
    }
  }

  // 2. Walk candidates in priority order; the first eligible one wins.
  let publishedAt: Date | null | undefined;
  for (const match of sortMatchesByPriority(matches)) {
    const automation = match.automation;

    if (automation.triggerScope === "NEXT_POST" && automation.consumedPostId !== mediaId) {
      if (publishedAt === undefined) publishedAt = await input.getMediaPublishedAt();
      if (!publishedAt) continue;
      if (!isPublishedAfterCampaign(publishedAt, new Date(automation.createdAt))) continue;
      if (!(await claimNextPostAutomation(automation.id, mediaId, publishedAt))) continue;
    }

    return match as ResolvedAutomation;
  }

  return null;
}
