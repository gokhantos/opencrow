/**
 * Settings section for the graph-reasoning config domain
 * (`config/smart.graphReasoning`).
 *
 * GETs the current EFFECTIVE values from /api/config/graph (DB override > env >
 * default), lets the user edit each field with the appropriate control, and
 * PUTs a partial override on save. All fields are restart-required, so a notice
 * is shown.
 *
 * Self-contained card; the Integration agent wires it into the Settings nav.
 */
import { useState, useEffect, useId } from "react";
import { Network, RotateCcw } from "lucide-react";
import { apiFetch } from "../../api";
import { Button, Toggle } from "../../components";
import { useToast } from "../../components/Toast";

interface GraphReasoningConfig {
  readonly enabled: boolean;
  readonly maxHops: number;
  readonly maxPaths: number;
  readonly searchLimit: number;
  readonly minDegree: number;
  readonly maxDegree: number;
}

interface NumberFieldDef {
  readonly key: keyof Omit<GraphReasoningConfig, "enabled">;
  readonly label: string;
  readonly description: string;
  readonly min: number;
  readonly max: number;
}

// Bounds mirror graphReasoningOverrideSchema in src/web/routes/config-graph.ts.
const NUMBER_FIELDS: readonly NumberFieldDef[] = [
  {
    key: "maxHops",
    label: "Max hops",
    description: "Path length in a returned opportunity path",
    min: 2,
    max: 6,
  },
  {
    key: "maxPaths",
    label: "Max paths",
    description: "Paths rendered into the directive (query LIMIT)",
    min: 1,
    max: 20,
  },
  {
    key: "searchLimit",
    label: "Search limit",
    description: "Seed (pain) nodes to expand from",
    min: 1,
    max: 100,
  },
  {
    key: "minDegree",
    label: "Min degree",
    description: "Lower degree bound on the seed node (skips leaf noise)",
    min: 1,
    max: 1000,
  },
  {
    key: "maxDegree",
    label: "Max degree",
    description: "Upper degree bound on every path node (excludes mega-hubs)",
    min: 1,
    max: 5000,
  },
];

/* ── Number field (mirrors Settings.tsx ConfigField) ── */
function NumberField({
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

export default function GraphSettings() {
  const { success, error: toastError } = useToast();
  const [config, setConfig] = useState<GraphReasoningConfig | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ data: GraphReasoningConfig }>("/api/config/graph")
      .then((res) => {
        if (!cancelled) setConfig(res.data);
      })
      .catch(() => {
        if (!cancelled) toastError("Failed to load graph-reasoning config.");
      });
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    if (!config) return;
    setSaving(true);
    try {
      const res = await apiFetch<{ data: GraphReasoningConfig }>("/api/config/graph", {
        method: "PUT",
        body: JSON.stringify(config),
      });
      setConfig(res.data);
      success("Graph-reasoning config saved.");
    } catch {
      toastError("Failed to save graph-reasoning config.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-bg-1 border border-border rounded-xl p-5 transition-all duration-200 hover:border-border-hover">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3.5 min-w-0">
          <div className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center bg-accent-subtle text-accent">
            <Network className="w-[18px] h-[18px]" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-strong m-0 mb-1">
              Graph Reasoning
            </h3>
            <p className="text-xs text-muted m-0 leading-relaxed">
              Multi-hop opportunity-path traversal of the Neo4j graph, injected
              as guidance at idea seed discovery.
            </p>
          </div>
        </div>
        {config && (
          <Toggle
            checked={config.enabled}
            onChange={(checked) =>
              setConfig((c) => (c ? { ...c, enabled: checked } : c))
            }
            disabled={saving}
          />
        )}
      </div>

      {!config ? (
        <p className="text-xs text-muted py-2 mt-3 ml-[50px]">Loading…</p>
      ) : (
        <div className="mt-4 ml-[50px] flex flex-col gap-2.5">
          {NUMBER_FIELDS.map((f) => (
            <NumberField
              key={f.key}
              label={f.label}
              description={f.description}
              value={config[f.key]}
              min={f.min}
              max={f.max}
              onChange={(v) =>
                setConfig((c) => (c ? { ...c, [f.key]: v } : c))
              }
            />
          ))}

          <div className="flex items-center gap-1.5 text-xs text-faint mt-1">
            <RotateCcw className="w-3 h-3" />
            <span>Takes effect after restart.</span>
          </div>

          <div className="flex justify-end pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSave}
              disabled={saving}
              loading={saving}
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
