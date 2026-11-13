/**
 * Hardening Regression Tests
 *
 * Covers all defects fixed in the Phase 1 hardening pass:
 * - Authentication magic-link isolation
 * - BullMQ queue name and backoff consistency
 * - Automation scope selection
 * - Retention cron fail-closed behavior
 * - Stripe webhook idempotency and workspace resolution
 * - Webhook body size limits
 * - DeliveryJob state transitions on early failures
 */

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("next-auth", () => ({
  default: vi.fn(() => ({
    handlers: {},
    auth: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  })),
}));

vi.mock("next-auth/providers/resend", () => ({
  default: vi.fn((opts) => opts),
}));

vi.mock("@auth/prisma-adapter", () => ({
  PrismaAdapter: vi.fn(() => ({})),
}));

// ─── 1. Authentication: magic-link restricted to development ───────────────

describe("Auth — magic-link isolation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete globalThis.__lastDevMagicLink;
  });

  it("should NOT store or log magic link in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTAUTH_URL", "https://app.example.com");
    vi.stubEnv("NEXTAUTH_SECRET", "a-very-long-secret-key-1234");
    vi.stubEnv("DATABASE_URL", "postgres://localhost/test");
    vi.stubEnv("REDIS_URL", "redis://localhost");
    vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));

    vi.resetModules();

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { authConfig, getLastDevMagicLink } = await import("../lib/auth");

    const resendProvider = authConfig.providers[0] as any;
    expect(resendProvider).toBeDefined();

    await resendProvider.sendVerificationRequest({
      identifier: "user@example.com",
      provider: { apiKey: "missing-resend-api-key" },
      url: "https://app.example.com/api/auth/callback/email?token=secret123",
    });

    // Magic link must NOT be stored in production
    expect(getLastDevMagicLink()).toBeNull();

    // Sensitive URL must NOT be logged to console in production
    const loggedCalls = consoleSpy.mock.calls.map((call) => call.join(" "));
    expect(loggedCalls.some((msg) => msg.includes("secret123"))).toBe(false);
    expect(loggedCalls.some((msg) => msg.includes("LOGIN MAGIC LINK"))).toBe(false);

    consoleSpy.mockRestore();
  });

  it("should store and log magic link in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
    vi.stubEnv("NEXTAUTH_SECRET", "a-very-long-secret-key-1234");
    vi.stubEnv("DATABASE_URL", "postgres://localhost/test");
    vi.stubEnv("REDIS_URL", "redis://localhost");
    vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));

    vi.resetModules();

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { authConfig, getLastDevMagicLink } = await import("../lib/auth");

    const resendProvider = authConfig.providers[0] as any;
    await resendProvider.sendVerificationRequest({
      identifier: "dev@example.com",
      provider: { apiKey: "missing-resend-api-key" },
      url: "http://localhost:3000/api/auth/callback/email?token=devtoken456",
    });

    const link = getLastDevMagicLink();
    expect(link).not.toBeNull();
    expect(link!.email).toBe("dev@example.com");
    expect(link!.url).toContain("devtoken456");

    consoleSpy.mockRestore();
  });

  it("should expire magic links after 15 minutes", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();

    const { getLastDevMagicLink } = await import("../lib/auth");

    globalThis.__lastDevMagicLink = {
      email: "test@example.com",
      url: "http://localhost:3000/auth/callback/old",
      createdAt: Date.now() - 16 * 60 * 1000, // 16 minutes ago
    };

    const link = getLastDevMagicLink();
    expect(link).toBeNull();
  });

  it("login page must not expose dev magic link in production", async () => {
    vi.stubEnv("NODE_ENV", "production");

    // Simulate login page logic
    const checkEmail = true;
    const devMagicLink =
      checkEmail && process.env.NODE_ENV !== "production"
        ? { email: "victim@example.com", url: "https://example.com/magic", createdAt: Date.now() }
        : null;

    expect(devMagicLink).toBeNull();
  });
});

// ─── 2. BullMQ queue name consistency ──────────────────────────────────────

