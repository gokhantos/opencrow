import { useEffect, useId, useState } from "react";
import { apiFetch } from "../../api";
import { Button, LoadingState, Toggle } from "../../components";
import { useToast } from "../../components/Toast";
import { Brain, Network, RefreshCw } from "lucide-react";

/* ── Effective config shape returned by GET /api/config/sige ── */
interface SigeCore {
  readonly enabled: boolean;
  readonly mem0: { readonly baseUrl: string };
  readonly neo4j: {
    readonly enabled: boolean;
    readonly boltUrl: string;
    readonly user: string;
  };
  readonly source: string;
}

interface SigeAuto {
  readonly enabled: boolean;
  readonly cadence: "manual" | "daily";
  readonly maxDeepFrontiers: number;
  readonly broadPoolSize: number;
  readonly maxConcurrent: number;
  readonly memoryWriteback: boolean;
  readonly source: string;
}

interface SigeConfigResponse {
  readonly core: SigeCore;
  readonly auto: SigeAuto;
}

/* ── Small labelled-row primitives (match Settings.tsx UX) ── */
function RowText({
  label,
  description,
  value,
  onChange,
  placeholder,
}: {
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly placeholder?: string;
}) {
  const baseId = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div id={`${baseId}-label`} className="text-xs font-medium text-foreground">
          {label}
        </div>
        <div id={`${baseId}-desc`} className="text-xs text-muted mt-0.5">
          {description}
        </div>
      </div>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        aria-labelledby={`${baseId}-label`}
        aria-describedby={`${baseId}-desc`}
        onChange={(e) => onChange(e.target.value)}
        className="w-56 shrink-0 bg-bg-2 border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:border-accent"
      />
    </div>
  );
}

function RowNumber({
  label,
  description,
  value,
  min,
  max,
  onChange,
}: {
  readonly label: string;
  readonly description: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (v: number) => void;
}) {
  const baseId = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div id={`${baseId}-label`} className="text-xs font-medium text-foreground">
          {label}
        </div>
        <div id={`${baseId}-desc`} className="text-xs text-muted mt-0.5">
          {description}
        </div>
      </div>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        aria-labelledby={`${baseId}-label`}
        aria-describedby={`${baseId}-desc`}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (!Number.isNaN(n)) onChange(n);
        }}
        className="w-20 shrink-0 bg-bg-2 border border-border rounded-md px-2 py-1 text-xs text-foreground text-right focus:outline-none focus:border-accent"
      />
    </div>
  );
}

