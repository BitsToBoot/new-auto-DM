"use client";

/**
 * New Campaign Page — Phase 2 Production Triggers & Variations
 */

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import KeywordInput from "@/components/keyword-input";
import PostPicker from "@/components/post-picker";
import { getCampaignTemplate } from "@/lib/templates/campaign-templates";
import {
  extractFirstUrl,
  replaceUrlWithTrackedPlaceholder,
} from "@/lib/tracking/message";

export default function NewCampaignPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedTemplate = getCampaignTemplate(searchParams.get("template"));
  const templateDestinationUrl = selectedTemplate
    ? extractFirstUrl(selectedTemplate.dmMessage)
    : null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(selectedTemplate?.title ?? "");
  const [goal, setGoal] = useState(selectedTemplate?.goal ?? "");
  const [triggerScope, setTriggerScope] = useState<"SPECIFIC_POST" | "NEXT_POST" | "ANY_POST">("SPECIFIC_POST");
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [postId, setPostId] = useState<string | null>(null);
  const [postUrl, setPostUrl] = useState<string | undefined>();
  const [keywords, setKeywords] = useState<string[]>(
    selectedTemplate?.keywords ?? []
  );
  const [dmMessage, setDmMessage] = useState(
    selectedTemplate
      ? replaceUrlWithTrackedPlaceholder(
          selectedTemplate.dmMessage,
          templateDestinationUrl
        )
      : ""
  );
  const [variations, setVariations] = useState<string[]>([]);
  const [newVariation, setNewVariation] = useState("");
  const [publicReplyMessage, setPublicReplyMessage] = useState("");
  const [trackedDestinationUrl, setTrackedDestinationUrl] = useState(
    templateDestinationUrl ?? ""
  );
  const [wholeWordMatch, setWholeWordMatch] = useState(true);
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    fetch("/api/dashboard/stats")
      .then((res) => res.json())
      .then((payload) => {
        if (payload.success) {
          const nextAccounts = payload.data.instagramAccounts ?? [];
          setAccounts(nextAccounts);
          setSelectedAccountId(
            payload.data.selectedInstagramAccountId ??
              nextAccounts[0]?.id ??
              ""
          );
        }
      })
      .catch(() => {
        setAccounts([]);
        setSelectedAccountId("");
      });
  }, []);

  function handleAccountChange(accountId: string) {
    setSelectedAccountId(accountId);
    setPostId(null);
    setPostUrl(undefined);
  }

  function addVariation() {
    if (!newVariation.trim()) return;
    if (variations.length >= 10) return;
    setVariations([...variations, newVariation.trim()]);
    setNewVariation("");
  }

  function removeVariation(index: number) {
    setVariations(variations.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name || !goal || keywords.length === 0 || !dmMessage) {
      setError("Please fill in all required fields");
      return;
    }

    if (triggerScope === "SPECIFIC_POST" && !postId) {
      setError("Please select an Instagram post or reel for Specific Post trigger");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const res = await fetch("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          goal,
          triggerScope,
          instagramAccountId: selectedAccountId,
          postId: triggerScope === "SPECIFIC_POST" ? postId : null,
          postUrl: triggerScope === "SPECIFIC_POST" ? (postUrl ?? null) : null,
          keywords,
          dmMessage,
          variations: variations.length > 0 ? variations : undefined,
          publicReplyMessage: publicReplyMessage.trim() || null,
          trackedDestinationUrl: trackedDestinationUrl || null,
          wholeWordMatch,
          isActive,
        }),
      });

      const data = await res.json();
      if (data.success) {
        router.push("/campaigns");
      } else {
        setError(data.error ?? "Failed to create campaign");
      }
    } catch {
      setError("Failed to create campaign");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto animate-fade-in pb-16">
      <form onSubmit={handleSubmit} className="space-y-8">
        {error && (
          <div className="p-4 rounded-xl bg-error/10 border border-error/20 text-error text-sm">
            {error}
          </div>
        )}

        {selectedTemplate && (
          <div className="border border-cyan-200/20 bg-cyan-300/10 p-4 rounded-xl">
            <p className="text-xs font-semibold uppercase tracking-wide text-cyan-100">
              Template loaded
            </p>
            <p className="mt-2 text-sm font-semibold text-white">
              {selectedTemplate.title}
            </p>
            <p className="mt-1 text-xs leading-5 text-zinc-300">
              Adjust triggers, copy, and launch when the connection is ready.
            </p>
          </div>
        )}

        {/* Name */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            Campaign Name <span className="text-error">*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Product launch link drop"
            className="w-full px-4 py-3 rounded-xl bg-surface border border-border text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none transition-colors"
            maxLength={100}
          />
        </div>

        {/* Goal */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            Campaign Goal <span className="text-error">*</span>
          </label>
          <select
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            className="w-full px-4 py-3 rounded-xl bg-surface border border-border text-sm text-foreground focus:border-accent/40 focus:outline-none transition-colors"
          >
            <option value="">Select a goal</option>
            <option value="Lead magnet delivery">Lead magnet delivery</option>
            <option value="Product link request">Product link request</option>
            <option value="Price or availability reply">Price or availability reply</option>
            <option value="Launch waitlist">Launch waitlist</option>
            <option value="Agency client campaign">Agency client campaign</option>
          </select>
        </div>

        {/* Trigger Scope */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            Automation Trigger Type <span className="text-error">*</span>
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <button
              type="button"
              onClick={() => setTriggerScope("SPECIFIC_POST")}
              className={`p-3.5 rounded-xl border text-left transition-all ${
                triggerScope === "SPECIFIC_POST"
                  ? "bg-accent/15 border-accent text-white"
                  : "bg-surface border-border text-zinc-400 hover:border-zinc-600"
              }`}
            >
              <div className="text-sm font-semibold">Specific Post</div>
              <div className="text-xs text-zinc-400 mt-1">Exact selected post or reel</div>
            </button>
            <button
              type="button"
              onClick={() => setTriggerScope("NEXT_POST")}
              className={`p-3.5 rounded-xl border text-left transition-all ${
                triggerScope === "NEXT_POST"
                  ? "bg-accent/15 border-accent text-white"
                  : "bg-surface border-border text-zinc-400 hover:border-zinc-600"
              }`}
            >
              <div className="text-sm font-semibold">Next Post</div>
              <div className="text-xs text-zinc-400 mt-1">Next post published after activation</div>
            </button>
            <button
              type="button"
              onClick={() => setTriggerScope("ANY_POST")}
              className={`p-3.5 rounded-xl border text-left transition-all ${
                triggerScope === "ANY_POST"
                  ? "bg-accent/15 border-accent text-white"
                  : "bg-surface border-border text-zinc-400 hover:border-zinc-600"
              }`}
            >
              <div className="text-sm font-semibold">Any Post</div>
              <div className="text-xs text-zinc-400 mt-1">All eligible posts and reels</div>
            </button>
          </div>
        </div>

        {/* Instagram Account */}
        <div className="space-y-2">
          <p className="block text-sm font-medium text-foreground">
            Instagram Account <span className="text-error">*</span>
          </p>
          {accounts.length > 0 ? (
            <AccountSelect
              accounts={accounts}
              value={selectedAccountId}
              onChange={handleAccountChange}
              includeAll={false}
              label="Connected profile"
            />
          ) : (
            <div className="rounded-xl border border-border bg-surface px-4 py-3 text-sm text-foreground">
              Connect Instagram before launching a campaign
            </div>
          )}
        </div>

        {/* Post Picker (shown when SPECIFIC_POST) */}
        {triggerScope === "SPECIFIC_POST" ? (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Campaign Post Or Reel <span className="text-error">*</span>
            </label>
            <p className="text-xs text-muted mb-3">
              Choose which Instagram post or reel should trigger the campaign.
            </p>
            <div className="glass rounded-xl p-4">
              <PostPicker
                selectedPostId={postId}
                instagramAccountId={selectedAccountId}
                onSelect={(id, url) => {
                  setPostId(id);
                  setPostUrl(url);
                }}
              />
            </div>
          </div>
        ) : (
          <div className="p-4 rounded-xl border border-white/10 bg-white/[0.02]">
            <p className="text-xs font-semibold text-zinc-300">
              {triggerScope === "NEXT_POST"
                ? "🎯 Next Post trigger is active: will automatically lock onto the next post published on this account."
                : "🌐 Any Post trigger is active: responds to matching comments across all eligible posts."}
            </p>
          </div>
        )}

        {/* Keywords */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium text-foreground">
              Comment Keywords <span className="text-error">*</span>
            </label>
            <span className="text-xs text-zinc-400">{keywords.length} / 20 max</span>
          </div>
          <p className="text-xs text-muted mb-1">
            When someone comments any of these keywords, the campaign sends the private reply.
          </p>
          <KeywordInput keywords={keywords} onChange={setKeywords} max={20} />
        </div>

        {/* Primary DM Message */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            Primary Private Reply Message <span className="text-error">*</span>
          </label>
          <textarea
            value={dmMessage}
            onChange={(e) => setDmMessage(e.target.value)}
            placeholder="Hey {username}! Here's the link you asked for: {link}"
            rows={4}
            className="w-full px-4 py-3 rounded-xl bg-surface border border-border text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none transition-colors resize-none"
            maxLength={1000}
          />
          <p className="text-xs text-muted">
            Personalize with <code className="px-1 py-0.5 rounded bg-surface-hover text-accent font-mono text-[11px]">{"{username}"}</code> and insert link with <code className="px-1 py-0.5 rounded bg-surface-hover text-accent font-mono text-[11px]">{"{link}"}</code>
          </p>
        </div>

        {/* Message Variations */}
        <div className="space-y-3">
          <label className="block text-sm font-medium text-foreground">
            Message Variations (A/B testing)
          </label>
          <p className="text-xs text-muted">
            Add alternative message copy to prevent spam detection and vary responses.
          </p>
          {variations.map((v, idx) => (
            <div key={idx} className="flex items-center gap-2 p-3 rounded-xl bg-surface border border-border">
              <span className="text-xs text-zinc-400 font-mono">#{idx + 1}</span>
              <p className="text-sm text-foreground flex-1 truncate">{v}</p>
              <button
                type="button"
                onClick={() => removeVariation(idx)}
                className="text-xs text-zinc-500 hover:text-error"
              >
                Remove
              </button>
            </div>
          ))}
          <div className="flex gap-2">
            <input
              type="text"
              value={newVariation}
              onChange={(e) => setNewVariation(e.target.value)}
              placeholder="Alternative message variation..."
              className="flex-1 px-4 py-2.5 rounded-xl bg-surface border border-border text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
              maxLength={1000}
            />
            <button
              type="button"
              onClick={addVariation}
              className="px-4 py-2.5 rounded-xl bg-surface border border-border hover:bg-surface-hover text-sm font-medium text-white"
            >
              Add Variation
            </button>
          </div>
        </div>

        {/* Public Comment Reply */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            Optional Public Comment Reply
          </label>
          <input
            type="text"
            value={publicReplyMessage}
            onChange={(e) => setPublicReplyMessage(e.target.value)}
            placeholder="Sent you a DM! Check your requests 📥"
            className="w-full px-4 py-3 rounded-xl bg-surface border border-border text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none transition-colors"
            maxLength={500}
          />
        </div>

        {/* Tracked Link */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            Tracked Destination URL
          </label>
          <input
            type="url"
            value={trackedDestinationUrl}
            onChange={(e) => setTrackedDestinationUrl(e.target.value)}
            placeholder="https://yourlink.com/offer"
            className="w-full px-4 py-3 rounded-xl bg-surface border border-border text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none transition-colors"
          />
        </div>

        {/* Match Settings */}
        <div className="glass rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Whole-Word Matching</p>
              <p className="text-xs text-muted">
                Require the keyword to appear as a complete word
              </p>
            </div>
            <input
              type="checkbox"
              checked={wholeWordMatch}
              onChange={(e) => setWholeWordMatch(e.target.checked)}
              className="h-4 w-4 rounded accent-accent"
            />
          </div>

          <div className="flex items-center justify-between pt-3 border-t border-border">
            <div>
              <p className="text-sm font-medium text-foreground">Active Immediately</p>
              <p className="text-xs text-muted">
                Start replying to comments right after launch
              </p>
            </div>
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="h-4 w-4 rounded accent-accent"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-4">
          <button
            type="button"
            onClick={() => router.back()}
            className="px-5 py-2.5 rounded-xl text-sm font-medium text-zinc-400 hover:text-foreground hover:bg-surface transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-6 py-2.5 rounded-xl bg-accent text-accent-foreground text-sm font-semibold hover:bg-accent/90 disabled:opacity-50 transition-all shadow-lg shadow-accent/20"
          >
            {saving ? "Launching..." : "Launch Campaign"}
          </button>
        </div>
      </form>
    </div>
  );
}
