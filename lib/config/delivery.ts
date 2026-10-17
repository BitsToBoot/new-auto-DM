/**
 * Delivery configuration — Phase 1
 *
 * These values govern our own application-level throttle. They do NOT
 * represent Meta's actual platform limits; Meta API errors are handled
 * separately in lib/meta/client.ts.
 *
 * Override any value via environment variables without redeploying code.
 */

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const DELIVERY_CONFIG = {
  /**
   * Max DMs allowed per Instagram account per hour (sliding window).
   * Conservative default; raise if Meta confirms higher safe throughput.
   */
  dmPerHourPerAccount: parseIntEnv("DM_RATE_LIMIT_PER_HOUR", 100),

  /**
   * Window length in seconds for the per-account DM rate limiter.
   */
  dmRateWindowSeconds: parseIntEnv("DM_RATE_WINDOW_SECONDS", 3600),

  /**
   * Max times a rate-limited job is requeued before being permanently skipped.
   */
  maxRequeueAttempts: parseIntEnv("DM_RATE_MAX_REQUEUE_ATTEMPTS", 3),

  /**
   * How long to delay a requeued rate-limited job (ms).
   */
  requeueDelayMs: parseIntEnv("DM_RATE_REQUEUE_DELAY_MS", 30 * 60 * 1000),
} as const;
