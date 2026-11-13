/**
 * Delivery configuration.
 *
 * The throughput values govern our own application-level throttle. They do NOT
 * represent Meta's actual platform limits; Meta API errors (including Meta's
 * own rate-limit responses) are handled separately in lib/meta/client.ts.
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
   * Max DMs allowed per Instagram account per window.
   * Conservative default; raise if Meta confirms higher safe throughput.
   */
  dmPerHourPerAccount: parseIntEnv("DM_RATE_LIMIT_PER_HOUR", 100),

  /** Window length in seconds for the per-account DM rate limiter. */
  dmRateWindowSeconds: parseIntEnv("DM_RATE_WINDOW_SECONDS", 3600),

  /**
   * @deprecated Rate-limited jobs are no longer skipped after N requeues.
   * They are rescheduled durably until their eligibility deadline. Kept only so
   * existing environment configuration does not break.
   */
  maxRequeueAttempts: parseIntEnv("DM_RATE_MAX_REQUEUE_ATTEMPTS", 3),

  /** Fallback delay (ms) when a rate-limit window has no known reset time. */
  requeueDelayMs: parseIntEnv("DM_RATE_REQUEUE_DELAY_MS", 30 * 60 * 1000),

  /**
   * Meta's private-reply eligibility window after a comment (hours). Private
   * replies are accepted for 7 days after the comment, subject to Meta's rules.
   */
  privateReplyWindowHours: parseIntEnv("PRIVATE_REPLY_WINDOW_HOURS", 7 * 24),

  /**
   * Safety margin (minutes) subtracted from the eligibility window so we never
   * attempt a send right at the edge of Meta's window.
   */
  deadlineSafetyMarginMinutes: parseIntEnv("PRIVATE_REPLY_DEADLINE_MARGIN_MINUTES", 60),

  /**
   * Max attempts for transient (definitely-rejected, non-rate-limit) Meta
   * errors before a job is marked FAILED. Rate-limit deferrals do not count.
   */
  maxTransientAttempts: parseIntEnv("DM_MAX_TRANSIENT_ATTEMPTS", 5),

  /** Base and cap (ms) for exponential backoff with full jitter. */
  backoffBaseMs: parseIntEnv("DM_BACKOFF_BASE_MS", 60 * 1000),
  backoffMaxMs: parseIntEnv("DM_BACKOFF_MAX_MS", 60 * 60 * 1000),

  /**
   * A job stuck in SENDING longer than this was interrupted mid-send (crash,
   * lost lock). It is moved to UNKNOWN and never re-sent automatically.
   */
  staleSendingMs: parseIntEnv("DM_STALE_SENDING_MS", 5 * 60 * 1000),

  /** How often the worker runs the durable recovery scheduler (ms). */
  schedulerIntervalMs: parseIntEnv("DM_SCHEDULER_INTERVAL_MS", 30 * 1000),

  /** Max jobs re-enqueued per scheduler pass. */
  schedulerBatchSize: parseIntEnv("DM_SCHEDULER_BATCH_SIZE", 500),

  /**
   * RECEIVED comments older than this are considered lost and re-enqueued (ms).
   * Long enough that a large burst still waiting in the queue is not
   * re-enqueued needlessly (re-processing is idempotent, just wasted work).
   */
  inboundRecoveryAgeMs: parseIntEnv("DM_INBOUND_RECOVERY_AGE_MS", 15 * 60 * 1000),
} as const;

/** Computes the private-reply eligibility deadline for a comment. */
export function computeDeliveryDeadline(commentedAt: Date): Date {
  return new Date(
    commentedAt.getTime() +
      DELIVERY_CONFIG.privateReplyWindowHours * 60 * 60 * 1000 -
      DELIVERY_CONFIG.deadlineSafetyMarginMinutes * 60 * 1000
  );
}

/**
 * Exponential backoff with full jitter: random in [0, min(cap, base * 2^n)].
 * A floor of 1 second avoids hot loops.
 */
export function computeBackoffMs(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(
    DELIVERY_CONFIG.backoffMaxMs,
    DELIVERY_CONFIG.backoffBaseMs * 2 ** Math.max(0, attempt)
  );
  return Math.max(1000, Math.floor(random() * exp));
}
