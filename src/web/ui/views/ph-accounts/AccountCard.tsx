import React, { useState } from "react";
import { cn } from "../../lib/cn";
import { apiFetch } from "../../api";
import { Button, Input, StatusBadge, ConfirmDelete } from "../../components";
import type { PHAccount, AccountResponse } from "./types";

const statusColorMap: Record<string, string> = {
  active: "green",
  unverified: "yellow",
  expired: "red",
  error: "red",
};

const statusBarColors: Record<string, string> = {
  active: "bg-success",
  unverified: "bg-warning",
  expired: "bg-danger",
  error: "bg-danger",
};

export function AccountCreateForm({
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
      await apiFetch<AccountResponse>("/api/ph/accounts", {
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
    <div className="bg-bg-1 border border-border rounded-lg p-6 mb-6">
      <form onSubmit={handleCreate}>
        <div className="font-heading text-sm font-semibold uppercase tracking-widest text-accent mb-5 pb-2 border-b border-border">
          Add ProductHunt Account
        </div>
        {error && <p className="text-danger text-sm">{error}</p>}

        <div className="grid grid-cols-1 gap-4">
          <Input
            label="Label"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Main PH Account..."
            required
            maxLength={100}
          />
          <div>
            <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-2">
              Cookies JSON
            </label>
            <textarea
              className="w-full px-4 py-2.5 bg-bg border border-border rounded-lg text-foreground font-mono text-sm outline-none transition-colors duration-150 focus:border-accent placeholder:text-faint"
              value={cookiesJson}
              onChange={(e) => setCookiesJson(e.target.value)}
              placeholder="Paste full cookie export JSON array from browser extension (e.g. Cookie Quick Manager)..."
              required
              rows={6}
            />
            <p className="text-faint text-xs mt-1">
              Export all cookies from producthunt.com using a browser extension
              and paste the JSON array here
            </p>
          </div>
        </div>

        <div className="flex gap-2 mt-6">
          <Button type="submit" size="sm" loading={saving}>
            {saving ? "Adding..." : "Add Account"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

export function AccountEditForm({
  account,
  onSaved,
  onCancel,
}: {
  account: PHAccount;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(account.label);
  const [cookiesJson, setCookiesJson] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");

    const updates: Record<string, string> = {};
    if (label.trim() && label.trim() !== account.label) {
      updates.label = label.trim();
    }
    if (cookiesJson.trim()) {
      try {
        JSON.parse(cookiesJson.trim());
      } catch {
        setError("Invalid JSON - paste the full cookie export array");
        setSaving(false);
        return;
      }
      updates.cookies_json = cookiesJson.trim();
    }

    if (Object.keys(updates).length === 0) {
      setError("No changes to save");
      setSaving(false);
      return;
    }

    try {
      await apiFetch<AccountResponse>(`/api/ph/accounts/${account.id}`, {
        method: "PUT",
        body: JSON.stringify(updates),
      });
      onSaved();
    } catch (err: unknown) {
      const apiErr = err as { message?: string };
      setError(apiErr.message ?? "Failed to update account");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-bg-1 border border-border rounded-lg p-6 mb-6">
      <form onSubmit={handleSave}>
        <div className="font-heading text-sm font-semibold uppercase tracking-widest text-accent mb-5 pb-2 border-b border-border">
          Edit: {account.label}
        </div>
        {error && <p className="text-danger text-sm">{error}</p>}

        <div className="grid grid-cols-1 gap-4">
          <Input
            label="Label"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={100}
          />
          <div>
            <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-2">
              Cookies JSON (leave empty to keep current)
            </label>
            <textarea
              className="w-full px-4 py-2.5 bg-bg border border-border rounded-lg text-foreground font-mono text-sm outline-none transition-colors duration-150 focus:border-accent placeholder:text-faint"
              value={cookiesJson}
              onChange={(e) => setCookiesJson(e.target.value)}
              placeholder="Paste new cookie export JSON array to replace existing cookies..."
              rows={6}
            />
            <p className="text-faint text-xs mt-1">
              Current: {account.cookie_count} cookies
              {account.session_preview
                ? ` (session: ${account.session_preview})`
                : ""}
            </p>
          </div>
        </div>

        <div className="flex gap-2 mt-6">
          <Button type="submit" size="sm" loading={saving}>
            {saving ? "Saving..." : "Save Changes"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

export function AccountCard({
  account,
  onVerify,
  onEdit,
  onConfigure,
  onDelete,
  verifying,
}: {
  account: PHAccount;
  onVerify: () => void;
  onEdit: () => void;
  onConfigure: () => void;
  onDelete: () => void;
  verifying: boolean;
}) {

  const displayName = account.display_name || account.label;
  const initials = displayName
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  const barColor = statusBarColors[account.status] ?? "bg-border";

  return (
    <div className="relative bg-bg-1 border border-border rounded-lg overflow-hidden transition-colors hover:border-border-2">
      {/* Status accent bar */}
      <div
        className={cn(
          "absolute top-0 left-0 right-0 h-1 rounded-t-lg z-[1]",
          barColor,
        )}
      />

      <div className="flex items-center justify-between px-6 pt-6 gap-4">
        <div className="flex items-center gap-3.5">
          <div className="w-11 h-11 rounded-lg flex items-center justify-center font-heading font-bold text-base shrink-0 bg-accent-subtle text-accent border border-border overflow-hidden">
            {account.avatar_url ? (
              <img
                src={account.avatar_url}
                alt={displayName}
                className="w-full h-full object-cover rounded-lg"
              />
            ) : (
              initials
            )}
          </div>
          <div>
            <div className="font-heading font-semibold text-lg text-strong tracking-tight mb-0.5">
              {displayName}
            </div>
            <div className="font-mono text-sm text-faint">
              {account.username ? `@${account.username}` : account.label}
            </div>
          </div>
        </div>
        <StatusBadge
          status={account.status}
          colorMap={statusColorMap}
        />
      </div>

      {account.label !== displayName && (
        <div className="text-muted text-sm leading-relaxed px-6 pt-3">
          {account.label}
        </div>
      )}

      {account.error_message && (
        <div className="text-danger text-sm font-mono px-6 pt-2 break-words">
          {account.error_message}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 px-6 pt-5 mt-3 border-t border-border max-md:grid-cols-1">
        <div className="flex flex-col gap-1 p-3 px-4 bg-bg-2 border border-border rounded-md">
          <div className="font-heading text-[0.68rem] font-semibold uppercase tracking-widest text-faint">
            Cookies
          </div>
          <div className="font-mono text-sm font-semibold text-foreground break-all">
            {account.cookie_count}
          </div>
        </div>
        <div className="flex flex-col gap-1 p-3 px-4 bg-bg-2 border border-border rounded-md">
          <div className="font-heading text-[0.68rem] font-semibold uppercase tracking-widest text-faint">
            Session
          </div>
          <div className="font-mono text-sm font-semibold text-foreground break-all">
            {account.session_preview || "N/A"}
          </div>
        </div>
        <div className="flex flex-col gap-1 p-3 px-4 bg-bg-2 border border-border rounded-md">
          <div className="font-heading text-[0.68rem] font-semibold uppercase tracking-widest text-faint">
            Created
          </div>
          <div className="font-mono text-sm font-semibold text-foreground break-all">
            {new Date(account.created_at * 1000).toLocaleDateString()}
          </div>
        </div>
        <div className="flex flex-col gap-1 p-3 px-4 bg-bg-2 border border-border rounded-md">
          <div className="font-heading text-[0.68rem] font-semibold uppercase tracking-widest text-faint">
            Verified
          </div>
          <div className="font-mono text-sm font-semibold text-foreground break-all">
            {account.verified_at
              ? new Date(account.verified_at * 1000).toLocaleDateString()
              : "Never"}
          </div>
        </div>
      </div>

      <div className="flex gap-2.5 items-center px-6 pt-5 pb-6 border-t border-border mt-4 flex-wrap">
        <Button size="sm" onClick={onVerify} loading={verifying}>
          {verifying ? "Verifying..." : "Verify"}
        </Button>
        <Button variant="secondary" size="sm" onClick={onConfigure}>
          Configure
        </Button>
        <Button variant="secondary" size="sm" onClick={onEdit}>
          Edit
        </Button>
        <ConfirmDelete onConfirm={onDelete} confirmLabel="Delete?" />
      </div>
    </div>
  );
}
