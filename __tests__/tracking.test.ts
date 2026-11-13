import { describe, expect, it } from "vitest";
import {
  calculateCtr,
  normalizeTopKeywords,
  summarizeDmStatuses,
} from "../lib/tracking/analytics";
import {
  buildTrackedUrl,
  extractFirstUrl,
  replaceUrlWithTrackedPlaceholder,
} from "../lib/tracking/message";
import { renderDmMessage } from "../lib/delivery/renderer";

describe("tracked link messages", () => {
  it("extracts a destination URL and replaces it with the tracked placeholder", () => {
    const message =
      "Hey {username}, here is your guide: https://example.com/guide.";
    const url = extractFirstUrl(message);

    expect(url).toBe("https://example.com/guide");
    expect(replaceUrlWithTrackedPlaceholder(message, url)).toBe(
      "Hey {username}, here is your guide: {link}."
    );
  });

  // Rendering now goes through the single canonical renderer. {username}
  // renders as "@handle" everywhere (the old tracking renderer omitted "@").
  it("renders tracked URLs with username personalization", () => {
    expect(
      renderDmMessage("Hey {username}, grab it here: {link}", {
        username: "Maya",
        trackedUrl: buildTrackedUrl("abc123", "https://campaigncue.com"),
        destinationUrl: "https://example.com/guide",
      })
    ).toBe("Hey @Maya, grab it here: https://campaigncue.com/r/abc123");
  });

  it("can replace a raw destination URL when the placeholder is missing", () => {
    expect(
      renderDmMessage("Link: https://example.com/guide", {
        trackedUrl: buildTrackedUrl("abc123", "https://campaigncue.com/"),
        destinationUrl: "https://example.com/guide",
      })
    ).toBe("Link: https://campaigncue.com/r/abc123");
  });

  it("matches normalized root URLs with or without trailing slash", () => {
    expect(
      replaceUrlWithTrackedPlaceholder("Link: https://example.com", "https://example.com/")
    ).toBe("Link: {link}");
    expect(
      renderDmMessage("Link: https://example.com", {
        trackedUrl: buildTrackedUrl("abc123", "https://campaigncue.com"),
        destinationUrl: "https://example.com/",
      })
    ).toBe("Link: https://campaigncue.com/r/abc123");
  });

  it("builds redirect URLs from a base URL", () => {
    expect(buildTrackedUrl("abc123", "https://campaigncue.com/")).toBe(
      "https://campaigncue.com/r/abc123"
    );
  });

  it("appends delivery attribution through the same canonical builder", () => {
    expect(
      buildTrackedUrl("abc123", "https://campaigncue.com", {
        deliveryJobId: "job_1",
        signature: "sig",
      })
    ).toBe("https://campaigncue.com/r/abc123?d=job_1&s=sig");
  });
});

describe("campaign analytics helpers", () => {
  it("summarizes DM status rows", () => {
    expect(
      summarizeDmStatuses([
        { status: "SENT", _count: 20 },
        { status: "FAILED", _count: 2 },
        { status: "SKIPPED_RATE_LIMIT", _count: 3 },
        { status: "SKIPPED_PLAN_LIMIT", _count: 1 },
      ])
    ).toEqual({ sent: 20, skipped: 4, failed: 2 });
  });

  it("calculates CTR and handles empty send volume", () => {
    expect(calculateCtr(5, 20)).toBe(25);
    expect(calculateCtr(2, 3)).toBe(66.7);
    expect(calculateCtr(5, 0)).toBe(0);
  });

  it("normalizes top keywords by count", () => {
    expect(
      normalizeTopKeywords([
        { matchedKeyword: "PRICE", _count: 3 },
        { matchedKeyword: null, _count: 9 },
        { matchedKeyword: "LINK", _count: 7 },
      ])
    ).toEqual([
      { keyword: "LINK", count: 7 },
      { keyword: "PRICE", count: 3 },
    ]);
  });
});
