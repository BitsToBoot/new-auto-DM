import { createHmac, timingSafeEqual } from "node:crypto";
import { buildTrackedUrl } from "@/lib/tracking/message";

/**
 * Signed delivery attribution for tracked links.
 *
 * The redirect route accepts `?d=<deliveryJobId>&s=<signature>`. The signature
 * binds the delivery job to the tracked-link slug, so a visitor cannot attach
 * an arbitrary (or another tenant's) delivery ID to a click. The route still
 * re-checks workspace, Instagram account and campaign ownership in the
 * database.
 */

const SIGNATURE_HEX_LENGTH = 32;

function getAttributionSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET ?? process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error("NEXTAUTH_SECRET or ENCRYPTION_KEY is required to sign tracked links");
  }
  return secret;
}

export function signDeliveryAttribution(deliveryJobId: string, slug: string): string {
  return createHmac("sha256", getAttributionSecret())
    .update(`tracked-link:v1:${slug}:${deliveryJobId}`)
    .digest("hex")
    .slice(0, SIGNATURE_HEX_LENGTH);
}

export function verifyDeliveryAttribution(
  deliveryJobId: string | null | undefined,
  slug: string,
  signature: string | null | undefined
): boolean {
  if (!deliveryJobId || !signature) return false;
  if (deliveryJobId.length > 128 || signature.length !== SIGNATURE_HEX_LENGTH) return false;

  const expected = Buffer.from(signDeliveryAttribution(deliveryJobId, slug));
  const provided = Buffer.from(signature);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

/** Builds the tracked URL for a specific delivery (used when rendering DMs). */
export function buildDeliveryTrackedUrl(
  slug: string,
  deliveryJobId: string,
  baseUrl?: string
): string {
  return buildTrackedUrl(slug, baseUrl, {
    deliveryJobId,
    signature: signDeliveryAttribution(deliveryJobId, slug),
  });
}

/**
 * Upper bound for a delivery-attributed tracked URL, used to validate message
 * byte length at campaign save time.
 */
export function maxDeliveryTrackedUrlLength(slug: string, baseUrl?: string): number {
  // Delivery job IDs are UUIDs (36 chars); allow headroom for legacy cuid IDs.
  return buildTrackedUrl(slug, baseUrl, {
    deliveryJobId: "x".repeat(40),
    signature: "x".repeat(SIGNATURE_HEX_LENGTH),
  }).length;
}
