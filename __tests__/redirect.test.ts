/**
 * Bug 6 — tracked link clicks are attributed to the delivery and contact,
 * only when the attribution is signed and belongs to the same tenant.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NEXTAUTH_SECRET = "test-secret-for-tracked-link-signatures";

vi.mock("@/lib/db/client", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  return { prisma: createFakePrisma() };
});

import { prisma } from "@/lib/db/client";
import type { FakePrisma } from "./helpers/fake-prisma";
import { GET } from "../app/r/[slug]/route";
import { buildDeliveryTrackedUrl, signDeliveryAttribution } from "@/lib/tracking/attribution";

const db = prisma as unknown as FakePrisma;

function seed() {
  db.seed("instagramAccount", { id: "acc_a", workspaceId: "ws_a", instagramId: "ig_a", username: "a", accessToken: "x" });
  db.seed("instagramAccount", { id: "acc_b", workspaceId: "ws_b", instagramId: "ig_b", username: "b", accessToken: "x" });
  db.seed("automation", { id: "auto_a", workspaceId: "ws_a", instagramAccountId: "acc_a", name: "A", dmMessage: "m" });
  db.seed("automation", { id: "auto_b", workspaceId: "ws_b", instagramAccountId: "acc_b", name: "B", dmMessage: "m" });
  db.seed("trackedLink", { id: "link_a", workspaceId: "ws_a", automationId: "auto_a", slug: "slugA", destinationUrl: "https://example.com/offer" });
  db.seed("contact", { id: "contact_a", workspaceId: "ws_a", instagramAccountId: "acc_a", instagramUserId: "user_1" });
  db.seed("contact", { id: "contact_b", workspaceId: "ws_b", instagramAccountId: "acc_b", instagramUserId: "user_2" });
  const job = (id: string, ws: string, acc: string, auto: string, contactId: string) =>
    db.seed("deliveryJob", {
      id,
      workspaceId: ws,
      instagramAccountId: acc,
      automationId: auto,
      contactId,
      triggerId: `comment_${id}`,
      recipientId: "user",
      messagePayload: "m",
      status: "SENT",
    });
  job("job_a", "ws_a", "acc_a", "auto_a", "contact_a");
  job("job_b", "ws_b", "acc_b", "auto_b", "contact_b");
}

async function click(url: string) {
  const parsed = new URL(url);
  const slug = parsed.pathname.split("/").pop()!;
  return GET(
    new Request(url, {
      headers: { "user-agent": "vitest", referer: "https://instagram.com/", "x-forwarded-for": "203.0.113.10" },
    }) as Parameters<typeof GET>[0],
    { params: Promise.resolve({ slug }) }
  );
}

beforeEach(() => {
  db.reset();
  seed();
});

describe("tracked link redirect route", () => {
  it("attributes a valid delivery click to its contact and delivery", async () => {
    const response = await click(buildDeliveryTrackedUrl("slugA", "job_a", "https://campaigncue.test"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/offer");
    expect(db.tables.linkClick[0]).toMatchObject({
      workspaceId: "ws_a",
      automationId: "auto_a",
      instagramAccountId: "acc_a",
      trackedLinkId: "link_a",
      deliveryJobId: "job_a",
      contactId: "contact_a",
      userAgent: "vitest",
    });
    expect(db.tables.contactEvent[0]).toMatchObject({ type: "LINK_CLICK", contactId: "contact_a" });
  });

  it("does not attribute an unsigned or forged delivery ID", async () => {
    await click("https://campaigncue.test/r/slugA?d=job_a");
    await click(`https://campaigncue.test/r/slugA?d=job_a&s=${"0".repeat(32)}`);
    await click(`https://campaigncue.test/r/slugA?d=job_a&s=${signDeliveryAttribution("job_a", "otherSlug")}`);

    expect(db.tables.linkClick).toHaveLength(3);
    for (const row of db.tables.linkClick) {
      expect(row.deliveryJobId).toBeNull();
      expect(row.contactId).toBeNull();
    }
    expect(db.tables.contactEvent).toHaveLength(0);
  });

  it("rejects a cross-workspace delivery even with a valid signature", async () => {
    await click(buildDeliveryTrackedUrl("slugA", "job_b", "https://campaigncue.test"));
    expect(db.tables.linkClick[0]).toMatchObject({ deliveryJobId: null, contactId: null, workspaceId: "ws_a" });
  });

  it("ignores a signed ID for a delivery that does not exist", async () => {
    await click(buildDeliveryTrackedUrl("slugA", "job_missing", "https://campaigncue.test"));
    expect(db.tables.linkClick[0].deliveryJobId).toBeNull();
  });

  it("records every click (existing analytics policy: no click de-duplication)", async () => {
    const url = buildDeliveryTrackedUrl("slugA", "job_a", "https://campaigncue.test");
    await click(url);
    await click(url);
    expect(db.tables.linkClick).toHaveLength(2);
    expect(db.tables.linkClick.every((c) => c.contactId === "contact_a")).toBe(true);
  });

  it("still tracks links shared without delivery attribution", async () => {
    const response = await click("https://campaigncue.test/r/slugA");
    expect(response.headers.get("location")).toBe("https://example.com/offer");
    expect(db.tables.linkClick[0]).toMatchObject({ trackedLinkId: "link_a", deliveryJobId: null });
  });

  it("redirects unknown slugs to the homepage without logging a click", async () => {
    const response = await click("https://campaigncue.test/r/missing");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://campaigncue.test/");
    expect(db.tables.linkClick).toHaveLength(0);
  });

  it("never redirects to an unsafe destination", async () => {
    db.tables.trackedLink[0].destinationUrl = "javascript:alert(1)";
    const response = await click("https://campaigncue.test/r/slugA");
    expect(response.headers.get("location")).toBe("https://campaigncue.test/");
  });
});
