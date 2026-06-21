import { useEffect, useId, useState } from "react";
import { apiFetch } from "../../api";
import { Button, LoadingState, Toggle } from "../../components";
import { useToast } from "../../components/Toast";
import { AlertTriangle, RotateCcw, Server, ShieldAlert } from "lucide-react";

/* ── API response shapes ── */
interface ServerConfig {
  readonly webHost: string;
  readonly webPort: number;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly browserEnabled: boolean;
}

interface SandboxConfig {
  readonly toolsSandbox: "off" | "best-effort" | "required";
  readonly devToolsAllowNetwork: boolean;
  readonly allowUnsandboxedDevTools: boolean;
}

const LOG_LEVELS: readonly ServerConfig["logLevel"][] = [
  "debug",
  "info",
  "warn",
  "error",
];

const SANDBOX_MODES: readonly SandboxConfig["toolsSandbox"][] = [
  "off",
  "best-effort",
  "required",
];

/* ── Restart notice ── */
function RestartNotice() {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-warning">
      <RotateCcw className="w-3 h-3" />
      Takes effect after restart
    </span>
  );
}

/* ── Labelled row wrapper ── */
function FieldRow({
  label,
  description,
  control,
  danger,
}: {
  readonly label: string;
  readonly description: string;
  readonly control: React.ReactNode;
  readonly danger?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          {danger && (
            <ShieldAlert className="w-3.5 h-3.5 text-danger shrink-0" />
          )}
          <span
            className={`text-xs font-medium ${danger ? "text-danger" : "text-foreground"}`}
          >
            {label}
          </span>
        </div>
        <div className="text-xs text-muted mt-0.5">{description}</div>
        <div className="mt-1">
          <RestartNotice />
        </div>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

/* ── Text input control ── */
function TextControl({
  value,
  onChange,
  placeholder,
}: {
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly placeholder?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-44 bg-bg-2 border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:border-accent"
    />
  );
}

/* ── Number input control ── */
function NumberControl({
  value,
  min,
  max,
  onChange,
}: {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(e) => {
        const n = Number.parseInt(e.target.value, 10);
        if (!Number.isNaN(n)) onChange(n);
      }}
      className="w-24 bg-bg-2 border border-border rounded-md px-2 py-1 text-xs text-foreground text-right focus:outline-none focus:border-accent"
    />
  );
}

/* ── Enum select control ── */
function SelectControl<T extends string>({
  value,
  options,
  onChange,
}: {
  readonly value: T;
  readonly options: readonly T[];
  readonly onChange: (v: T) => void;
}) {
  const id = useId();
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="w-36 bg-bg-2 border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:border-accent"
    >
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {opt}
        </option>
      ))}
    </select>
  );
}

