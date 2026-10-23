import { signIn, getLastDevMagicLink } from "@/lib/auth";
import { getCampaignTemplate } from "@/lib/templates/campaign-templates";

export const metadata = {
  title: "Login - CampaignCue",
  description: "Sign in to manage Instagram comment-to-DM campaigns.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    checkEmail?: string;
    callbackUrl?: string;
    template?: string;
    error?: string;
  }>;
}) {
  const params = await searchParams;
  const checkEmail = params.checkEmail === "1";
  const authError = params.error;
  const devMagicLink = checkEmail && process.env.NODE_ENV !== "production" ? getLastDevMagicLink() : null;
  const selectedTemplate = getCampaignTemplate(params.template);
  const templateCallbackUrl = selectedTemplate
    ? `/campaigns/new?template=${selectedTemplate.slug}`
    : null;
  const callbackUrl = params.callbackUrl ?? templateCallbackUrl ?? "/dashboard";

  async function sendMagicLink(formData: FormData) {
    "use server";
    await signIn("resend", {
      email: String(formData.get("email") ?? ""),
      redirectTo: callbackUrl,
    });
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center gradient-mesh overflow-hidden px-6">
      <div className="relative z-10 w-full max-w-md animate-fade-in">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-accent/10 border border-accent/20 mb-5">
            <svg
              className="w-7 h-7 text-accent"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm3.75 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm3.75 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z"
              />
            </svg>
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            CampaignCue
          </h1>
          <p className="text-muted text-sm leading-relaxed mt-2">
            {selectedTemplate
              ? `Sign in to use the ${selectedTemplate.title} template.`
              : "Sign in by email, then connect your Instagram professional account."}
          </p>
        </div>

        <div className="glass-strong rounded-2xl p-8 shadow-2xl shadow-black/40">
          {authError && (
            <div className="mb-5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">
              <strong className="font-semibold block mb-1">Authentication Error:</strong>
              {authError === "Verification"
                ? "The sign-in link is invalid or has already been used. Please request a new one."
                : `Sign-in failed (${authError}). Please try again.`}
            </div>
          )}

          {selectedTemplate && !checkEmail && (
            <div className="mb-5 border border-cyan-200/20 bg-cyan-300/10 p-4 rounded-xl">
              <p className="text-xs font-semibold uppercase tracking-wide text-cyan-100">
                Template selected
              </p>
              <p className="mt-2 text-sm font-semibold text-white">
                {selectedTemplate.title}
              </p>
            </div>
          )}

          {checkEmail ? (
            <div className="text-center py-4">
              <h2 className="text-lg font-semibold mb-2">Check your email</h2>
              <p className="text-sm text-muted">
                We sent you a secure sign-in link. Open it on this device to
                continue.
              </p>

              {devMagicLink ? (
                <div className="mt-6 rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-5 text-left">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="inline-flex items-center rounded-full bg-indigo-500/20 px-2.5 py-0.5 text-xs font-semibold text-indigo-300">
                      Development Mode
                    </span>
                    <span className="text-xs text-muted">Direct Sign-In</span>
                  </div>
                  <p className="text-xs text-muted mb-4">
                    Magic link ready for <strong className="text-foreground">{devMagicLink.email}</strong>:
                  </p>
                  <a
                    href={devMagicLink.url}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all hover:brightness-110"
                  >
                    Click here to complete sign-in →
                  </a>
                </div>
              ) : null}

              <div className="mt-6 pt-4 border-t border-border/50">
                <a
                  href="/login"
                  className="text-xs text-muted hover:text-foreground transition-colors"
                >
                  ← Back to login
                </a>
              </div>
            </div>
          ) : (
            <form action={sendMagicLink} className="space-y-5">
              <div className="space-y-2">
                <label
                  htmlFor="email"
                  className="block text-sm font-medium text-foreground"
                >
                  Work email
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  defaultValue="demo@campaigncue.com"
                  placeholder="you@company.com"
                  className="w-full px-4 py-3 rounded-xl bg-surface border border-border text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none transition-colors"
                />
              </div>

              <button
                type="submit"
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all hover:shadow-xl hover:shadow-indigo-500/30"
              >
                Email me a magic link
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
