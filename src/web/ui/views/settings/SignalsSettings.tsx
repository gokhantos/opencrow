/**
 * Signals settings section (config/smart.signal).
 *
 * Lets the operator toggle scraped-signal faceting + ranking and pick the
 * retrieval importance floor. All three are read at process boot, so the
 * section shows a "Takes effect after restart" notice and persists via
 * PUT /api/config/signals (a partial config_overrides write).
 */
import { useEffect, useId, useState } from "react";
import { apiFetch } from "../../api";
import { Button, Toggle } from "../../components";
import { useToast } from "../../components/Toast";
import { Radar, RotateCw } from "lucide-react";

const IMPORTANCE_FLOORS = ["low", "medium", "high"] as const;
type ImportanceFloor = (typeof IMPORTANCE_FLOORS)[number];

interface SignalsEffective {
  readonly facets: boolean;
  readonly ranking: boolean;
  readonly importanceFloor: ImportanceFloor;
}

interface SignalsState {
  readonly effective: SignalsEffective;
  readonly hasOverride: boolean;
  readonly restartRequired: readonly string[];
}

const IMPORTANCE_LABELS: Readonly<Record<ImportanceFloor, string>> = {
  low: "Low — keep almost everything",
  medium: "Medium — drop weak signals",
  high: "High — only strong signals",
};

/* ── Restart notice ── */
function RestartNotice() {
  return (
    <div className="flex items-center gap-1.5 text-xs text-warning bg-warning-subtle px-2 py-1 rounded-md">
      <RotateCw className="w-3 h-3 shrink-0" />
      <span>Takes effect after restart</span>
    </div>
  );
}

/* ── Toggle row ── */
function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">{label}</div>
        <div className="text-xs text-muted mt-0.5">{description}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} label={label} />
    </div>
  );
}

/* ── Main section ── */
export default function SignalsSettings() {
  const { success, error: toastError } = useToast();
  const selectId = useId();

  const [draft, setDraft] = useState<SignalsEffective | null>(null);
  const [saved, setSaved] = useState<SignalsEffective | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ data: SignalsState }>("/api/config/signals");
        if (cancelled) return;
        setDraft(res.data.effective);
        setSaved(res.data.effective);
      } catch {
        if (!cancelled) toastError("Failed to load signals settings.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function update<K extends keyof SignalsEffective>(key: K, value: SignalsEffective[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  const isDirty =
    draft !== null && saved !== null && JSON.stringify(draft) !== JSON.stringify(saved);

  async function handleSave() {
    if (!draft) return;
    setSaving(true);
    try {
      await apiFetch("/api/config/signals", {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      setSaved(draft);
      success("Signals settings saved. Restart to apply.");
    } catch {
      toastError("Failed to save signals settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-bg-1 border border-border rounded-xl p-5 transition-all duration-200 hover:border-border-hover">
      <div className="flex items-start gap-3.5 min-w-0 mb-4">
        <div className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center bg-accent-subtle text-accent">
          <Radar className="w-[18px] h-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5 mb-1">
            <h3 className="text-sm font-semibold text-strong m-0">Scraped Signals</h3>
            {isDirty && (
              <span className="text-xs font-medium text-warning bg-warning-subtle px-1.5 py-0.5 rounded-full">
                Unsaved
              </span>
            )}
          </div>
          <p className="text-xs text-muted m-0 leading-relaxed">
            Faceting, ranking, and retrieval floor for scraped demand signals.
          </p>
        </div>
        <RestartNotice />
      </div>

      {loading || !draft ? (
        <p className="text-xs text-muted py-1">Loading…</p>
      ) : (
        <div className="flex flex-col gap-3 ml-[50px]">
          <ToggleRow
            label="Signal facets"
            description="Tag scraped signals with structured facets before synthesis."
            checked={draft.facets}
            disabled={saving}
            onChange={(v) => update("facets", v)}
          />
          <ToggleRow
            label="Signal ranking"
            description="Score, calibrate, and filter signals by importance (needs facets)."
            checked={draft.ranking}
            disabled={saving}
            onChange={(v) => update("ranking", v)}
          />

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <label
                htmlFor={selectId}
                className="text-xs font-medium text-foreground block"
              >
                Importance floor
              </label>
              <div className="text-xs text-muted mt-0.5">
                Minimum importance bucket kept during retrieval.
              </div>
            </div>
            <select
              id={selectId}
              value={draft.importanceFloor}
              disabled={saving}
              onChange={(e) =>
                update("importanceFloor", e.target.value as ImportanceFloor)
              }
              className="w-56 shrink-0 bg-bg-2 border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:border-accent disabled:opacity-50"
            >
              {IMPORTANCE_FLOORS.map((f) => (
                <option key={f} value={f}>
                  {IMPORTANCE_LABELS[f]}
                </option>
              ))}
            </select>
          </div>

          {isDirty && (
            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => saved && setDraft(saved)}
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
      )}
    </div>
  );
}
