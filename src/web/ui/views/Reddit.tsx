import React, { useState, useEffect } from "react";
import { apiFetch } from "../api";
import { formatTime, formatAge } from "../lib/format";
import { cn } from "../lib/cn";
import { PageHeader, LoadingState, EmptyState, Button } from "../components";
import { useToast } from "../components/Toast";
import { Settings2, ChevronDown } from "lucide-react";

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
  const [confirmDelete, setConfirmDelete] = useState(false);

  const statusColors: Record<string, string> = {
    active: "#27ae60",
    unverified: "#f39c12",
    expired: "#e74c3c",
    error: "#e74c3c",
  };

  return (
    <div className="bg-bg-1 border border-border rounded-lg px-5 py-3.5 flex items-center gap-5 text-sm">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-strong">
            {account.username ? `u/${account.username}` : account.label}
          </span>
          <span
            className="text-xs px-2 py-0.5 rounded-full font-semibold text-black"
            style={{
              background: statusColors[account.status] ?? "var(--text-3)",
            }}
          >
            {account.status}
          </span>
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

      <div className="flex gap-2 shrink-0">
        <Button size="sm" onClick={onVerify} loading={verifying}>
          Verify
        </Button>
        {confirmDelete ? (
          <>
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                onDelete();
                setConfirmDelete(false);
              }}
            >
              Confirm
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </Button>
        )}
      </div>
    </div>
  );
}

function IntervalConfigPanel({ scraperId, defaultMinutes }: { readonly scraperId: string; readonly defaultMinutes: number }) {
  const { success, error: toastError } = useToast();
  const [open, setOpen] = useState(false);
  const [interval, setInterval_] = useState(defaultMinutes);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ data: { intervalMinutes: number } }>(
          `/api/features/scraper-config/${scraperId}`,
        );
        if (!cancelled) { setInterval_(res.data.intervalMinutes); setLoaded(true); }
      } catch {
        if (!cancelled) { setLoaded(true); toastError("Failed to load config."); }
      }
    })();
    return () => { cancelled = true; };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    setSaving(true);
    try {
      await apiFetch(`/api/features/scraper-config/${scraperId}`, {
        method: "PUT",
        body: JSON.stringify({ intervalMinutes: interval }),
      });
      success("Config saved.");
    } catch {
      toastError("Failed to save config.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-bg-1 border border-border rounded-lg mb-5">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-transparent border-none cursor-pointer text-left"
      >
        <div className="flex items-center gap-2 text-xs text-muted">
          <Settings2 className="w-3.5 h-3.5" />
          <span className="font-medium">Scraper Config</span>
        </div>
        <ChevronDown className={`w-3.5 h-3.5 text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="border-t border-border px-4 py-3 flex flex-col gap-3">
          {!loaded ? (
            <p className="text-xs text-muted">Loading...</p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-foreground">Scrape interval (min)</div>
                  <div className="text-xs text-muted mt-0.5">How often to scrape</div>
                </div>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={interval}
                  onChange={(e) => { const n = parseInt(e.target.value, 10); if (!isNaN(n)) setInterval_(n); }}
                  className="w-20 shrink-0 bg-bg-2 border border-border rounded-md px-2 py-1 text-xs text-foreground text-right focus:outline-none focus:border-accent"
                />
              </div>
              <div className="flex justify-end">
                <Button variant="primary" size="sm" onClick={handleSave} disabled={saving} loading={saving}>Save</Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function Reddit() {
  const [posts, setPosts] = useState<RedditPost[]>([]);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [accounts, setAccounts] = useState<RedditAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [scraping, setScraping] = useState(false);
  const [filterSub, setFilterSub] = useState<string>("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 30_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    fetchPosts();
  }, [filterSub]);

  async function fetchAll() {
    try {
      const [postsRes, statsRes, acctRes] = await Promise.all([
        apiFetch<{ success: boolean; data: RedditPost[] }>(
          `/api/reddit/posts?limit=100${filterSub ? `&subreddit=${filterSub}` : ""}`,
        ),
        apiFetch<{ success: boolean; data: StatsData }>("/api/reddit/stats"),
        apiFetch<{ success: boolean; data: RedditAccount[] }>(
          "/api/reddit/accounts",
        ),
      ]);
      if (postsRes.success) setPosts(postsRes.data);
      if (statsRes.success) setStats(statsRes.data);
      if (acctRes.success) setAccounts(acctRes.data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  async function fetchPosts() {
    try {
      const res = await apiFetch<{ success: boolean; data: RedditPost[] }>(
        `/api/reddit/posts?limit=100${filterSub ? `&subreddit=${filterSub}` : ""}`,
      );
      if (res.success) setPosts(res.data);
    } catch {
      // ignore
    }
  }

  async function handleScrapeNow() {
    const activeAccount = accounts.find((a) => a.status === "active");
    if (!activeAccount) return;

    setScraping(true);
    try {
      await apiFetch("/api/reddit/scrape-now", {
        method: "POST",
        body: JSON.stringify({ account_id: activeAccount.id }),
      });
      await fetchAll();
    } catch {
      // ignore
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
      await fetchAll();
    } catch {
      await fetchAll();
    } finally {
      setVerifyingId(null);
    }
  }

  async function handleDelete(id: string) {
    try {
      await apiFetch(`/api/reddit/accounts/${id}`, { method: "DELETE" });
      await fetchAll();
    } catch {
      await fetchAll();
    }
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
            fetchAll();
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

      <IntervalConfigPanel scraperId="reddit" defaultMinutes={30} />

      {/* Subreddit filter chips */}
      {subreddits.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-5">
          <button
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
      {posts.length === 0 ? (
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
