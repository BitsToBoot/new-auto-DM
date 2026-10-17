/**
 * DM Rate Limiter — per Instagram account, Redis-backed, worker-safe.
 *
 * Uses an atomic Lua script to reserve a slot so concurrent workers
 * sharing the same Redis instance cannot both pass the check before
 * either increments the counter.
 *
 * Key pattern: `rate:dm:{instagramAccountId}`  (1-hour TTL)
 *
 * NOTE: This limits OUR sending throughput. It does not represent Meta's
 * actual platform policies; Meta errors are handled separately in
 * lib/meta/client.ts.
 */

import type Redis from "ioredis";
import { DELIVERY_CONFIG } from "@/lib/config/delivery";

// Re-export for tests that import the old constants directly.
export const RATE_LIMIT_MAX = DELIVERY_CONFIG.dmPerHourPerAccount;
export const RATE_LIMIT_WINDOW = DELIVERY_CONFIG.dmRateWindowSeconds;
export const REQUEUE_DELAY_MS = DELIVERY_CONFIG.requeueDelayMs;
export const MAX_REQUEUE_ATTEMPTS = DELIVERY_CONFIG.maxRequeueAttempts;

export interface RateLimitResult {
  allowed: boolean;
  currentCount: number;
  remainingDMs: number;
  shouldRequeue: boolean;
  requeueDelayMs: number;
  shouldSkip: boolean;
  reserved: boolean;
}

/**
 * Atomic Lua script: increment only if current count is below max.
 * Returns [allowed(0|1), newCount, remaining].
 * The EXPIRE is set only on the first increment so the window is
 * anchored to the first DM in the hour, not renewed on every call.
 */
const RESERVE_DM_SLOT_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
local max     = tonumber(ARGV[1])
local ttl     = tonumber(ARGV[2])

if current >= max then
  return {0, current, 0}
end

local next_count = redis.call("INCR", KEYS[1])
if next_count == 1 or redis.call("TTL", KEYS[1]) < 0 then
  redis.call("EXPIRE", KEYS[1], ttl)
end

return {1, next_count, max - next_count}
`;

const RELEASE_DM_SLOT_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
if current > 0 then
  return redis.call("DECR", KEYS[1])
end
return 0
`;

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseInt(value, 10);
  return 0;
}

function blockedResult(count: number, requeueAttempt: number): RateLimitResult {
  if (requeueAttempt >= DELIVERY_CONFIG.maxRequeueAttempts) {
    return {
      allowed: false,
      currentCount: count,
      remainingDMs: 0,
      shouldRequeue: false,
      requeueDelayMs: 0,
      shouldSkip: true,
      reserved: false,
    };
  }
  return {
    allowed: false,
    currentCount: count,
    remainingDMs: 0,
    shouldRequeue: true,
    requeueDelayMs: DELIVERY_CONFIG.requeueDelayMs,
    shouldSkip: false,
    reserved: false,
  };
}

/**
 * Read-only check (non-atomic). Suitable for informational checks only.
 * Use reserveDMSlot in workers to avoid TOCTOU races.
 */
export async function checkRateLimit(
  instagramAccountId: string,
  requeueAttempt = 0,
  redis?: Redis
): Promise<RateLimitResult> {
  const client = redis ?? (await getDefaultRedis());
  const key = `rate:dm:${instagramAccountId}`;
  const raw = await client.get(key);
  const count = raw ? Number.parseInt(raw, 10) : 0;

  if (count >= DELIVERY_CONFIG.dmPerHourPerAccount) {
    return blockedResult(count, requeueAttempt);
  }

  return {
    allowed: true,
    currentCount: count,
    remainingDMs: DELIVERY_CONFIG.dmPerHourPerAccount - count,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: false,
  };
}

/**
 * Atomically reserve a DM send slot.
 * This is the correct path for workers; concurrent workers share the
 * same Redis counter and cannot race past the limit.
 */
export async function reserveDMSlot(
  instagramAccountId: string,
  requeueAttempt = 0,
  redis?: Redis
): Promise<RateLimitResult> {
  const client = redis ?? (await getDefaultRedis());
  const key = `rate:dm:${instagramAccountId}`;

  const result = await client.eval(
    RESERVE_DM_SLOT_SCRIPT,
    1,
    key,
    DELIVERY_CONFIG.dmPerHourPerAccount,
    DELIVERY_CONFIG.dmRateWindowSeconds
  );

  const values = Array.isArray(result) ? result : [];
  const allowedFlag = toNumber(values[0]);
  const count = toNumber(values[1]);
  const remaining = toNumber(values[2]);

  if (allowedFlag !== 1) {
    return blockedResult(count, requeueAttempt);
  }

  return {
    allowed: true,
    currentCount: count,
    remainingDMs: remaining,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: true,
  };
}

/** Backward-compatible helper for tests and admin scripts. */
export async function incrementDMCounter(
  instagramAccountId: string,
  redis?: Redis
): Promise<number> {
  const result = await reserveDMSlot(
    instagramAccountId,
    DELIVERY_CONFIG.maxRequeueAttempts,
    redis
  );
  return result.currentCount;
}

export async function getCurrentDMCount(
  instagramAccountId: string,
  redis?: Redis
): Promise<number> {
  const client = redis ?? (await getDefaultRedis());
  const raw = await client.get(`rate:dm:${instagramAccountId}`);
  return raw ? Number.parseInt(raw, 10) : 0;
}

export async function resetRateLimit(
  instagramAccountId: string,
  redis?: Redis
): Promise<void> {
  const client = redis ?? (await getDefaultRedis());
  await client.del(`rate:dm:${instagramAccountId}`);
}

/**
 * Release a previously reserved DM slot (e.g. if permanent delivery failure
 * or concurrency claim contention occurred before the message was dispatched).
 */
export async function releaseDMSlot(
  instagramAccountId: string,
  redis?: Redis
): Promise<number> {
  const client = redis ?? (await getDefaultRedis());
  const key = `rate:dm:${instagramAccountId}`;
  const result = await client.eval(RELEASE_DM_SLOT_SCRIPT, 1, key);
  return toNumber(result);
}

// ---------------------------------------------------------------------------
// Internal: lazy import of the shared Redis connection so we avoid a circular
// dependency when the module is loaded in test environments that mock ioredis.
// ---------------------------------------------------------------------------

let _defaultRedis: Redis | null = null;

async function getDefaultRedis(): Promise<Redis> {
  if (!_defaultRedis) {
    // Dynamic import keeps this side-effect-free at module load time.
    const { getRedisConnection } = await import("@/lib/queue/client");
    _defaultRedis = getRedisConnection();
  }
  return _defaultRedis;
}