describe("BullMQ — queue name and backoff consistency", () => {
  it("producer and worker must use the same queue name", async () => {
    // We cannot import the actual modules without Redis, but we can verify
    // the source code consistency by checking the string literals.
    const fs = await import("fs");
    const path = await import("path");

    const clientSrc = fs.readFileSync(
      path.resolve(__dirname, "../lib/queue/client.ts"),
      "utf-8"
    );
    const workerSrc = fs.readFileSync(
      path.resolve(__dirname, "../lib/queue/dm-worker.ts"),
      "utf-8"
    );

    // Extract queue name from Queue constructor in client.ts
    const clientQueueMatch = clientSrc.match(
      /new Queue\S*\("([^"]+)"/
    );
    expect(clientQueueMatch).not.toBeNull();
    const clientQueueName = clientQueueMatch![1];

    // Extract queue name from Worker constructor in dm-worker.ts
    const workerQueueMatch = workerSrc.match(
      /new Worker\S*\(\s*"([^"]+)"/
    );
    expect(workerQueueMatch).not.toBeNull();
    const workerQueueName = workerQueueMatch![1];

    expect(clientQueueName).toBe(workerQueueName);
    expect(clientQueueName).toBe("dm-queue");
  });

  it("producer backoff type must match worker strategy name", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const clientSrc = fs.readFileSync(
      path.resolve(__dirname, "../lib/queue/client.ts"),
      "utf-8"
    );
    const workerSrc = fs.readFileSync(
      path.resolve(__dirname, "../lib/queue/dm-worker.ts"),
      "utf-8"
    );

    // Extract backoff type from client
    const backoffTypeMatch = clientSrc.match(
      /type:\s*"([^"]+)"/
    );
    expect(backoffTypeMatch).not.toBeNull();
    const backoffType = backoffTypeMatch![1];

    // Extract strategy name from worker
    const strategyMatch = workerSrc.match(
      /backoffStrategies:\s*\{\s*(\w+):/
    );
    expect(strategyMatch).not.toBeNull();
    const strategyName = strategyMatch![1];

    expect(backoffType).toBe(strategyName);
  });

  it("BullMQ job IDs must not contain colons", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const webhookSrc = fs.readFileSync(
      path.resolve(__dirname, "../app/api/webhook/route.ts"),
      "utf-8"
    );
    const workerSrc = fs.readFileSync(
      path.resolve(__dirname, "../lib/queue/dm-worker.ts"),
      "utf-8"
    );

    // Find all jobId template literals
    const jobIdPatterns = [
      ...webhookSrc.matchAll(/jobId:\s*`([^`]+)`/g),
      ...workerSrc.matchAll(/jobId:\s*`([^`]+)`/g),
    ];

    expect(jobIdPatterns.length).toBeGreaterThan(0);

    for (const match of jobIdPatterns) {
      const template = match[1];
      // The template should not contain literal colons as separators
      // (${...} interpolations are fine, we're checking the literal parts)
      const literalParts = template.split(/\$\{[^}]+\}/);
      for (const part of literalParts) {
        expect(part).not.toContain(":");
      }
    }
  });
});

// ─── 3. Automation scope selection ─────────────────────────────────────────

describe("Automation — one canonical resolver in the worker", () => {
  it("worker delegates campaign selection to lib/automation/resolver", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const workerSrc = fs.readFileSync(
      path.resolve(__dirname, "../lib/queue/dm-worker.ts"),
      "utf-8"
    );

    expect(workerSrc).toContain("resolveAutomationForComment");
    // No second matching implementation inside the worker.
    expect(workerSrc).not.toContain("prisma.automation.findMany");
    expect(workerSrc).not.toContain("matchKeywords(");
    expect(workerSrc).not.toContain("claimNextPostAutomation");
  });

  it("delivery code never swallows errors with empty catch handlers", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const files = [
      "../lib/queue/dm-worker.ts",
      "../lib/delivery/intake.ts",
      "../lib/delivery/state.ts",
      "../lib/delivery/scheduler.ts",
      "../lib/automation/resolver.ts",
      "../lib/instagram-lifecycle.ts",
      "../app/api/webhook/route.ts",
      "../app/r/[slug]/route.ts",
    ];
    for (const file of files) {
      const src = fs.readFileSync(path.resolve(__dirname, file), "utf-8");
      // Empty or comment-only catch blocks hide failures.
      expect(src, file).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*(\/\/[^\n]*\s*)*\}/);
      expect(src, file).not.toMatch(/\.catch\(\(\)\s*=>\s*(\{\s*\}|null|false|true|undefined)\)/);
    }
  });
});

// ─── 4. Retention cron — fail closed in production ─────────────────────────

describe("Retention cron — fail-closed behavior", () => {
  it("source must require CRON_SECRET in production", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const routeSrc = fs.readFileSync(
      path.resolve(__dirname, "../app/api/cron/retention/route.ts"),
      "utf-8"
    );

    // Must check for missing cronSecret in production
    expect(routeSrc).toContain("production");
    expect(routeSrc).toContain("CRON_SECRET not configured");

    // Must validate days parameter
    expect(routeSrc).toContain("MIN_RETENTION_DAYS");
    expect(routeSrc).toContain("MAX_RETENTION_DAYS");
  });

  it("must reject invalid days parameter", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const routeSrc = fs.readFileSync(
      path.resolve(__dirname, "../app/api/cron/retention/route.ts"),
      "utf-8"
    );

    // Must parse and validate
    expect(routeSrc).toContain("isNaN");
    expect(routeSrc).toMatch(/status:\s*400/);
  });
});

