/**
 * Client-safe tracked-link helpers (also imported by the campaign builder UI).
 *
 * Message rendering lives in lib/delivery/renderer.ts (renderDmMessage), the
 * single canonical implementation. Delivery-attributed tracked URLs are built
 * server-side by lib/tracking/attribution.ts (buildDeliveryTrackedUrl), which
 * delegates to buildTrackedUrl below.
 */

export interface MessageTrackedLink {
  slug: string;
  destinationUrl: string;
}

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/i;

function trimTrailingPunctuation(url: string) {
  return url.replace(/[.,!?;:]+$/, "");
}

export function extractFirstUrl(message: string): string | null {
  const match = message.match(URL_PATTERN);
  if (!match) return null;

  try {
    const url = trimTrailingPunctuation(match[0]);
    return new URL(url).toString();
  } catch {
    return null;
  }
}

export function replaceUrlWithTrackedPlaceholder(
  message: string,
  destinationUrl: string | null | undefined
) {
  if (!destinationUrl) return message;
  if (message.includes(destinationUrl)) {
    return message.replace(destinationUrl, "{link}");
  }

  const withoutTrailingSlash = destinationUrl.replace(/\/$/, "");
  return message.replace(withoutTrailingSlash, "{link}");
}

export interface TrackedUrlAttribution {
  deliveryJobId: string;
  signature: string;
}

/**
 * The one canonical tracked-URL builder. With `attribution`, appends the
 * delivery job ID (`d`) and its signature (`s`) consumed by app/r/[slug].
 */
export function buildTrackedUrl(
  slug: string,
  baseUrl?: string,
  attribution?: TrackedUrlAttribution
) {
  const resolvedBaseUrl =
    baseUrl ??
    (typeof window !== "undefined"
      ? window.location.origin
      : process.env.NEXTAUTH_URL ?? "http://localhost:3000");

  const url = `${resolvedBaseUrl.replace(/\/$/, "")}/r/${slug}`;
  if (!attribution) return url;

  const params = new URLSearchParams({
    d: attribution.deliveryJobId,
    s: attribution.signature,
  });
  return `${url}?${params.toString()}`;
}