function RowToggle({
  label,
  description,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">{label}</div>
        <div className="text-xs text-muted mt-0.5">{description}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}

function RowEnum<T extends string>({
  label,
  description,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly description: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (v: T) => void;
}) {
  const baseId = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div id={`${baseId}-label`} className="text-xs font-medium text-foreground">
          {label}
        </div>
        <div id={`${baseId}-desc`} className="text-xs text-muted mt-0.5">
          {description}
        </div>
      </div>
      <select
        value={value}
        aria-labelledby={`${baseId}-label`}
        aria-describedby={`${baseId}-desc`}
        onChange={(e) => onChange(e.target.value as T)}
        className="w-40 shrink-0 bg-bg-2 border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:border-accent"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/* Restart-required notice (these fields are read at process boot). */
function RestartNotice() {
  return (
    <div className="flex items-center gap-1.5 text-xs text-warning bg-warning-subtle rounded-md px-2 py-1">
      <RefreshCw className="w-3 h-3" />
      <span>Takes effect after restart</span>
    </div>
  );
}

/* ── Core SIGE panel ── */
function CorePanel({
  core,
  onSaved,
}: {
  readonly core: SigeCore;
  readonly onSaved: (next: SigeCore) => void;
}) {
  const { success, error: toastError } = useToast();
  const [draft, setDraft] = useState<SigeCore>(core);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(core), [core]);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(core);

  async function handleSave() {
    setSaving(true);
    try {
      // Send the schema-shaped partial verbatim (mem0.baseUrl / neo4j.boltUrl).
      await apiFetch("/api/config/sige/core", {
        method: "PUT",
        body: JSON.stringify({
          enabled: draft.enabled,
          mem0: { baseUrl: draft.mem0.baseUrl },
          neo4j: {
            enabled: draft.neo4j.enabled,
            boltUrl: draft.neo4j.boltUrl,
            user: draft.neo4j.user,
          },
        }),
      });
      onSaved(draft);
      success("SIGE core config saved.");
    } catch {
      toastError("Failed to save SIGE core config.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-bg-1 border border-border rounded-xl p-5">
      <div className="flex items-start gap-3.5 mb-4">
        <div className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center bg-accent-subtle text-accent">
          <Brain className="w-[18px] h-[18px]" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-strong m-0 mb-1">
            SIGE Engine (Core)
          </h3>
          <p className="text-xs text-muted m-0 leading-relaxed">
            The graph-reasoning idea engine: its mem0 sidecar and read-only Neo4j
            graph connection.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <RowToggle
          label="SIGE enabled"
          description="Master switch for the SIGE engine."
          checked={draft.enabled}
          onChange={(v) => setDraft((p) => ({ ...p, enabled: v }))}
        />
        <RowText
          label="mem0 base URL"
          description="Sidecar the SIGE engine reads/writes memories through."
          value={draft.mem0.baseUrl}
          onChange={(v) => setDraft((p) => ({ ...p, mem0: { baseUrl: v } }))}
          placeholder="http://127.0.0.1:8050"
        />

        <div className="border-t border-border pt-3 mt-1 flex items-center gap-2">
          <Network className="w-3.5 h-3.5 text-muted" />
          <span className="text-xs font-medium text-muted uppercase tracking-wide">
            Neo4j graph (read-only)
          </span>
        </div>
        <RowToggle
          label="Neo4j enabled"
          description="Enable the read-only Bolt connection for opportunity-path reasoning."
          checked={draft.neo4j.enabled}
          onChange={(v) =>
            setDraft((p) => ({ ...p, neo4j: { ...p.neo4j, enabled: v } }))
          }
        />
        <RowText
          label="Bolt URL"
          description="Read-only Bolt URL of the Neo4j instance mem0 writes its graph to."
          value={draft.neo4j.boltUrl}
          onChange={(v) =>
            setDraft((p) => ({ ...p, neo4j: { ...p.neo4j, boltUrl: v } }))
          }
          placeholder="bolt://127.0.0.1:7687"
        />
        <RowText
          label="Neo4j user"
          description="Bolt username (password is a managed secret, not set here)."
          value={draft.neo4j.user}
          onChange={(v) =>
            setDraft((p) => ({ ...p, neo4j: { ...p.neo4j, user: v } }))
          }
          placeholder="neo4j"
        />

        <div className="flex items-center justify-between pt-1">
          <RestartNotice />
          {isDirty && (
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDraft(core)}
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
      </div>
    </div>
  );
}

/* ── Autonomous SIGE panel (manual-only by default) ── */
function AutoPanel({
  auto,
  onSaved,
}: {
  readonly auto: SigeAuto;
  readonly onSaved: (next: SigeAuto) => void;
}) {
  const { success, error: toastError } = useToast();
  const [draft, setDraft] = useState<SigeAuto>(auto);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(auto), [auto]);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(auto);

  async function handleSave() {
    setSaving(true);
    try {
      await apiFetch("/api/config/sige/auto", {
        method: "PUT",
        body: JSON.stringify({
          enabled: draft.enabled,
          cadence: draft.cadence,
          maxDeepFrontiers: draft.maxDeepFrontiers,
          broadPoolSize: draft.broadPoolSize,
          maxConcurrent: draft.maxConcurrent,
          memoryWriteback: draft.memoryWriteback,
        }),
      });
      onSaved(draft);
      success("Autonomous SIGE config saved.");
    } catch {
      toastError("Failed to save autonomous SIGE config.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-bg-1 border border-border rounded-xl p-5">
      <div className="flex items-start gap-3.5 mb-4">
        <div className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center bg-pink-subtle text-pink">
          <RefreshCw className="w-[18px] h-[18px]" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-strong m-0 mb-1">
            Autonomous SIGE (Self-Scheduler)
          </h3>
          <p className="text-xs text-muted m-0 leading-relaxed">
            By default SIGE runs <strong>manual-only</strong> — it generates
            ideas only when you trigger a run. Enabling this turns on the
            self-scheduler, which auto-ticks on the chosen cadence with no human
            in the loop.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <RowToggle
          label="Self-scheduler enabled"
          description="OFF = manual-only. ON = SIGE auto-runs on the cadence below."
          checked={draft.enabled}
          onChange={(v) => setDraft((p) => ({ ...p, enabled: v }))}
        />
        <RowEnum<"manual" | "daily">
          label="Cadence"
          description="'manual' never auto-ticks; 'daily' runs once every ~24h."
          value={draft.cadence}
          options={[
            { value: "manual", label: "Manual (no auto-tick)" },
            { value: "daily", label: "Daily" },
          ]}
          onChange={(v) => setDraft((p) => ({ ...p, cadence: v }))}
        />
        <RowNumber
          label="Max deep frontiers"
          description="Full expert-game runs per discovery cycle (hard cap 3)."
          value={draft.maxDeepFrontiers}
          min={1}
          max={3}
          onChange={(v) => setDraft((p) => ({ ...p, maxDeepFrontiers: v }))}
        />
        <RowNumber
          label="Broad pool size"
          description="Cheap Round-1 broad candidates per cycle (hard cap 200)."
          value={draft.broadPoolSize}
          min={1}
          max={200}
          onChange={(v) => setDraft((p) => ({ ...p, broadPoolSize: v }))}
        />
        <RowNumber
          label="Max concurrent"
          description="Concurrent deep-game slots (locked at 1)."
          value={draft.maxConcurrent}
          min={1}
          max={1}
          onChange={(v) => setDraft((p) => ({ ...p, maxConcurrent: v }))}
        />
        <RowToggle
          label="Memory write-back"
          description="Write autonomous top-ideas back to mem0 (off avoids feedback loops)."
          checked={draft.memoryWriteback}
          onChange={(v) => setDraft((p) => ({ ...p, memoryWriteback: v }))}
        />

        <div className="flex items-center justify-between pt-1">
          <RestartNotice />
          {isDirty && (
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDraft(auto)}
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
      </div>
    </div>
  );
}

/* ── Section export (wired into Settings nav by the Integration agent) ── */
export default function SigeSettings() {
  const { error: toastError } = useToast();
  const [config, setConfig] = useState<SigeConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ data: SigeConfigResponse }>(
          "/api/config/sige",
        );
        if (!cancelled) setConfig(res.data);
      } catch {
        if (!cancelled) toastError("Failed to load SIGE config.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <LoadingState message="Loading SIGE config..." />;
  if (!config) return null;

  return (
    <div className="flex flex-col gap-3 max-w-[760px]">
      <CorePanel
        core={config.core}
        onSaved={(next) => setConfig((prev) => (prev ? { ...prev, core: next } : prev))}
      />
      <AutoPanel
        auto={config.auto}
        onSaved={(next) => setConfig((prev) => (prev ? { ...prev, auto: next } : prev))}
      />
    </div>
  );
}
