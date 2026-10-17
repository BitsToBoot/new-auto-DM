export interface RenderMessageContext {
  username?: string | null;
  displayName?: string | null;
  trackedUrl?: string | null;
}

/**
 * Deterministically renders DM message templates.
 * Supports:
 * - {username} -> recipient username
 * - {name} -> recipient display name or fallback
 * - {link} -> tracked link URL
 */
export function renderDmMessage(
  template: string,
  context: RenderMessageContext = {}
): string {
  if (!template) return "";

  let rendered = template;

  if (context.username) {
    rendered = rendered.replace(/\{username\}/gi, `@${context.username}`);
  } else {
    rendered = rendered.replace(/\{username\}/gi, "");
  }

  if (context.displayName) {
    rendered = rendered.replace(/\{name\}/gi, context.displayName);
  } else if (context.username) {
    rendered = rendered.replace(/\{name\}/gi, context.username);
  } else {
    rendered = rendered.replace(/\{name\}/gi, "friend");
  }

  if (context.trackedUrl) {
    rendered = rendered.replace(/\{link\}/gi, context.trackedUrl);
  }

  return rendered.trim();
}

/**
 * Selects an active message variation for an automation.
 * Falls back to default automation.dmMessage if no active variations exist.
 */
export function selectMessageVariation(
  variations?: { id: string; message: string; isActive: boolean }[],
  fallbackMessage: string = ""
): { variationId: string | null; template: string } {
  const activeVariations = (variations || []).filter((v) => v.isActive);

  if (activeVariations.length === 0) {
    return { variationId: null, template: fallbackMessage };
  }

  // Select a variation (pseudo-random among active variations)
  const index = Math.floor(Math.random() * activeVariations.length);
  const selected = activeVariations[index];

  return {
    variationId: selected.id,
    template: selected.message,
  };
}
