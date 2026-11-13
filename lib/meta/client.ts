import { getMetaGraphApiVersion, requireEnv } from "@/lib/env";

function instagramGraphBase() {
  return `https://graph.instagram.com/${getMetaGraphApiVersion()}`;
}

function facebookGraphBase() {
  return `https://graph.facebook.com/${getMetaGraphApiVersion()}`;
}

export class MetaApiError extends Error {
  constructor(
    public code: number,
    public subcode: number | undefined,
    public fbTraceId: string | undefined,
    message: string
  ) {
    super(message);
    this.name = "MetaApiError";
  }
}

export class TokenExpiredError extends MetaApiError {
  constructor(message: string, fbTraceId?: string) {
    super(190, undefined, fbTraceId, message);
    this.name = "TokenExpiredError";
  }
}

/**
 * Meta explicitly rejected the request because of a rate limit. The message was
 * NOT accepted, so the send may be safely rescheduled.
 */
export class RateLimitError extends MetaApiError {
  constructor(
    message: string,
    fbTraceId?: string,
    /** Delay requested by Meta (Retry-After or usage headers), if any. */
    public retryAfterMs?: number,
    code = 368
  ) {
    super(code, undefined, fbTraceId, message);
    this.name = "RateLimitError";
  }
}

/**
 * A transport-level failure (no Graph API response was received).
 *
 * `ambiguous` is false only when the connection provably never reached Meta
 * (DNS failure, connection refused), meaning the message cannot have been
 * accepted. Every other failure (reset, timeout, unreadable response) is
 * ambiguous: Meta may have accepted the message, so it must not be retried.
 */
export class MetaNetworkError extends Error {
  constructor(
    message: string,
    public readonly ambiguous: boolean,
    public readonly causeCode?: string
  ) {
    super(message);
    this.name = "MetaNetworkError";
  }
}

const PRE_CONNECTION_ERROR_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]);

/** Transient Graph API error codes that Meta documents as "retry later". */
export const TRANSIENT_META_ERROR_CODES = new Set([1, 2]);

/** Graph error codes that are definite, permanent rejections for this send. */
export const PERMANENT_META_ERROR_CODES = new Set([10, 100, 190, 200, 551]);

const SEND_TIMEOUT_MS = 15_000;

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  return getErrorCode((error as { cause?: unknown }).cause);
}

async function metaFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    const code = getErrorCode(error);
    const ambiguous = !(code && PRE_CONNECTION_ERROR_CODES.has(code));
    const name = error instanceof Error ? error.name : "Error";
    throw new MetaNetworkError(
      `Meta request failed before a response was received (${code ?? name})`,
      ambiguous,
      code
    );
  }
}

/** Parses Retry-After and Meta usage headers into a delay in ms. */
export function parseRetryAfterMs(headers: Headers | undefined | null): number | undefined {
  if (!headers) return undefined;

  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }

  // x-business-use-case-usage / x-app-usage carry estimated_time_to_regain_access (minutes).
  let maxMinutes: number | undefined;
  for (const header of ["x-business-use-case-usage", "x-app-usage", "x-ad-account-usage"]) {
    const raw = headers.get(header);
    if (!raw) continue;
    for (const match of raw.matchAll(/"estimated_time_to_regain_access"\s*:\s*(\d+)/g)) {
      const minutes = Number(match[1]);
      if (Number.isFinite(minutes)) maxMinutes = Math.max(maxMinutes ?? 0, minutes);
    }
  }
  return maxMinutes !== undefined && maxMinutes > 0 ? maxMinutes * 60 * 1000 : undefined;
}

export class PermissionError extends MetaApiError {
  constructor(message: string, fbTraceId?: string) {
    super(100, undefined, fbTraceId, message);
    this.name = "PermissionError";
  }
}

interface GraphApiError {
  error: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

export interface InstagramUser {
  id: string;
  username: string;
  name?: string;
}

export interface InstagramComment {
  id: string;
  text: string;
  from: {
    id: string;
    username: string;
  };
  timestamp: string;
}

export interface InstagramMedia {
  id: string;
  caption?: string;
  media_type: string;
  media_url?: string;
  thumbnail_url?: string;
  timestamp: string;
  permalink?: string;
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

async function handleResponse<T>(response: Response): Promise<T> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    // A response arrived but its body was unreadable. For a 2xx the request
    // may well have been accepted, so this is ambiguous.
    throw new MetaNetworkError(
      `Unreadable Meta response (HTTP ${response.status})`,
      response.ok || response.status >= 500
    );
  }

  if (!response.ok || (data as GraphApiError).error) {
    const err = (data as GraphApiError).error;
    const code = err?.code ?? response.status;
    const subcode = err?.error_subcode;
    const traceId = err?.fbtrace_id;
    const message = err?.message ?? "Unknown Meta API error";

    switch (code) {
      case 190:
        throw new TokenExpiredError(message, traceId);
      case 368:
      case 4:
      case 17:
      case 32:
      case 613:
        throw new RateLimitError(message, traceId, parseRetryAfterMs(response.headers), code);
      case 10:
      case 100:
      case 200:
        throw new PermissionError(message, traceId);
      default:
        throw new MetaApiError(code, subcode, traceId, message);
    }
  }

