/**
 * Canonical DM message rendering.
 *
 * This is the ONLY implementation of placeholder substitution. Every send path
 * and every preview goes through `renderDmMessage`, so `{username}` renders
 * identically everywhere and an unresolved placeholder is never sent.
 *
 * Supported placeholders (case-insensitive):
 *   {username} -> "@<username>", or "there" when the username is unknown
 *   {name}     -> display name, else username, else "friend"
 *   {link}     -> tracked redirect URL (required when the template uses it)
 *
 * Any other `{identifier}` token is rejected.
 */

/** Meta's private-reply text limit, measured in UTF-8 bytes. */
export const META_MESSAGE_MAX_BYTES = 1000;

export const SUPPORTED_PLACEHOLDERS = ["username", "name", "link"] as const;
export type SupportedPlaceholder = (typeof SUPPORTED_PLACEHOLDERS)[number];

const PLACEHOLDER_PATTERN = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/** Instagram usernames are at most 30 characters. */
const MAX_USERNAME_LENGTH = 30;

export type MessageValidationCode =
  | "EMPTY_MESSAGE"
  | "UNSUPPORTED_PLACEHOLDER"
  | "MISSING_TRACKED_LINK"
  | "MESSAGE_TOO_LONG";

export class MessageRenderError extends Error {
  constructor(
    public readonly code: MessageValidationCode,
    message: string
  ) {
    super(message);
    this.name = "MessageRenderError";
  }
}

export interface RenderMessageContext {
  username?: string | null;
  displayName?: string | null;
  /** Fully built tracked URL (see buildTrackedUrl). */
  trackedUrl?: string | null;
  /**
   * Raw destination URL of the tracked link. When the template has no {link}
   * placeholder but contains this URL verbatim, it is swapped for the tracked
   * URL so clicks are still attributed.
   */
  destinationUrl?: string | null;
}

/** UTF-8 byte length. Uses Buffer.byteLength in the Node.js runtime. */
export function utf8ByteLength(value: string): number {
  if (typeof Buffer !== "undefined") {
    return Buffer.byteLength(value, "utf8");
  }
  return new TextEncoder().encode(value).length;
}

export function findPlaceholders(template: string): string[] {
  return Array.from(template.matchAll(PLACEHOLDER_PATTERN), (m) => m[1].toLowerCase());
}

export function findUnsupportedPlaceholders(template: string): string[] {
  const supported = new Set<string>(SUPPORTED_PLACEHOLDERS);
  return Array.from(new Set(findPlaceholders(template).filter((p) => !supported.has(p))));
}

function cleanUsername(username?: string | null): string | null {
  const trimmed = username?.trim().replace(/^@+/, "");
  return trimmed ? trimmed : null;
}

/**
 * Renders a template. Throws MessageRenderError instead of ever returning text
 * that still contains a placeholder or exceeds Meta's byte limit.
 */
export function renderDmMessage(
  template: string,
  context: RenderMessageContext = {}
): string {
  if (!template || !template.trim()) {
    throw new MessageRenderError("EMPTY_MESSAGE", "Message template is empty");
  }

  const unsupported = findUnsupportedPlaceholders(template);
  if (unsupported.length > 0) {
    throw new MessageRenderError(
      "UNSUPPORTED_PLACEHOLDER",
      `Unsupported placeholder(s): ${unsupported.map((p) => `{${p}}`).join(", ")}`
    );
  }

  const username = cleanUsername(context.username);
  const displayName = context.displayName?.trim() || null;
  const usesLink = findPlaceholders(template).includes("link");

  if (usesLink && !context.trackedUrl) {
    throw new MessageRenderError(
      "MISSING_TRACKED_LINK",
      "Message uses {link} but the campaign has no active tracked link"
    );
  }

  let rendered = template.replace(PLACEHOLDER_PATTERN, (_match, rawName: string) => {
    switch (rawName.toLowerCase() as SupportedPlaceholder) {
      case "username":
        return username ? `@${username}` : "there";
      case "name":
        return displayName ?? username ?? "friend";
      case "link":
        return context.trackedUrl as string;
    }
  });

  if (!usesLink && context.trackedUrl && context.destinationUrl) {
    rendered = replaceDestinationUrl(rendered, context.destinationUrl, context.trackedUrl);
  }

  rendered = rendered.trim();
  assertWithinMetaLimit(rendered);
  return rendered;
}

