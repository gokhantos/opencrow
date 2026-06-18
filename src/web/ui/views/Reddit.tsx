import React, { useState, useCallback } from "react";
import { apiFetch } from "../api";
import { formatTime, formatAge } from "../lib/format";
import { cn } from "../lib/cn";
import {
  PageHeader,
  LoadingState,
  EmptyState,
  Button,
  ConfirmDelete,
  StatusBadge,
  IntervalConfigPanel,
} from "../components";
import type { IntervalConfigField } from "../components";
import { usePolledFetch } from "../hooks/usePolledFetch";

interface RedditPost {
  id: string;
  subreddit: string;
  title: string;
  url: string;
  selftext: string;
  author: string;
  score: number;
  num_comments: number;
  permalink: string;
  post_type: string;
  feed_source: string;
  domain: string;
  upvote_ratio: number;
  created_utc: number;
  first_seen_at: number;
  updated_at: number;
  top_comments_json: string | null;
  flair: string | null;
  thumbnail_url: string | null;
}

interface RedditAccount {
  id: string;
  label: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  cookie_count: number;
  status: string;
  verified_at: number | null;
  error_message: string | null;
  last_scraped_at: number | null;
  last_scrape_count: number | null;
  created_at: number;
  updated_at: number;
}

interface StatsData {
  total_posts: number;
  last_updated_at: number | null;
  subreddit_count: number;
}

interface PostsResponse {
  success: boolean;
  data: RedditPost[];
}

interface StatsResponse {
  success: boolean;
  data: StatsData;
}

interface AccountsResponse {
  success: boolean;
  data: RedditAccount[];
}

const ACCOUNT_STATUS_COLORS: Readonly<Record<string, string>> = {
  active: "green",
  unverified: "yellow",
  expired: "red",
  error: "red",
};

const REDDIT_INTERVAL_FIELDS: readonly IntervalConfigField[] = [
  {
    key: "intervalMinutes",
    label: "Scrape interval (min)",
    desc: "How often to scrape",
    min: 1,
    max: 1440,
    defaultValue: 30,
  },
];

function AccountCreateForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState("");
  const [cookiesJson, setCookiesJson] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim() || !cookiesJson.trim()) {
      setError("Label and cookies JSON are required");
      return;
    }

    try {
      JSON.parse(cookiesJson.trim());
    } catch {
      setError("Invalid JSON - paste the full cookie export array");
      return;
    }

    setSaving(true);
    setError("");

    try {
      await apiFetch<{ success: boolean }>("/api/reddit/accounts", {
        method: "POST",
        body: JSON.stringify({
          label: label.trim(),
          cookies_json: cookiesJson.trim(),
        }),
      });
      onCreated();
    } catch (err: unknown) {
      const apiErr = err as { message?: string };
      setError(apiErr.message ?? "Failed to create account");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-bg-1 border border-border rounded-lg p-5 mb-5">
      <form onSubmit={handleCreate}>
        <div className="font-semibold mb-4 text-strong">Add Reddit Account</div>
        {error && <p className="text-danger text-sm mb-2">{error}</p>}

        <div className="flex flex-col gap-3">
          <div className="mb-5">
            <label className="block text-sm font-medium text-muted mb-1.5 tracking-wide">
              Label
            </label>
            <input
              className="w-full px-4 py-2.5 bg-bg border border-border rounded-md text-foreground font-sans text-sm outline-none transition-colors focus:border-strong"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Main Reddit Account..."
              required
              maxLength={100}
            />
          </div>
          <div className="mb-5">
            <label className="block text-sm font-medium text-muted mb-1.5 tracking-wide">
              Cookies JSON
            </label>
            <textarea
              className="w-full px-4 py-2.5 bg-bg border border-border rounded-md text-foreground font-mono text-sm outline-none transition-colors focus:border-strong"
              value={cookiesJson}
              onChange={(e) => setCookiesJson(e.target.value)}
              placeholder="Paste full cookie export JSON array from browser extension (e.g. Cookie Quick Manager)..."
              required
              rows={6}
            />
            <p className="text-xs text-faint mt-1">
              Export all cookies from reddit.com using a browser extension and
              paste the JSON array here. Must include the reddit_session cookie.
            </p>
          </div>
        </div>

        <div className="flex gap-3 mt-3">
          <Button size="sm" type="submit" loading={saving}>
            Add Account
          </Button>
          <Button
            size="sm"
            variant="secondary"
            type="button"
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

function AccountCard({
  account,
  onVerify,
  onDelete,
  verifying,
}: {
  account: RedditAccount;
  onVerify: () => void;
  onDelete: () => void;
  verifying: boolean;
}) {
  return (
    <div className="bg-bg-1 border border-border rounded-lg px-5 py-3.5 flex items-center gap-5 text-sm">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-strong">
            {account.username ? `u/${account.username}` : account.label}
          </span>
          <StatusBadge
            status={account.status}
            colorMap={ACCOUNT_STATUS_COLORS}
          />
        </div>
        <div className="text-sm text-faint mt-0.5">
          {account.cookie_count} cookies
          {account.last_scraped_at && (
            <span>
              {" | "}Last scraped:{" "}
              {new Date(account.last_scraped_at * 1000).toLocaleString()}
              {account.last_scrape_count != null &&
                ` (${account.last_scrape_count} posts)`}
            </span>
          )}
          {account.error_message && (
            <span className="text-danger"> | {account.error_message}</span>
          )}
        </div>
      </div>

      <div className="flex gap-2 shrink-0 items-center">
        <Button size="sm" onClick={onVerify} loading={verifying}>
          Verify
        </Button>
        <ConfirmDelete onConfirm={onDelete} />
      </div>
    </div>
  );
}

export default function Reddit() {
  const [filterSub, setFilterSub] = useState<string>("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [scraping, setScraping] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);

  // Derive the posts URL from filterSub — usePolledFetch restarts the poll
  // whenever the path changes, so the stale-closure bug is structurally impossible.
  const postsPath = `/api/reddit/posts?limit=100${filterSub ? `&subreddit=${encodeURIComponent(filterSub)}` : ""}`;

  const postsResult = usePolledFetch<PostsResponse>(postsPath, { intervalMs: 30_000 });
  const statsResult = usePolledFetch<StatsResponse>("/api/reddit/stats", { intervalMs: 30_000 });
  const accountsResult = usePolledFetch<AccountsResponse>("/api/reddit/accounts", { intervalMs: 30_000 });

  const posts = postsResult.data?.success ? postsResult.data.data : [];
  const stats = statsResult.data?.success ? statsResult.data.data : null;
  const accounts = accountsResult.data?.success ? accountsResult.data.data : [];

  const loading = postsResult.loading || statsResult.loading || accountsResult.loading;
  const fetchError = postsResult.error ?? statsResult.error ?? accountsResult.error ?? null;

  const refetchAll = useCallback(() => {
    postsResult.refetch();
    statsResult.refetch();
    accountsResult.refetch();
  }, [postsResult, statsResult, accountsResult]);

  async function handleScrapeNow() {
    const activeAccount = accounts.find((a) => a.status === "active");
    if (!activeAccount) return;

    setScraping(true);
    try {
      await apiFetch("/api/reddit/scrape-now", {
        method: "POST",
        body: JSON.stringify({ account_id: activeAccount.id }),
      });
      refetchAll();
    } catch {
      // ignore — data will poll in
    } finally {
      setScraping(false);
    }
  }

  async function handleBackfillRag() {
    setBackfilling(true);
    setBackfillResult(null);
    try {
      const res = await apiFetch<{ success: boolean; data: { indexed: number } }>(
        "/api/reddit/backfill-rag",
        { method: "POST" },
      );
      if (res.success) {
        setBackfillResult(`Indexed ${res.data.indexed} posts`);
      }
    } catch (err) {
      let message = "Unknown error";
      if (err && typeof err === "object" && "message" in err) {
        const raw = String((err as { message: string }).message);
        try {
          const parsed = JSON.parse(raw) as { error?: string };
          message = parsed.error ?? raw;
        } catch {
          message = raw;
        }
      }
      setBackfillResult(`Backfill failed: ${message}`);
    } finally {
      setBackfilling(false);
    }
  }

  async function handleVerify(id: string) {
    setVerifyingId(id);
    try {
      await apiFetch(`/api/reddit/accounts/${id}/verify`, { method: "POST" });
    } catch {
      // Refresh regardless — verification may have partially succeeded
    } finally {
      setVerifyingId(null);
      accountsResult.refetch();
    }
  }

  async function handleDelete(id: string) {
    await apiFetch(`/api/reddit/accounts/${id}`, { method: "DELETE" });
    accountsResult.refetch();
  }

  const subreddits = Array.from(new Set(posts.map((p) => p.subreddit))).sort();

  if (loading) {
    return <LoadingState message="Loading..." />;
  }

  return (
    <div>
      <PageHeader
        title="Reddit"
        subtitle={
          stats &&
          `${stats.total_posts} posts | ${stats.subreddit_count} subreddits | Last updated: ${formatTime(stats.last_updated_at)}`
        }
        actions={
          <div className="flex items-center gap-2">
            {backfillResult && (
              <span className="text-xs text-muted">{backfillResult}</span>
            )}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setShowCreateForm((v) => !v)}
            >
              {showCreateForm ? "Cancel" : "Add Account"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={handleBackfillRag}
              loading={backfilling}
            >
              Backfill RAG
            </Button>
            <Button
              size="sm"
              onClick={handleScrapeNow}
              loading={scraping}
              disabled={!accounts.some((a) => a.status === "active")}
            >
              Scrape Now
            </Button>
          </div>
        }
      />

      {/* Account create form */}
      {showCreateForm && (
        <AccountCreateForm
          onCreated={() => {
            setShowCreateForm(false);
            refetchAll();
          }}
          onCancel={() => setShowCreateForm(false)}
        />
      )}

      {/* Account cards */}
      {accounts.length > 0 && (
        <div className="flex flex-col gap-1.5 mb-5">
          {accounts.map((acct) => (
            <AccountCard
              key={acct.id}
              account={acct}
              verifying={verifyingId === acct.id}
              onVerify={() => handleVerify(acct.id)}
              onDelete={() => handleDelete(acct.id)}
            />
          ))}
        </div>
      )}

      <IntervalConfigPanel scraperId="reddit" fields={REDDIT_INTERVAL_FIELDS} />

      {/* Subreddit filter chips */}
      {subreddits.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-5">
          <button
            type="button"
            className={cn(
              "inline-flex items-center justify-center px-3 py-1 border rounded-full font-sans text-sm font-medium cursor-pointer transition-colors",
              !filterSub
                ? "bg-accent text-white border-accent"
                : "bg-bg-1 text-muted border-border hover:bg-bg-2 hover:text-foreground",
            )}
            onClick={() => setFilterSub("")}
          >
            All
          </button>
          {subreddits.map((sub) => (
            <button
              key={sub}
              type="button"
              className={cn(
                "inline-flex items-center justify-center px-3 py-1 border rounded-full font-sans text-sm font-medium cursor-pointer transition-colors",
                filterSub === sub
                  ? "bg-accent text-white border-accent"
                  : "bg-bg-1 text-muted border-border hover:bg-bg-2 hover:text-foreground",
              )}
              onClick={() => setFilterSub(sub === filterSub ? "" : sub)}
            >
              r/{sub}
            </button>
          ))}
        </div>
      )}

      {/* Posts list */}
      {fetchError && posts.length === 0 ? (
        <EmptyState
          title="Failed to load posts"
          description="Failed to load data — the API may be unreachable."
        />
      ) : posts.length === 0 ? (
        <EmptyState description='No posts yet. Add a Reddit account, verify it, then click "Scrape Now" to fetch.' />
      ) : (
        <div className="flex flex-col gap-0.5">
          {posts.map((post) => (
            <div
              key={post.id}
              className="grid grid-cols-[3.5rem_1fr_auto] items-center gap-4 px-4 py-3 bg-bg-1 rounded-lg text-sm hover:bg-bg-2 transition-colors"
            >
              <span className="text-center font-semibold text-accent text-base font-mono">
                {post.score}
              </span>

              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {post.thumbnail_url && (
                    <img
                      src={post.thumbnail_url}
                      alt=""
                      className="w-10 h-10 rounded object-cover shrink-0"
                    />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-xs text-accent font-semibold shrink-0">
                        r/{post.subreddit}
                      </span>
                      {post.flair && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-bg-2 text-muted border border-border shrink-0">
                          {post.flair}
                        </span>
                      )}
                      <a
                        href={post.url || post.permalink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-strong no-underline font-medium overflow-hidden text-ellipsis whitespace-nowrap"
                      >
                        {post.title}
                      </a>
                      {post.domain && post.post_type !== "self" && (
                        <span className="text-xs text-faint shrink-0">
                          ({post.domain})
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-faint mt-0.5">
                      <span>u/{post.author}</span>
                      <span> | {formatAge(post.created_utc)}</span>
                      {post.permalink && (
                        <>
                          {" | "}
                          <a
                            href={post.permalink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-faint no-underline hover:underline"
                          >
                            {post.num_comments} comments
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3 text-sm text-muted shrink-0">
                <span className="text-faint font-mono text-sm">
                  {post.num_comments}
                </span>
                <span className="text-faint text-xs">cmt</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