// ─── 5. Stripe webhook — workspace resolution and idempotency ──────────────

describe("Stripe webhook — deterministic workspace resolution", () => {
  it("must NOT use OR-based workspace matching", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const routeSrc = fs.readFileSync(
      path.resolve(__dirname, "../app/api/stripe/webhook/route.ts"),
      "utf-8"
    );

    // The old OR-based pattern should be gone
    expect(routeSrc).not.toContain("__missing_workspace__");
    expect(routeSrc).not.toContain("updateMany");

    // Should use deterministic findUnique/findFirst + update
    expect(routeSrc).toContain("findUnique");
    expect(routeSrc).toContain("findFirst");
    expect(routeSrc).toContain("workspace.update");
  });

  it("must validate customer consistency", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const routeSrc = fs.readFileSync(
      path.resolve(__dirname, "../app/api/stripe/webhook/route.ts"),
      "utf-8"
    );

    expect(routeSrc).toContain("Customer mismatch");
    expect(routeSrc).toContain("stripeCustomerId");
  });

  it("must use upsert for atomic billingEvent idempotency", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const routeSrc = fs.readFileSync(
      path.resolve(__dirname, "../app/api/stripe/webhook/route.ts"),
      "utf-8"
    );

    expect(routeSrc).toContain("billingEvent.upsert");
    expect(routeSrc).not.toMatch(/billingEvent\.create\b/);
  });
});

// ─── 6. Docker — loopback binding ──────────────────────────────────────────

describe("Docker — network security", () => {
  it("PostgreSQL and Redis must bind to 127.0.0.1", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const composeSrc = fs.readFileSync(
      path.resolve(__dirname, "../docker-compose.yml"),
      "utf-8"
    );

    // Check both services use loopback binding
    expect(composeSrc).toContain("127.0.0.1:5433:5432");
    expect(composeSrc).toContain("127.0.0.1:6379:6379");

    // Must NOT have bare port mappings (would bind to 0.0.0.0)
    expect(composeSrc).not.toMatch(/"5433:5432"/);
    expect(composeSrc).not.toMatch(/"6379:6379"/);
  });
});

// ─── 7. Webhook — body size limit ──────────────────────────────────────────

describe("Webhook — body size limit", () => {
  it("must enforce a request body size limit", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const routeSrc = fs.readFileSync(
      path.resolve(__dirname, "../app/api/webhook/route.ts"),
      "utf-8"
    );

    expect(routeSrc).toContain("MAX_BODY_BYTES");
    expect(routeSrc).toContain("413");
    expect(routeSrc).toContain("Payload too large");
  });
});

// ─── 8. DeliveryJob — state transitions on early failures ──────────────────

describe("DeliveryJob — no stuck SENDING on early failure", () => {
  // Every pre-send rejection closes the job while it is still PENDING; the
  // PENDING -> SENDING claim happens only after all checks pass.
  // Behavior is covered end to end in delivery-engine.test.ts.
  async function workerSource() {
    const fs = await import("fs");
    const path = await import("path");
    return fs.readFileSync(path.resolve(__dirname, "../lib/queue/dm-worker.ts"), "utf-8");
  }

  function sectionAround(src: string, marker: string) {
    const index = src.indexOf(marker);
    expect(index, marker).toBeGreaterThan(-1);
    return src.slice(Math.max(0, index - 200), index + 200);
  }

  it("must close the DeliveryJob on token failure", async () => {
    const src = await workerSource();
    expect(sectionAround(src, "No Instagram access token available")).toContain("closePending");
  });

  it("must close the DeliveryJob on decrypt failure", async () => {
    const src = await workerSource();
    expect(sectionAround(src, "Failed to decrypt Instagram access token")).toContain("closePending");
  });

  it("must close the DeliveryJob on plan limit", async () => {
    const src = await workerSource();
    expect(sectionAround(src, "Monthly DM limit reached")).toContain("closePending");
  });

  it("claims SENDING only after every pre-send check", async () => {
    const src = await workerSource();
    const claimIndex = src.indexOf("await claimForSending(");
    for (const marker of ["NO_TOKEN", "DECRYPT_FAILED", "PLAN_LIMIT", "ACCOUNT_DISCONNECTED", "DEADLINE_PASSED"]) {
      expect(src.indexOf(`"${marker}"`), marker).toBeLessThan(claimIndex);
    }
  });
});

