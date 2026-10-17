import { describe, it, expect, vi, beforeEach } from "vitest";
import { isSafeDestinationUrl, sanitizeDestinationUrl } from "@/lib/tracking/links";
import { escapeCsvField, formatCsvRow } from "@/lib/export/csv";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    webhookEvent: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

import { cleanupExpiredWebhookEvents } from "@/lib/ops/retention";

describe("Phase 2 — Tracked Link Security", () => {
  it("allows safe http and https destination URLs", () => {
    expect(isSafeDestinationUrl("https://example.com/checkout")).toBe(true);
    expect(isSafeDestinationUrl("http://myblog.org/post/123")).toBe(true);
    expect(isSafeDestinationUrl("https://influencenexus.com/vip?ref=ig")).toBe(true);
  });

  it("strictly rejects dangerous or invalid URL schemes", () => {
    expect(isSafeDestinationUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeDestinationUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeDestinationUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeDestinationUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeDestinationUrl("not-a-url")).toBe(false);
    expect(isSafeDestinationUrl("")).toBe(false);
  });

  it("sanitizes destination URLs", () => {
    expect(sanitizeDestinationUrl("  https://example.com/offer  ")).toBe("https://example.com/offer");
    expect(sanitizeDestinationUrl("javascript:bad()")).toBeNull();
  });
});

describe("Phase 2 — RFC 4180 CSV Export Formatting", () => {
  it("escapes fields with commas, quotes, and newlines correctly", () => {
    expect(escapeCsvField("Simple")).toBe("Simple");
    expect(escapeCsvField("Hello, World")).toBe('"Hello, World"');
    expect(escapeCsvField('Said "Hello"')).toBe('"Said ""Hello"""');
    expect(escapeCsvField("Line 1\nLine 2")).toBe('"Line 1\nLine 2"');
    expect(escapeCsvField(null)).toBe("");
  });

  it("formats rows with carriage return and newline", () => {
    const row = formatCsvRow(["id_1", "username", "Hey, there!"]);
    expect(row).toBe('id_1,username,"Hey, there!"\r\n');
  });
});

describe("Phase 2 — Webhook Retention Batch Cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes expired webhook events in batches older than 30 days", async () => {
    mockPrisma.webhookEvent.findMany.mockResolvedValueOnce([
      { id: "evt_1" },
      { id: "evt_2" },
    ]);
    mockPrisma.webhookEvent.deleteMany.mockResolvedValueOnce({ count: 2 });

    const result = await cleanupExpiredWebhookEvents({ retentionDays: 30, batchSize: 2 });

    expect(result.deletedCount).toBe(2);
    expect(result.batchesExecuted).toBe(1);
    expect(mockPrisma.webhookEvent.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["evt_1", "evt_2"] } },
    });
  });

  it("stops immediately when no events are older than the cutoff", async () => {
    mockPrisma.webhookEvent.findMany.mockResolvedValueOnce([]);

    const result = await cleanupExpiredWebhookEvents({ retentionDays: 30 });

    expect(result.deletedCount).toBe(0);
    expect(result.batchesExecuted).toBe(0);
    expect(mockPrisma.webhookEvent.deleteMany).not.toHaveBeenCalled();
  });
});