/* ── Server section ── */
function ServerSection({
  config,
  onSaved,
}: {
  readonly config: ServerConfig;
  readonly onSaved: (next: ServerConfig) => void;
}) {
  const { success, error: toastError } = useToast();
  const [draft, setDraft] = useState<ServerConfig>(config);
  const [saving, setSaving] = useState(false);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(config);

  function update<K extends keyof ServerConfig>(key: K, value: ServerConfig[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      await apiFetch("/api/config/runtime/server", {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      onSaved(draft);
      success("Server config saved. Restart to apply.");
    } catch {
      toastError("Failed to save server config.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-bg-1 border border-border rounded-xl p-5">
      <div className="flex items-center gap-3.5 mb-4">
        <div className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center bg-accent-subtle text-accent">
          <Server className="w-[18px] h-[18px]" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-strong m-0">Server</h3>
          <p className="text-xs text-muted m-0">
            Web host/port, log level, and global browser tooling.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <FieldRow
          label="Web host"
          description="Bind address for the dashboard/API server."
          control={
            <TextControl
              value={draft.webHost}
              onChange={(v) => update("webHost", v)}
              placeholder="127.0.0.1"
            />
          }
        />
        <FieldRow
          label="Web port"
          description="TCP port the server listens on."
          control={
            <NumberControl
              value={draft.webPort}
              min={1}
              max={65535}
              onChange={(v) => update("webPort", v)}
            />
          }
        />
        <FieldRow
          label="Log level"
          description="Minimum severity emitted by structured logging."
          control={
            <SelectControl
              value={draft.logLevel}
              options={LOG_LEVELS}
              onChange={(v) => update("logLevel", v)}
            />
          }
        />
        <FieldRow
          label="Browser tooling enabled"
          description="Global toggle for browser-backed agent tools."
          control={
            <Toggle
              checked={draft.browserEnabled}
              onChange={(v) => update("browserEnabled", v)}
            />
          }
        />
      </div>

      {isDirty && (
        <div className="flex justify-end gap-2 pt-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDraft(config)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={saving}
            loading={saving}
          >
            Save
          </Button>
        </div>
      )}
    </div>
  );
}

/* ── Sandbox section ── */
function SandboxSection({
  config,
  onSaved,
}: {
  readonly config: SandboxConfig;
  readonly onSaved: (next: SandboxConfig) => void;
}) {
  const { success, error: toastError } = useToast();
  const [draft, setDraft] = useState<SandboxConfig>(config);
  const [saving, setSaving] = useState(false);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(config);

  function update<K extends keyof SandboxConfig>(
    key: K,
    value: SandboxConfig[K],
  ) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      await apiFetch("/api/config/runtime/sandbox", {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      onSaved(draft);
      success("Sandbox config saved. Restart to apply.");
    } catch {
      toastError("Failed to save sandbox config.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-bg-1 border border-border rounded-xl p-5">
      <div className="flex items-center gap-3.5 mb-4">
        <div className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center bg-danger-subtle text-danger">
          <ShieldAlert className="w-[18px] h-[18px]" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-strong m-0">Tool sandbox</h3>
          <p className="text-xs text-muted m-0">
            OS-level isolation for agent shell/dev-tool execution.
          </p>
        </div>
      </div>

      <div className="rounded-lg bg-danger-subtle border border-danger p-3 mb-4 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
        <p className="text-xs text-danger m-0 leading-relaxed">
          The two flags marked below loosen the sandbox boundary that contains
          attacker-controllable, workspace-authored code. Only enable them on
          trusted hosts.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <FieldRow
          label="Sandbox mode"
          description="off = never wrap, best-effort = wrap when available, required = fail closed."
          control={
            <SelectControl
              value={draft.toolsSandbox}
              options={SANDBOX_MODES}
              onChange={(v) => update("toolsSandbox", v)}
            />
          }
        />
        <FieldRow
          danger
          label="Allow dev-tool network (dangerous)"
          description="Lets run_tests/validate_code reach the network — enables remote fetch-then-exec."
          control={
            <Toggle
              checked={draft.devToolsAllowNetwork}
              onChange={(v) => update("devToolsAllowNetwork", v)}
            />
          }
        />
        <FieldRow
          danger
          label="Allow unsandboxed dev tools (dangerous)"
          description="Runs dev tools even when the OS sandbox is not active — executes workspace code on the host."
          control={
            <Toggle
              checked={draft.allowUnsandboxedDevTools}
              onChange={(v) => update("allowUnsandboxedDevTools", v)}
            />
          }
        />
      </div>

      {isDirty && (
        <div className="flex justify-end gap-2 pt-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDraft(config)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={saving}
            loading={saving}
          >
            Save
          </Button>
        </div>
      )}
    </div>
  );
}

/* ── Main ── */
export default function RuntimeSettings() {
  const { error: toastError } = useToast();
  const [server, setServer] = useState<ServerConfig | null>(null);
  const [sandbox, setSandbox] = useState<SandboxConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [serverRes, sandboxRes] = await Promise.all([
          apiFetch<{ data: ServerConfig }>("/api/config/runtime/server"),
          apiFetch<{ data: SandboxConfig }>("/api/config/runtime/sandbox"),
        ]);
        if (cancelled) return;
        setServer(serverRes.data);
        setSandbox(sandboxRes.data);
      } catch {
        if (!cancelled) toastError("Failed to load runtime settings.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <LoadingState message="Loading runtime settings..." />;
  if (!server || !sandbox) return null;

  return (
    <div className="flex flex-col gap-3">
      <ServerSection config={server} onSaved={setServer} />
      <SandboxSection config={sandbox} onSaved={setSandbox} />
    </div>
  );
}
