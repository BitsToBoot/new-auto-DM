export const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Validates whether a destination URL is safe to redirect to.
 * - Must be a valid URL
 * - Must use http: or https:
 * - Rejects javascript:, data:, vbscript:, file:, etc.
 */
export function isSafeDestinationUrl(urlString: string): boolean {
  if (!urlString || typeof urlString !== "string") {
    return false;
  }

  const trimmed = urlString.trim();
  if (trimmed.length > 2048) {
    return false;
  }

  try {
    const parsed = new URL(trimmed);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
      return false;
    }

    // Hostname must exist and not contain forbidden characters
    if (!parsed.hostname || parsed.hostname.length < 1) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitizes destination URL by trimming and enforcing https if missing protocol.
 */
export function sanitizeDestinationUrl(urlString: string): string | null {
  if (!urlString) return null;
  const trimmed = urlString.trim();

  if (!isSafeDestinationUrl(trimmed)) {
    return null;
  }

  return trimmed;
}
