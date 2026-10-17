"use client";

import { useEffect, useState } from "react";
import AccountSelect, { type AccountOption } from "@/components/account-select";

interface ContactItem {
  id: string;
  instagramUserId: string;
  username: string | null;
  displayName: string | null;
  instagramAccount?: {
    username: string;
  };
  firstSeenAt: string;
  lastInteractionAt: string;
  _count: {
    events: number;
    deliveryJobs: number;
    linkClicks: number;
  };
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<ContactItem[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  useEffect(() => {
    fetch("/api/dashboard/stats")
      .then((res) => res.json())
      .then((payload) => {
        if (payload.success) {
          setAccounts(payload.data.instagramAccounts ?? []);
        }
      })
      .catch(() => setAccounts([]));
  }, []);
  const [totalCount, setTotalCount] = useState(0);

  useEffect(() => {
    let ignore = false;
    const params = new URLSearchParams();
    if (selectedAccountId !== "all") {
      params.set("instagramAccountId", selectedAccountId);
    }
    if (searchQuery.trim()) {
      params.set("q", searchQuery.trim());
    }
    params.set("page", page.toString());
    params.set("limit", "25");

    fetch(`/api/contacts?${params.toString()}`)
      .then((res) => res.json())
      .then((data) => {
        if (!ignore && data.success) {
          setContacts(data.data);
          setTotalPages(data.pagination.totalPages || 1);
          setTotalCount(data.pagination.total || 0);
          setLoading(false);
        }
      })
      .catch((err) => {
        console.error("Failed to load contacts:", err);
        if (!ignore) setLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [selectedAccountId, searchQuery, page]);

  const exportUrl = `/api/export/contacts${
    selectedAccountId !== "all" ? `?instagramAccountId=${selectedAccountId}` : ""
  }`;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Instagram CRM Contacts</h1>
          <p className="text-sm text-muted mt-1">
            Track user interactions, automated replies, and link clicks across campaigns.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href={exportUrl}
            download
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-surface border border-border text-xs font-semibold text-foreground hover:bg-surface-hover hover:border-zinc-500 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            Export Contacts CSV
          </a>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-center gap-4">
        <div className="flex-1 w-full relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Search by username, display name, or Instagram ID..."
            className="w-full px-4 py-2.5 rounded-xl bg-surface border border-border text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
          />
        </div>
        {accounts.length > 0 && (
          <div className="w-full sm:w-64">
            <AccountSelect
              accounts={accounts}
              value={selectedAccountId}
              onChange={(val) => {
                setSelectedAccountId(val);
                setPage(1);
              }}
              includeAll
            />
          </div>
        )}
      </div>

      {/* Stats summary */}
      <div className="text-xs text-muted">
        Showing {contacts.length} of {totalCount} contacts
      </div>

      {/* Contacts Table */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-muted">Loading contacts...</div>
        ) : contacts.length === 0 ? (
          <div className="p-12 text-center text-sm text-muted">
            No contacts found yet. Contacts are automatically captured when users comment on your posts.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-zinc-300">
              <thead className="border-b border-border bg-white/[0.02] text-xs uppercase font-semibold text-zinc-400">
                <tr>
                  <th className="px-5 py-3.5">User</th>
                  <th className="px-5 py-3.5">Account</th>
                  <th className="px-5 py-3.5 text-center">DMs Sent</th>
                  <th className="px-5 py-3.5 text-center">Clicks</th>
                  <th className="px-5 py-3.5">First Seen</th>
                  <th className="px-5 py-3.5">Last Interaction</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {contacts.map((contact) => (
                  <tr key={contact.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="px-5 py-4">
                      <div className="font-semibold text-white">
                        {contact.username ? `@${contact.username}` : "Anonymous"}
                      </div>
                      {contact.displayName && (
                        <div className="text-xs text-zinc-400 mt-0.5">{contact.displayName}</div>
                      )}
                    </td>
                    <td className="px-5 py-4 text-xs text-zinc-400">
                      @{contact.instagramAccount?.username || "unknown"}
                    </td>
                    <td className="px-5 py-4 text-center font-mono text-xs text-cyan-300">
                      {contact._count.deliveryJobs}
                    </td>
                    <td className="px-5 py-4 text-center font-mono text-xs text-emerald-300">
                      {contact._count.linkClicks}
                    </td>
                    <td className="px-5 py-4 text-xs text-zinc-500">
                      {new Date(contact.firstSeenAt).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-4 text-xs text-zinc-400">
                      {new Date(contact.lastInteractionAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="px-4 py-2 rounded-lg bg-surface border border-border text-xs text-zinc-300 hover:bg-surface-hover disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-xs text-muted">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="px-4 py-2 rounded-lg bg-surface border border-border text-xs text-zinc-300 hover:bg-surface-hover disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