  return data as T;
}

export async function sendPrivateReply(
  accessToken: string,
  instagramAccountId: string,
  commentId: string,
  message: string
): Promise<{ recipient_id: string; message_id: string }> {
  const response = await metaFetch(
    `${instagramGraphBase()}/${instagramAccountId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        recipient: { comment_id: commentId },
        message: { text: message },
      }),
    }
  );

  return handleResponse(response);
}

export async function replyToComment(
  accessToken: string,
  commentId: string,
  message: string
): Promise<{ id: string }> {
  const response = await metaFetch(
    `${instagramGraphBase()}/${commentId}/replies`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ message }),
    }
  );

  return handleResponse(response);
}

export async function getMediaComments(
  accessToken: string,
  mediaId: string
): Promise<InstagramComment[]> {
  const url = new URL(`${instagramGraphBase()}/${mediaId}/comments`);
  url.searchParams.set("fields", "id,text,from,timestamp");

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const data = await handleResponse<{ data: InstagramComment[] }>(response);
  return data.data;
}

/**
 * Returns the publication time of a media item. Used to decide NEXT_POST
 * eligibility (a NEXT_POST campaign only fires on media published after the
 * campaign was created).
 */
export async function getMediaPublishedAt(
  accessToken: string,
  mediaId: string
): Promise<Date> {
  const url = new URL(`${instagramGraphBase()}/${mediaId}`);
  url.searchParams.set("fields", "id,timestamp");

  const response = await metaFetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await handleResponse<{ id: string; timestamp?: string }>(response);
  const publishedAt = parseMetaTimestamp(data.timestamp);
  if (!publishedAt) {
    throw new MetaApiError(100, undefined, undefined, `Media ${mediaId} has no valid timestamp`);
  }
  return publishedAt;
}

/**
 * Parses Graph timestamps such as "2026-11-09T10:00:00+0000" (offset without a
 * colon) into a UTC Date. Returns null for missing or malformed values.
 */
export function parseMetaTimestamp(value: string | null | undefined): Date | null {
  if (!value || typeof value !== "string") return null;
  const normalized = value.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? new Date(time) : null;
}

export async function getUserInfo(accessToken: string): Promise<InstagramUser> {
  const url = new URL(`${instagramGraphBase()}/me`);
  url.searchParams.set("fields", "id,username,name");

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  return handleResponse<InstagramUser>(response);
}

export async function getUserMedia(
  accessToken: string,
  limit = 25
): Promise<InstagramMedia[]> {
  const url = new URL(`${instagramGraphBase()}/me/media`);
  url.searchParams.set(
    "fields",
    "id,caption,media_type,media_url,thumbnail_url,timestamp,permalink"
  );
  url.searchParams.set("limit", limit.toString());

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const data = await handleResponse<{ data: InstagramMedia[] }>(response);
  return data.data;
}

export async function getLongLivedToken(
  shortLivedToken: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const url = new URL(`${instagramGraphBase()}/access_token`);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", requireEnv("INSTAGRAM_APP_SECRET"));
  url.searchParams.set("access_token", shortLivedToken);

  const response = await fetch(url.toString());
  const data = await handleResponse<TokenResponse>(response);

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 5184000,
  };
}

export async function refreshLongLivedToken(
  longLivedToken: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const url = new URL(`${instagramGraphBase()}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", longLivedToken);

  const response = await fetch(url.toString());
  const data = await handleResponse<TokenResponse>(response);

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 5184000,
  };
}

export async function subscribeInstagramAccountToWebhooks(
  instagramAccountId: string,
  accessToken: string
): Promise<{ success: boolean }> {
  const response = await fetch(
    `${instagramGraphBase()}/${instagramAccountId}/subscribed_apps`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        subscribed_fields: ["comments", "messages"],
      }),
    }
  );

  return handleResponse(response);
}

/**
 * Removes this app's webhook subscription for an Instagram account (the
 * inverse of subscribeInstagramAccountToWebhooks). Callers must treat a failure
 * as "subscription may still be active" and record it; it never implies the
 * subscription was removed.
 */
export async function unsubscribeInstagramAccountFromWebhooks(
  instagramAccountId: string,
  accessToken: string
): Promise<{ success: boolean }> {
  const response = await metaFetch(
    `${instagramGraphBase()}/${instagramAccountId}/subscribed_apps`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  return handleResponse(response);
}

export async function debugToken(inputToken: string, accessToken: string) {
  const url = new URL(`${facebookGraphBase()}/debug_token`);
  url.searchParams.set("input_token", inputToken);
  url.searchParams.set("access_token", accessToken);
  const response = await fetch(url.toString());
  return handleResponse(response);
}