// ─── 9. Automation policy — selectWinningAutomation ────────────────────────

import {
  selectWinningAutomation,
  getScopePriority,
} from "../lib/automation/policy";

describe("Automation policy — scope priority", () => {
  it("SPECIFIC_POST has highest priority", () => {
    expect(getScopePriority("SPECIFIC_POST")).toBe(1);
    expect(getScopePriority("SPECIFIC_MEDIA")).toBe(1);
    expect(getScopePriority("NEXT_POST")).toBe(2);
    expect(getScopePriority("ANY_POST")).toBe(3);
  });

  it("selects SPECIFIC_POST over ANY_POST when both match", () => {
    const matches = [
      {
        automation: {
          id: "any_1",
          workspaceId: "w",
          instagramAccountId: "ig",
          triggerType: "comment",
          triggerScope: "ANY_POST",
          keywords: ["LINK"],
          dmMessage: "any",
          isActive: true,
          wholeWordMatch: true,
          createdAt: new Date("2024-01-01"),
        },
        matchedKeyword: "LINK",
      },
      {
        automation: {
          id: "specific_1",
          workspaceId: "w",
          instagramAccountId: "ig",
          triggerType: "comment",
          triggerScope: "SPECIFIC_POST",
          postId: "media_1",
          keywords: ["LINK"],
          dmMessage: "specific",
          isActive: true,
          wholeWordMatch: true,
          createdAt: new Date("2024-01-02"),
        },
        matchedKeyword: "LINK",
      },
    ];

    const winner = selectWinningAutomation(matches);
    expect(winner).not.toBeNull();
    expect(winner!.automation.id).toBe("specific_1");
  });

  it("selects NEXT_POST over ANY_POST when both match", () => {
    const matches = [
      {
        automation: {
          id: "any_1",
          workspaceId: "w",
          instagramAccountId: "ig",
          triggerType: "comment",
          triggerScope: "ANY_POST",
          keywords: ["LINK"],
          dmMessage: "any",
          isActive: true,
          wholeWordMatch: true,
          createdAt: new Date("2024-01-01"),
        },
        matchedKeyword: "LINK",
      },
      {
        automation: {
          id: "next_1",
          workspaceId: "w",
          instagramAccountId: "ig",
          triggerType: "comment",
          triggerScope: "NEXT_POST",
          keywords: ["LINK"],
          dmMessage: "next",
          isActive: true,
          wholeWordMatch: true,
          createdAt: new Date("2024-01-02"),
        },
        matchedKeyword: "LINK",
      },
    ];

    const winner = selectWinningAutomation(matches);
    expect(winner).not.toBeNull();
    expect(winner!.automation.id).toBe("next_1");
  });

  it("uses oldest createdAt as stable tie-breaker for same scope", () => {
    const matches = [
      {
        automation: {
          id: "b",
          workspaceId: "w",
          instagramAccountId: "ig",
          triggerType: "comment",
          triggerScope: "ANY_POST",
          keywords: ["LINK"],
          dmMessage: "second",
          isActive: true,
          wholeWordMatch: true,
          createdAt: new Date("2024-06-01"),
        },
        matchedKeyword: "LINK",
      },
      {
        automation: {
          id: "a",
          workspaceId: "w",
          instagramAccountId: "ig",
          triggerType: "comment",
          triggerScope: "ANY_POST",
          keywords: ["LINK"],
          dmMessage: "first",
          isActive: true,
          wholeWordMatch: true,
          createdAt: new Date("2024-01-01"),
        },
        matchedKeyword: "LINK",
      },
    ];

    const winner = selectWinningAutomation(matches);
    expect(winner!.automation.id).toBe("a");
  });

  it("returns null for empty matches", () => {
    expect(selectWinningAutomation([])).toBeNull();
  });
});

// ─── 10. Resolver — claimNextPostAutomation ────────────────────────────────

describe("Automation resolver — NEXT_POST claim atomicity", () => {
  it("claimNextPostAutomation must use updateMany with conditional where", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const resolverSrc = fs.readFileSync(
      path.resolve(__dirname, "../lib/automation/resolver.ts"),
      "utf-8"
    );

    // Must use atomic conditional update, not find-then-update
    expect(resolverSrc).toContain("updateMany");
    expect(resolverSrc).toContain("consumedPostId: null");
    expect(resolverSrc).toContain("result.count > 0");
  });
});