function replaceDestinationUrl(message: string, destinationUrl: string, trackedUrl: string) {
  if (message.includes(destinationUrl)) {
    return message.replaceAll(destinationUrl, trackedUrl);
  }
  const withoutTrailingSlash = destinationUrl.replace(/\/$/, "");
  if (withoutTrailingSlash && message.includes(withoutTrailingSlash)) {
    return message.replaceAll(withoutTrailingSlash, trackedUrl);
  }
  return message;
}

export function assertWithinMetaLimit(message: string): void {
  const bytes = utf8ByteLength(message);
  if (bytes > META_MESSAGE_MAX_BYTES) {
    throw new MessageRenderError(
      "MESSAGE_TOO_LONG",
      `Message is ${bytes} UTF-8 bytes; Meta allows at most ${META_MESSAGE_MAX_BYTES} bytes`
    );
  }
}

/**
 * Validates a campaign template at save time, using worst-case expansions for
 * every placeholder, so a template that passes here cannot exceed the byte
 * limit at send time.
 */
export function validateMessageTemplate(
  template: string,
  options: {
    hasTrackedLink: boolean;
    maxTrackedUrlLength: number;
    /** Raw destination URL; if it appears verbatim it is swapped for the tracked URL. */
    destinationUrl?: string | null;
  }
): { valid: true; worstCaseBytes: number } | { valid: false; code: MessageValidationCode; error: string } {
  if (!template || !template.trim()) {
    return { valid: false, code: "EMPTY_MESSAGE", error: "Message cannot be empty" };
  }

  const unsupported = findUnsupportedPlaceholders(template);
  if (unsupported.length > 0) {
    return {
      valid: false,
      code: "UNSUPPORTED_PLACEHOLDER",
      error: `Unsupported placeholder(s): ${unsupported
        .map((p) => `{${p}}`)
        .join(", ")}. Supported: ${SUPPORTED_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}`,
    };
  }

  const usesLink = findPlaceholders(template).includes("link");
  if (usesLink && !options.hasTrackedLink) {
    return {
      valid: false,
      code: "MISSING_TRACKED_LINK",
      error: "Message uses {link} but no tracked destination URL is configured",
    };
  }

  // Worst case: 4-byte characters are not possible in usernames, but display
  // names can contain any Unicode; assume 30 chars * 4 bytes.
  const worstName = "\u{1F600}".repeat(MAX_USERNAME_LENGTH);
  const worstUsername = `@${"x".repeat(MAX_USERNAME_LENGTH)}`;
  const worstTrackedUrl = "x".repeat(options.maxTrackedUrlLength);
  let base = template;
  if (!usesLink && options.hasTrackedLink && options.destinationUrl) {
    base = replaceDestinationUrl(base, options.destinationUrl, worstTrackedUrl);
  }
  const worst = base.replace(PLACEHOLDER_PATTERN, (_m, rawName: string) => {
    switch (rawName.toLowerCase() as SupportedPlaceholder) {
      case "username":
        return worstUsername;
      case "name":
        return worstName;
      case "link":
        return worstTrackedUrl;
    }
  });
  const worstCaseBytes = utf8ByteLength(worst.trim());

  if (worstCaseBytes > META_MESSAGE_MAX_BYTES) {
    return {
      valid: false,
      code: "MESSAGE_TOO_LONG",
      error: `Message can reach ${worstCaseBytes} UTF-8 bytes after placeholders and tracked links are filled in; Meta allows at most ${META_MESSAGE_MAX_BYTES} bytes. Hindi text and emoji use 3-4 bytes per character.`,
    };
  }

  return { valid: true, worstCaseBytes };
}

export interface MessageVariationLike {
  id: string;
  message: string;
  isActive: boolean;
}

/**
 * Deterministic FNV-1a hash, so the same trigger always selects the same
 * variation even if selection is ever re-run before persistence.
 */
function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Selects the message template for a delivery.
 * - No active, non-empty variations: the campaign's default message.
 * - Otherwise: the default message plus every active variation form the pool,
 *   and the pick is a stable hash of `seed` (the comment ID), spreading
 *   recipients evenly while staying reproducible.
 */
export function selectMessageVariation(
  variations: MessageVariationLike[] | undefined | null,
  fallbackMessage: string,
  seed: string
): { variationId: string | null; template: string } {
  const active = (variations ?? []).filter((v) => v.isActive && v.message?.trim());

  if (active.length === 0) {
    return { variationId: null, template: fallbackMessage };
  }

  const pool: Array<{ variationId: string | null; template: string }> = [
    { variationId: null, template: fallbackMessage },
    ...active
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((v) => ({ variationId: v.id, template: v.message })),
  ];

  return pool[stableHash(seed) % pool.length];
}
