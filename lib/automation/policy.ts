export type AutomationTriggerScope =
  | "SPECIFIC_POST"
  | "SPECIFIC_MEDIA"
  | "NEXT_POST"
  | "ANY_POST";

export interface CandidateAutomation {
  id: string;
  workspaceId: string;
  instagramAccountId: string;
  triggerType: string;
  triggerScope: string;
  postId?: string | null;
  consumedPostId?: string | null;
  consumedAt?: Date | null;
  keywords: string[];
  dmMessage: string;
  publicReplyMessage?: string | null;
  isActive: boolean;
  wholeWordMatch: boolean;
  createdAt: Date;
  keywordsList?: { keyword: string; normalizedKeyword: string }[];
  variations?: { id: string; message: string; isActive: boolean }[];
}

export interface MatchedAutomationResult {
  automation: CandidateAutomation;
  matchedKeyword: string;
}

/**
 * Priority order for resolving multiple matching automations:
 * 1. SPECIFIC_POST / SPECIFIC_MEDIA (highest precision)
 * 2. NEXT_POST (consumed for this post)
 * 3. ANY_POST (broadest scope)
 * 4. Stable tie-breaker: oldest createdAt, then lexicographical ID
 */
export function getScopePriority(triggerScope: string): number {
  switch (triggerScope) {
    case "SPECIFIC_POST":
    case "SPECIFIC_MEDIA":
      return 1;
    case "NEXT_POST":
      return 2;
    case "ANY_POST":
      return 3;
    default:
      return 4;
  }
}

function compareMatches(a: MatchedAutomationResult, b: MatchedAutomationResult): number {
  const pA = getScopePriority(a.automation.triggerScope);
  const pB = getScopePriority(b.automation.triggerScope);
  if (pA !== pB) return pA - pB;

  const timeDiff =
    new Date(a.automation.createdAt).getTime() -
    new Date(b.automation.createdAt).getTime();
  if (timeDiff !== 0) return timeDiff;

  return a.automation.id < b.automation.id ? -1 : a.automation.id > b.automation.id ? 1 : 0;
}

/** Returns matches in deterministic priority order (best first). */
export function sortMatchesByPriority(
  matches: MatchedAutomationResult[]
): MatchedAutomationResult[] {
  return [...matches].sort(compareMatches);
}

/**
 * Sorts matching automations deterministically to select the single winning automation.
 */
export function selectWinningAutomation(
  matches: MatchedAutomationResult[]
): MatchedAutomationResult | null {
  if (!matches || matches.length === 0) return null;
  return sortMatchesByPriority(matches)[0];
}
