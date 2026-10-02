import NextAuth, { type NextAuthConfig } from "next-auth";
import Resend from "next-auth/providers/resend";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db/client";
import { ensureWorkspaceForUser, getPrimaryWorkspace } from "@/lib/workspace";

type AdapterPrismaClient = Parameters<typeof PrismaAdapter>[0];

export interface DevMagicLink {
  email: string;
  url: string;
  createdAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __lastDevMagicLink: DevMagicLink | undefined;
}

export function getLastDevMagicLink(): DevMagicLink | null {
  const link = globalThis.__lastDevMagicLink;
  if (!link) return null;
  if (Date.now() - link.createdAt > 15 * 60 * 1000) {
    return null;
  }
  return link;
}

export function setLastDevMagicLink(email: string, url: string) {
  globalThis.__lastDevMagicLink = {
    email,
    url,
    createdAt: Date.now(),
  };
}

export const authConfig = {
  adapter: PrismaAdapter(prisma as unknown as AdapterPrismaClient),
  providers: [
    Resend({
      apiKey: process.env.RESEND_API_KEY ?? "missing-resend-api-key",
      from: process.env.EMAIL_FROM ?? "CampaignCue <login@example.com>",
      async sendVerificationRequest({ identifier: to, provider, url }) {
        setLastDevMagicLink(to, url);

        console.log("\n============================================================");
        console.log(`🔗 LOGIN MAGIC LINK for ${to}:`);
        console.log(url);
        console.log("============================================================\n");

        const apiKey = provider.apiKey;
        const isRealKey =
          typeof apiKey === "string" &&
          apiKey.length > 5 &&
          !apiKey.startsWith("re_...") &&
          apiKey !== "missing-resend-api-key";

        if (isRealKey) {
          try {
            const { host } = new URL(url);
            const res = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                from: provider.from,
                to,
                subject: `Sign in to ${host}`,
                html: `<p>Sign in to <b>${host}</b> by clicking below:</p><p><a href="${url}"><b>Sign in</b></a></p>`,
                text: `Sign in to ${host}\n\n${url}\n\n`,
              }),
            });

            if (!res.ok) {
              const errorText = await res.text();
              console.error("[auth] Resend email send failed:", errorText);
              if (process.env.NODE_ENV === "production") {
                throw new Error(`Failed to send verification email: ${errorText}`);
              }
            }
          } catch (error) {
            console.error("[auth] Error sending email via Resend:", error);
            if (process.env.NODE_ENV === "production") {
              throw error;
            }
          }
        } else {
          console.log(
            `[auth] Local/Dev mode: Resend API key is not configured. Use the magic link above to sign in.`
          );
        }
      },
    }),
  ],
  callbacks: {
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  events: {
    async createUser({ user }) {
      if (user.id) {
        await ensureWorkspaceForUser(user.id, user.email);
      }
    },
  },
  pages: {
    signIn: "/login",
    verifyRequest: "/login?checkEmail=1",
  },
  session: {
    strategy: "database",
  },
  trustHost: true,
  secret: process.env.NEXTAUTH_SECRET,
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

export async function getCurrentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

export async function getCurrentWorkspaceId(): Promise<string | null> {
  const userId = await getCurrentUserId();
  if (!userId) return null;

  const workspace = await getPrimaryWorkspace(userId);
  if (workspace) return workspace.id;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  const createdWorkspace = await ensureWorkspaceForUser(userId, user?.email);
  return createdWorkspace.id;
}
