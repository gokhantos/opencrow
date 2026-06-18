import React, { useState } from "react";
import { cn } from "../../lib/cn";
import { apiFetch } from "../../api";
import { Button, Toggle, Input } from "../../components";
import type { PHAccount, AccountResponse } from "./types";
import { DEFAULT_CAPABILITIES } from "./types";

function CapSection({
  icon,
  label,
  enabled,
  onToggle,
  children,
}: {
  icon: string;
  label: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(enabled);

  return (
    <div
      className={cn(
        "border rounded-lg mb-2.5 overflow-hidden transition-colors last:mb-0",
        enabled ? "border-accent" : "border-border",
      )}
    >
      <div className="flex items-center justify-between bg-bg-2 transition-colors hover:bg-bg-3">
        <button
          type="button"
          aria-expanded={open}
          className="flex items-center gap-2.5 flex-1 px-5 py-3.5 cursor-pointer select-none text-left"
          onClick={() => setOpen((o) => !o)}
        >
          <span
            aria-hidden="true"
            className={cn(
              "text-xs text-faint transition-transform mr-2",
              open && "rotate-90",
            )}
          >
            {"\u25B6"}
          </span>
          <span className="text-base w-6 text-center" aria-hidden="true">{icon}</span>
          <span className="font-heading text-sm font-semibold text-strong tracking-tight">
            {label}
          </span>
        </button>
        <div className="px-5 py-3.5">
          <Toggle checked={enabled} onChange={onToggle} />
        </div>
      </div>
      <div
        className={cn(
          "grid grid-cols-2 gap-4 px-5 pb-5 pt-3.5",
          !open && "hidden",
          !enabled && "opacity-35 pointer-events-none",
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function CapabilitiesPanel({
  account,
  onSaved,
  onCancel,
}: {
  account: PHAccount;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const merged = {
    feed: {
      ...DEFAULT_CAPABILITIES.feed,
      ...account.capabilities.feed,
    },
    upvoting: {
      ...DEFAULT_CAPABILITIES.upvoting,
      ...account.capabilities.upvoting,
    },
    commenting: {
      ...DEFAULT_CAPABILITIES.commenting,
      ...account.capabilities.commenting,
    },
  };

  const [feed, setFeed] = useState(merged.feed);
  const [upvoting, setUpvoting] = useState(merged.upvoting);
  const [commenting, setCommenting] = useState(merged.commenting);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      await apiFetch<AccountResponse>(
        `/api/ph/accounts/${account.id}/capabilities`,
        {
          method: "PUT",
          body: JSON.stringify({ feed, upvoting, commenting }),
        },
      );
      onSaved();
    } catch (err: unknown) {
      const apiErr = err as { message?: string };
      setError(apiErr.message ?? "Failed to save capabilities");
    } finally {
      setSaving(false);
    }
  }

  const accountLabel = account.username
    ? `@${account.username}`
    : account.label;

  return (
    <div className="bg-bg-1 border border-border rounded-lg p-6 mb-6">
      <div className="flex items-center justify-between mb-6 pb-3 border-b border-border">
        <span className="font-heading text-sm font-semibold uppercase tracking-widest text-accent">
          Capabilities
        </span>
        <span className="font-mono text-xs text-faint">
          {accountLabel}
        </span>
      </div>

      {error && <p className="text-danger text-sm">{error}</p>}

      <CapSection
        icon={"\uD83D\uDCCA"}
        label="Feed Scraping"
        enabled={feed.enabled}
        onToggle={(v) => setFeed({ ...feed, enabled: v })}
      >
        <div className="flex flex-col gap-1">
          <span className="font-heading text-xs font-semibold uppercase tracking-wide text-faint">
            Schedule (cron)
          </span>
          <Input
            type="text"
            value={feed.schedule}
            onChange={(e) => setFeed({ ...feed, schedule: e.target.value })}
            placeholder="0 */4 * * *"
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="font-heading text-xs font-semibold uppercase tracking-wide text-faint">
            Max Pages
          </span>
          <Input
            type="number"
            min={1}
            max={10}
            value={feed.max_pages}
            onChange={(e) =>
              setFeed({
                ...feed,
                max_pages: Math.max(1, Math.min(10, Number(e.target.value))),
              })
            }
          />
        </div>
        <div className="flex flex-col gap-1 col-span-full">
          <span className="font-heading text-xs font-semibold uppercase tracking-wide text-faint">
            Target Topics (comma-separated slugs)
          </span>
          <Input
            type="text"
            value={feed.target_topics.join(", ")}
            onChange={(e) =>
              setFeed({
                ...feed,
                target_topics: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            placeholder="artificial-intelligence, developer-tools"
          />
        </div>
        <div className="flex flex-col gap-1 col-span-full">
          <span className="font-heading text-xs font-semibold uppercase tracking-wide text-faint">
            Target Products (comma-separated slugs)
          </span>
          <Input
            type="text"
            value={feed.target_products.join(", ")}
            onChange={(e) =>
              setFeed({
                ...feed,
                target_products: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            placeholder="specific-product-slug"
          />
        </div>
      </CapSection>

      <CapSection
        icon={"\u2B06\uFE0F"}
        label="Upvoting"
        enabled={upvoting.enabled}
        onToggle={(v) => setUpvoting({ ...upvoting, enabled: v })}
      >
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between py-2">
            <span className="text-sm text-muted">Auto Upvote</span>
            <Toggle
              checked={upvoting.auto_upvote}
              onChange={(v) => setUpvoting({ ...upvoting, auto_upvote: v })}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="font-heading text-xs font-semibold uppercase tracking-wide text-faint">
            Daily Upvote Limit
          </span>
          <Input
            type="number"
            min={0}
            max={200}
            value={upvoting.daily_upvote_limit}
            onChange={(e) =>
              setUpvoting({
                ...upvoting,
                daily_upvote_limit: Math.max(
                  0,
                  Math.min(200, Number(e.target.value)),
                ),
              })
            }
          />
        </div>
        <div className="flex flex-col gap-1 col-span-full">
          <span className="font-heading text-xs font-semibold uppercase tracking-wide text-faint">
            Upvote Keywords (comma-separated)
          </span>
          <Input
            type="text"
            value={upvoting.upvote_keywords.join(", ")}
            onChange={(e) =>
              setUpvoting({
                ...upvoting,
                upvote_keywords: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            placeholder="AI, developer tools, SaaS"
          />
        </div>
        <div className="flex flex-col gap-1 col-span-full">
          <span className="font-heading text-xs font-semibold uppercase tracking-wide text-faint">
            Upvote Topics (comma-separated slugs)
          </span>
          <Input
            type="text"
            value={upvoting.upvote_topics.join(", ")}
            onChange={(e) =>
              setUpvoting({
                ...upvoting,
                upvote_topics: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            placeholder="artificial-intelligence, saas"
          />
        </div>
      </CapSection>

      <CapSection
        icon={"\uD83D\uDCAC"}
        label="Commenting"
        enabled={commenting.enabled}
        onToggle={(v) => setCommenting({ ...commenting, enabled: v })}
      >
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between py-2">
            <span className="text-sm text-muted">Auto Comment</span>
            <Toggle
              checked={commenting.auto_comment}
              onChange={(v) =>
                setCommenting({ ...commenting, auto_comment: v })
              }
            />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="font-heading text-xs font-semibold uppercase tracking-wide text-faint">
            Daily Comment Limit
          </span>
          <Input
            type="number"
            min={0}
            max={50}
            value={commenting.daily_comment_limit}
            onChange={(e) =>
              setCommenting({
                ...commenting,
                daily_comment_limit: Math.max(
                  0,
                  Math.min(50, Number(e.target.value)),
                ),
              })
            }
          />
        </div>
        <div className="flex flex-col gap-1 col-span-full">
          <span className="font-heading text-xs font-semibold uppercase tracking-wide text-faint">
            Comment Keywords (comma-separated)
          </span>
          <Input
            type="text"
            value={commenting.comment_keywords.join(", ")}
            onChange={(e) =>
              setCommenting({
                ...commenting,
                comment_keywords: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            placeholder="AI, machine learning"
          />
        </div>
        <div className="flex flex-col gap-1 col-span-full">
          <span className="font-heading text-xs font-semibold uppercase tracking-wide text-faint">
            Comment Template
          </span>
          <textarea
            className="w-full px-4 py-2.5 bg-bg border border-border rounded-lg text-foreground font-mono text-sm outline-none transition-colors duration-150 focus:border-accent placeholder:text-faint min-h-[60px] resize-y"
            value={commenting.comment_template}
            onChange={(e) =>
              setCommenting({
                ...commenting,
                comment_template: e.target.value,
              })
            }
            placeholder="Great launch! I love how {product} solves..."
            maxLength={1000}
          />
        </div>
      </CapSection>

      <div className="flex gap-3 mt-6 pt-4 border-t border-border">
        <Button size="sm" onClick={handleSave} loading={saving}>
          {saving ? "Saving..." : "Save Capabilities"}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
