/**
 * Bug 10 — disconnect is a lifecycle change that never deletes data.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  unsubscribe: vi.fn(),
  context: { workspaceId: "ws_1", role: "OWNER" } as { workspaceId: string; role: string } | null,
}));

vi.mock("@/lib/db/client", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  return { prisma: createFakePrisma() };
});
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "plain-token" }));
vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  unsubscribeInstagramAccountFromWebhooks: h.unsubscribe,
}));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: async () => h.context,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));

import { prisma } from "@/lib/db/client";
import type { FakePrisma } from "./helpers/fake-prisma";
import { POST } from "../app/api/instagram/disconnect/route";
import { connectInstagramAccount, disconnectInstagramAccount } from "@/lib/instagram-lifecycle";
import { canConnectInstagramAccount } from "@/lib/instagram-accounts";
import { MetaApiError } from "@/lib/meta/client";

const db = prisma as unknown as FakePrisma;

function seed() {
  db.seed("instagramAccount", {
    id: "acc_1",
    workspaceId: "ws_1",
    instagramId: "ig_1",
    username: "brand",
    accessToken: "encrypted",
    tokenExpiresAt: new Date("2027-01-01"),
    webhookSubscribed: true,
  });
  db.seed("automation", { id: "auto_1", workspaceId: "ws_1", instagramAccountId: "acc_1", name: "C", dmMessage: "m" });
  db.seed("contact", { id: "contact_1", workspaceId: "ws_1", instagramAccountId: "acc_1", instagramUserId: "u1" });
  db.seed("trackedLink", { id: "link_1", workspaceId: "ws_1", automationId: "auto_1", slug: "s1", destinationUrl: "https://x.com" });
  db.seed("linkClick", { workspaceId: "ws_1", automationId: "auto_1", instagramAccountId: "acc_1", trackedLinkId: "link_1" });
  const job = (id: string, status: string) =>
    db.seed("deliveryJob", {
      id,
      workspaceId: "ws_1",
      instagramAccountId: "acc_1",
      automationId: "auto_1",
      triggerId: `c_${id}`,
      recipientId: `u_${id}`,
      messagePayload: "m",
      status,
      dedupKey: status === "PENDING" || status === "SENT" ? `auto_1:u_${id}` : null,
    });
  job("job_sent", "SENT");
  job("job_pending", "PENDING");
}

async function callRoute(body: unknown) {
  return POST(
    new Request("https://app.test/api/instagram/disconnect", {
      method: "POST",
      body: JSON.stringify(body),
    }) as Parameters<typeof POST>[0]
  );
}

beforeEach(() => {
  db.reset();
  seed();
  h.unsubscribe.mockReset();
  h.unsubscribe.mockResolvedValue({ success: true });
  h.context = { workspaceId: "ws_1", role: "OWNER" };
});

describe("Instagram disconnect lifecycle", () => {
  it("preserves the account, campaigns, deliveries, contacts and clicks", async () => {
    const response = await callRoute({ instagramAccountId: "acc_1" });
    expect(response.status).toBe(200);

    expect(db.tables.instagramAccount).toHaveLength(1);
    expect(db.tables.automation).toHaveLength(1);
    expect(db.tables.deliveryJob).toHaveLength(2);
    expect(db.tables.contact).toHaveLength(1);
    expect(db.tables.linkClick).toHaveLength(1);
    expect(db.tables.deliveryJob.find((j) => j.id === "job_sent")!.status).toBe("SENT");
  });

  it("records status, timestamp and reason, and clears the stored token", async () => {
    await disconnectInstagramAccount({ workspaceId: "ws_1", accountId: "acc_1" });
    expect(db.tables.instagramAccount[0]).toMatchObject({
      status: "DISCONNECTED",
      disconnectReason: "USER_REQUESTED",
      accessToken: "",
      tokenExpiresAt: null,
      webhookSubscribed: false,
      webhookUnsubscribeError: null,
    });
    expect(db.tables.instagramAccount[0].disconnectedAt).toBeInstanceOf(Date);
    expect(h.unsubscribe).toHaveBeenCalledWith("ig_1", "plain-token");
  });

  it("cancels queued deliveries so they can never send", async () => {
    const result = await disconnectInstagramAccount({ workspaceId: "ws_1", accountId: "acc_1" });
    expect(result).toMatchObject({ status: "DISCONNECTED", cancelledDeliveries: 1 });
    expect(db.tables.deliveryJob.find((j) => j.id === "job_pending")).toMatchObject({
      status: "FAILED",
      errorCode: "ACCOUNT_DISCONNECTED",
      dedupKey: null,
    });
  });

  it("makes a Meta unsubscription failure observable and never claims success", async () => {
    h.unsubscribe.mockRejectedValue(new MetaApiError(100, undefined, undefined, "Unsupported delete request"));
    const result = await disconnectInstagramAccount({ workspaceId: "ws_1", accountId: "acc_1" });

    expect(result).toMatchObject({ status: "DISCONNECTED", webhookUnsubscribed: false });
    const account = db.tables.instagramAccount[0];
    expect(account.status).toBe("DISCONNECTED"); // local disconnect still completes
    expect(account.webhookSubscribed).toBe(true); // still possibly subscribed at Meta
    expect(account.webhookUnsubscribedAt).toBeNull();
    expect(account.webhookUnsubscribeError).toContain("Unsupported delete request");
    expect(db.tables.operationalEvent[0]).toMatchObject({ level: "WARNING", workspaceId: "ws_1" });
  });

  it("is idempotent", async () => {
    await disconnectInstagramAccount({ workspaceId: "ws_1", accountId: "acc_1" });
    const second = await disconnectInstagramAccount({ workspaceId: "ws_1", accountId: "acc_1" });
    expect(second.status).toBe("ALREADY_DISCONNECTED");
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("enforces workspace ownership and role", async () => {
    expect((await disconnectInstagramAccount({ workspaceId: "ws_other", accountId: "acc_1" })).status).toBe("NOT_FOUND");
    expect(db.tables.instagramAccount[0].status).toBe("CONNECTED");

    h.context = { workspaceId: "ws_1", role: "MEMBER" };
    expect((await callRoute({ instagramAccountId: "acc_1" })).status).toBe(403);

    h.context = { workspaceId: "ws_1", role: "OWNER" };
    expect((await callRoute({})).status).toBe(400); // never "disconnect everything"
  });

  it("reconnecting in the same workspace reuses the row (no duplicates)", async () => {
    await disconnectInstagramAccount({ workspaceId: "ws_1", accountId: "acc_1" });
    expect(
      (await canConnectInstagramAccount({ workspaceId: "ws_1", plan: "FREE", subscriptionStatus: "NONE", instagramId: "ig_1" })).allowed
    ).toBe(true);

    await connectInstagramAccount({
      workspaceId: "ws_1",
      instagramId: "ig_1",
      username: "brand",
      name: null,
      encryptedToken: "new-encrypted",
      tokenExpiresAt: new Date("2027-02-01"),
      webhookSubscribed: true,
    });

    expect(db.tables.instagramAccount).toHaveLength(1);
    expect(db.tables.instagramAccount[0]).toMatchObject({
      id: "acc_1",
      status: "CONNECTED",
      accessToken: "new-encrypted",
      disconnectedAt: null,
      webhookUnsubscribeError: null,
    });
    expect(db.tables.deliveryJob).toHaveLength(2); // history still attached
  });

  it("a disconnected account can move to another workspace without exposing old history", async () => {
    await disconnectInstagramAccount({ workspaceId: "ws_1", accountId: "acc_1" });
    expect(
      (await canConnectInstagramAccount({ workspaceId: "ws_2", plan: "FREE", subscriptionStatus: "NONE", instagramId: "ig_1" })).allowed
    ).toBe(true);

    const created = await connectInstagramAccount({
      workspaceId: "ws_2",
      instagramId: "ig_1",
      username: "brand",
      name: null,
      encryptedToken: "t",
      tokenExpiresAt: new Date("2027-02-01"),
      webhookSubscribed: true,
    });

    expect(created.id).not.toBe("acc_1");
    const old = db.tables.instagramAccount.find((a) => a.id === "acc_1")!;
    expect(old).toMatchObject({ workspaceId: "ws_1", status: "DISCONNECTED", instagramId: "archived-acc_1" });
    expect(db.tables.deliveryJob.every((j) => j.instagramAccountId === "acc_1")).toBe(true);
  });

  it("a connected account cannot be taken over by another workspace", async () => {
    const result = await canConnectInstagramAccount({
      workspaceId: "ws_2",
      plan: "FREE",
      subscriptionStatus: "NONE",
      instagramId: "ig_1",
    });
    expect(result).toMatchObject({ allowed: false, reason: "already_connected" });
  });
});
