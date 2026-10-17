import { stripSpecialCharacters, matchKeywords } from "@/lib/utils/keyword-matcher";

export const MAX_KEYWORDS_PER_AUTOMATION = 20;

/**
 * Normalizes keyword text for deterministic storage and indexing.
 * - Lowercase
 * - Strips emojis and special symbols
 * - Collapses whitespace
 * - Trims
 */
export function normalizeKeyword(keyword: string): string {
  if (!keyword) return "";
  return stripSpecialCharacters(keyword).toLowerCase();
}

export interface NormalizedKeywordEntry {
  raw: string;
  normalized: string;
}

export interface KeywordValidationResult {
  valid: boolean;
  keywords: NormalizedKeywordEntry[];
  error?: string;
}

/**
 * Validates a list of keywords:
 * - Server-side enforcement of maximum 20 keywords
 * - Rejects empty keywords
 * - Rejects duplicate normalized keywords
 */
export function validateAndNormalizeKeywords(
  rawKeywords: string[]
): KeywordValidationResult {
  if (!Array.isArray(rawKeywords)) {
    return { valid: false, keywords: [], error: "Keywords must be an array" };
  }

  if (rawKeywords.length > MAX_KEYWORDS_PER_AUTOMATION) {
    return {
      valid: false,
      keywords: [],
      error: `An automation can have at most ${MAX_KEYWORDS_PER_AUTOMATION} keywords (provided ${rawKeywords.length})`,
    };
  }

  const normalizedList: NormalizedKeywordEntry[] = [];
  const seen = new Set<string>();

  for (const raw of rawKeywords) {
    const trimmed = raw?.trim() ?? "";
    if (!trimmed) continue;

    const normalized = normalizeKeyword(trimmed);
    if (!normalized) {
      return {
        valid: false,
        keywords: [],
        error: `Keyword "${raw}" contains no valid alphanumeric characters`,
      };
    }

    if (seen.has(normalized)) {
      return {
        valid: false,
        keywords: [],
        error: `Duplicate keyword detected: "${raw}" normalizes to "${normalized}" which is already present`,
      };
    }

    seen.add(normalized);
    normalizedList.push({ raw: trimmed, normalized });
  }

  if (normalizedList.length === 0) {
    return {
      valid: false,
      keywords: [],
      error: "At least one valid keyword is required",
    };
  }

  return { valid: true, keywords: normalizedList };
}

/**
 * Matches comment text against candidate keywords.
 */
export function matchCommentAgainstKeywords(
  commentText: string,
  keywords: string[] | { keyword: string; normalizedKeyword?: string }[],
  wholeWordMatch: boolean = true
): { matched: boolean; matchedKeyword: string | null } {
  const keywordStrings = keywords.map((k) => (typeof k === "string" ? k : k.keyword));
  return matchKeywords(commentText, keywordStrings, wholeWordMatch);
}
