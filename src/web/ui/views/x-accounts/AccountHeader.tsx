import { useState, useCallback } from "react";
import { z } from "zod";
import { apiFetch } from "../../api";
import { Button, Input, FormField, StatusBadge } from "../../components";
import { useZodForm } from "../../hooks/useZodForm";
import type { XAccount, AccountResponse } from "./types";

const statusColorMap: Record<string, string> = {
  active: "green",
  unverified: "yellow",
  expired: "red",
  error: "red",
};

const credentialsSchema = z.object({
  authToken: z.string().min(1, "Auth token is required"),
  ct0: z.string().min(1, "CT0 is required"),
});

function CredentialsPanel({
  account,
  onSaved,
}: {
  readonly account: XAccount;
  readonly onSaved: () => void;
}) {
  const [apiError, setApiError] = useState("");
  const [saved, setSaved] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useZodForm(credentialsSchema, {
    defaultValues: { authToken: "", ct0: "" },
  });

  const redact = useCallback((raw: string) => {
    if (raw.length <= 8) return raw;
    return `${raw.slice(0, 8)}...`;
  }, []);

  async function onSubmit(values: z.infer<typeof credentialsSchema>) {
    setApiError("");
    setSaved(false);
    try {
      await apiFetch<AccountResponse>(`/api/x/accounts/${account.id}`, {
        method: "PUT",
        body: JSON.stringify({ auth_token: values.authToken.trim(), ct0: values.ct0.trim() }),
      });
      setSaved(true);
      reset();
      onSaved();
    } catch (err: unknown) {
      const apiErr = err as { message?: string };
      setApiError(apiErr.message ?? "Failed to update credentials");
    }
  }

  return (
    <div className="px-6 py-4 bg-bg-2 border-t border-border flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <span className="font-heading text-[0.68rem] font-semibold uppercase tracking-widest text-faint w-24 shrink-0">
            auth_token
          </span>
          <span className="font-mono text-xs text-muted bg-bg-1 px-2 py-1 rounded">
            {redact(account.auth_token)}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-heading text-[0.68rem] font-semibold uppercase tracking-widest text-faint w-24 shrink-0">
            ct0
          </span>
          <span className="font-mono text-xs text-muted bg-bg-1 px-2 py-1 rounded">
            {redact(account.ct0)}
          </span>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="border-t border-border pt-4 flex flex-col gap-3">
        <div className="font-heading text-[0.68rem] font-semibold uppercase tracking-widest text-faint">
          Update Credentials
        </div>

        {apiError && (
          <div className="text-danger text-sm font-mono px-3 py-2 bg-danger-subtle border border-border rounded-md break-words">
            {apiError}
          </div>
        )}
        {saved && (
          <div className="text-success text-sm font-mono px-3 py-2 bg-success-subtle border border-border rounded-md">
            Credentials updated successfully
          </div>
        )}

        <FormField error={errors.authToken}>
          <label className="font-heading text-[0.68rem] font-semibold uppercase tracking-widest text-faint">
            auth_token
          </label>
          <Input
            type="password"
            {...register("authToken")}
            placeholder="New auth_token value"
          />
        </FormField>
        <FormField error={errors.ct0}>
          <label className="font-heading text-[0.68rem] font-semibold uppercase tracking-widest text-faint">
            ct0
          </label>
          <Input
            type="password"
            {...register("ct0")}
            placeholder="New ct0 value"
          />
        </FormField>

        <div className="flex gap-3 pt-1">
          <Button type="submit" size="sm" loading={isSubmitting}>
            {isSubmitting ? "Saving..." : "Update Credentials"}
          </Button>
        </div>
      </form>
    </div>
  );
}

interface AccountHeaderProps {
  readonly account: XAccount;
  readonly onVerify: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly verifying?: boolean;
}

export function AccountHeader({
  account,
  onVerify,
  onEdit,
  onDelete,
  verifying = false,
}: AccountHeaderProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showCredentials, setShowCredentials] = useState(false);

  const displayName = account.display_name ?? account.label;
  const initials = (account.username ?? displayName)
    .replace(/^@/, "")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="border-b border-border bg-bg-1">
      <div className="flex items-center justify-between px-6 py-4 gap-4 flex-wrap">
        {/* Left: avatar + identity */}
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-full flex items-center justify-center font-heading font-bold text-sm shrink-0 bg-accent-subtle text-accent border border-border overflow-hidden">
            {account.profile_image_url ? (
              <img
                src={account.profile_image_url}
                alt={displayName}
                className="w-full h-full object-cover"
              />
            ) : (
              initials
            )}
          </div>
          <div>
            <div className="font-heading font-semibold text-base text-strong tracking-tight">
              {displayName}
            </div>
            <div className="font-mono text-sm text-muted">
              {account.username ? `@${account.username}` : account.label}
            </div>
          </div>
          <StatusBadge status={account.status} colorMap={statusColorMap} />
        </div>

        {/* Right: actions */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="primary" size="sm" onClick={onVerify} loading={verifying}>
            {verifying ? "Verifying..." : "Verify"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowCredentials((v) => !v)}
          >
            {showCredentials ? "Hide Keys" : "Keys"}
          </Button>
          <Button variant="secondary" size="sm" onClick={onEdit}>
            Edit
          </Button>
          {confirmDelete ? (
            <>
              <span className="text-sm text-danger self-center">Delete?</span>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  setConfirmDelete(false);
                  onDelete();
                }}
              >
                Confirm
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              variant="danger"
              size="sm"
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          )}
        </div>
      </div>

      {account.error_message && (
        <div className="px-6 py-2 bg-danger-subtle border-t border-border text-danger text-sm font-mono break-words">
          {account.error_message}
        </div>
      )}

      {showCredentials && (
        <CredentialsPanel account={account} onSaved={onEdit} />
      )}
    </div>
  );
}
