import { z } from "zod";

const HEX_32_BYTE = /^[a-f0-9]{64}$/i;

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

export function requireEnv(name: string): string {
  return readEnv(name);
}

export function getBaseUrl(): string {
  return process.env.NEXTAUTH_URL ?? "http://localhost:3000";
}

export function getEncryptionKeyHex(): string {
  const value = readEnv("ENCRYPTION_KEY");
  if (!HEX_32_BYTE.test(value)) {
    throw new Error("ENCRYPTION_KEY must be a 32-byte hex string");
  }
  return value;
}

export function getMetaGraphApiVersion(): string {
  return process.env.META_GRAPH_API_VERSION ?? "v25.0";
}

// ─── Validation Schemas ──────────────────────────────────────────────────────

/**
 * Core variables required for the app to start at all (auth, database, crypto).
 * These are validated eagerly at startup in development and production.
 */
const coreEnvSchema = z.object({
  NEXTAUTH_URL: z.string().url(),
  NEXTAUTH_SECRET: z.string().min(16),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  ENCRYPTION_KEY: z.string().regex(HEX_32_BYTE),
});

/**
 * External-service variables required only in production.
 * In development, missing values produce a warning but don't crash the app,
 * since Meta/Stripe/Resend features won't be used without real credentials.
 */
const externalEnvSchema = z.object({
  INSTAGRAM_APP_ID: z.string().min(1),
  INSTAGRAM_APP_SECRET: z.string().min(1),
  FACEBOOK_APP_SECRET: z.string().min(1),
  WEBHOOK_VERIFY_TOKEN: z.string().min(1),
});

/**
 * Full schema for reference. Contains all variables the env.ts module governs.
 */
export const serverEnvSchema = coreEnvSchema.merge(externalEnvSchema);

/**
 * Validate the environment at startup.
 *
 * - Core variables (auth, DB, Redis, encryption) always fail fast.
 * - External-service variables (Meta, Stripe, Resend) only fail in production;
 *   in development they produce a warning listing the missing vars.
 *
 * Never prints secret values — only variable names.
 */
export function validateCoreEnv() {
  // 1. Core: always required
  const coreResult = coreEnvSchema.safeParse(process.env);
  if (!coreResult.success) {
    const missing = coreResult.error.issues.map((i) => i.path.join("."));
    throw new Error(
      `Missing or invalid core environment variables:\n` +
        missing.map((v) => `  - ${v}`).join("\n") +
        `\n\nCopy .env.example to .env.local and fill in the values.`
    );
  }

  // 2. External services: required in production, warn in development
  const extResult = externalEnvSchema.safeParse(process.env);
  if (!extResult.success) {
    const missing = extResult.error.issues.map((i) => i.path.join("."));
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `Missing required production environment variables:\n` +
          missing.map((v) => `  - ${v}`).join("\n")
      );
    } else {
      console.warn(
        `[env] ⚠ Optional external-service variables not set (features will be limited):\n` +
          missing.map((v) => `  - ${v}`).join("\n")
      );
    }
  }

  return coreResult.data;
}
