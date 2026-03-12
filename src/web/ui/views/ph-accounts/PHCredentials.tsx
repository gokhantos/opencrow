import React, { useState, useEffect, useCallback } from "react";
import { ChevronDown, ChevronRight, CheckCircle, Circle } from "lucide-react";
import { apiFetch } from "../../api";
import { Button, Input } from "../../components";

interface SecretEntry {
  readonly key: string;
  readonly set: boolean;
  readonly source: "db" | "env" | null;
  readonly masked: string | null;
}

interface CredentialField {
  readonly key: "PH_API_TOKEN" | "PH_API_SECRET";
  readonly label: string;
  readonly description: string;
}

const CREDENTIAL_FIELDS: readonly CredentialField[] = [
  {
    key: "PH_API_TOKEN",
    label: "API Token",
    description: "Your ProductHunt OAuth application token",
  },
  {
    key: "PH_API_SECRET",
    label: "API Secret",
    description: "Your ProductHunt OAuth application secret",
  },
];

function StatusIndicator({ set }: { readonly set: boolean }) {
  if (set) {
    return <CheckCircle className="w-4 h-4 text-success shrink-0" />;
  }
  return <Circle className="w-4 h-4 text-faint shrink-0" />;
}

function CredentialRow({
  field,
  entry,
  onSaved,
}: {
  readonly field: CredentialField;
  readonly entry: SecretEntry | undefined;
  readonly onSaved: (key: string) => void;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSet = entry?.set ?? false;
  const isEnvSource = entry?.source === "env";

  async function handleSave() {
    if (!value.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/secrets/${field.key}`, {
        method: "PUT",
        body: JSON.stringify({ value: value.trim() }),
      });
      setValue("");
      onSaved(field.key);
    } catch {
      setError("Failed to save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    setError(null);
    try {
      await apiFetch(`/api/secrets/${field.key}`, { method: "DELETE" });
      onSaved(field.key);
    } catch {
      setError("Failed to remove. Please try again.");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 py-3 border-b border-border-2 last:border-0">
      <div className="flex items-center gap-2">
        <StatusIndicator set={isSet} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-strong font-mono">
              {field.key}
            </span>
            {isSet && entry?.masked && (
              <span className="text-xs text-faint font-mono">
                {entry.masked}
              </span>
            )}
            {isEnvSource && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-bg-2 text-muted font-mono">
                env
              </span>
            )}
          </div>
          <p className="text-xs text-muted mt-0.5">{field.description}</p>
        </div>
      </div>

      {!isEnvSource && (
        <div className="flex gap-2 items-center pl-6">
          <Input
            type="password"
            placeholder={isSet ? "Enter new value to update" : "Paste value here"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
            }}
            className="flex-1 text-sm font-mono"
          />
          <Button
            size="sm"
            variant="primary"
            onClick={handleSave}
            loading={saving}
            disabled={!value.trim()}
          >
            {isSet ? "Update" : "Save"}
          </Button>
          {isSet && (
            <Button
              size="sm"
              variant="danger"
              onClick={handleRemove}
              loading={removing}
            >
              Remove
            </Button>
          )}
        </div>
      )}

      {isEnvSource && (
        <p className="pl-6 text-xs text-muted">
          Set via environment variable. To override, remove the env var and set
          here.
        </p>
      )}

      {error && (
        <p className="pl-6 text-xs text-danger">{error}</p>
      )}
    </div>
  );
}

export function PHCredentials() {
  const [expanded, setExpanded] = useState(false);
  const [secrets, setSecrets] = useState<readonly SecretEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchSecrets = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{
        success: boolean;
        data: readonly SecretEntry[];
      }>("/api/secrets");
      if (res.success) {
        setSecrets(
          res.data.filter(
            (s) => s.key === "PH_API_TOKEN" || s.key === "PH_API_SECRET",
          ),
        );
      }
    } catch {
      // silently ignore — credentials section is non-critical
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSecrets();
  }, [fetchSecrets]);

  useEffect(() => {
    if (expanded) {
      fetchSecrets();
    }
  }, [expanded, fetchSecrets]);

  function handleSaved(_key: string) {
    fetchSecrets();
  }

  const tokenEntry = secrets.find((s) => s.key === "PH_API_TOKEN");
  const secretEntry = secrets.find((s) => s.key === "PH_API_SECRET");
  const allSet = (tokenEntry?.set ?? false) && (secretEntry?.set ?? false);
  const noneSet = !(tokenEntry?.set ?? false) && !(secretEntry?.set ?? false);

  return (
    <div className="mb-4 rounded-lg border border-border-2 bg-bg-1 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-bg-2 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-muted shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted shrink-0" />
        )}
        <span className="text-sm font-medium text-strong flex-1">
          API Credentials
        </span>
        {!expanded && (
          <span
            className={`text-xs px-2 py-0.5 rounded-full font-medium ${
              allSet
                ? "bg-success-subtle text-success"
                : noneSet
                  ? "bg-danger-subtle text-danger"
                  : "bg-warning-subtle text-warning"
            }`}
          >
            {allSet ? "Configured" : noneSet ? "Not set" : "Partial"}
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-3 border-t border-border-2">
          <p className="text-xs text-muted mt-3 mb-3">
            To use the ProductHunt scraper, you need an OAuth application from
            the{" "}
            <a
              href="https://www.producthunt.com/v2/oauth/applications"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              ProductHunt developer dashboard
            </a>
            . Set your API token and secret below.
          </p>

          {loading ? (
            <p className="text-xs text-muted py-2">Loading...</p>
          ) : (
            <div>
              {CREDENTIAL_FIELDS.map((field) => (
                <CredentialRow
                  key={field.key}
                  field={field}
                  entry={secrets.find((s) => s.key === field.key)}
                  onSaved={handleSaved}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
