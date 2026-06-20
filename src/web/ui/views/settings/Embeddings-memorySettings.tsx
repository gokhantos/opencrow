import { AlertTriangle, Database, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { apiFetch } from "../../api";
import { Button } from "../../components";
import { useToast } from "../../components/Toast";

/**
 * Embeddings & Memory settings section.
 *
 * Covers two controls that the existing embeddings UI does NOT:
 *  - Memory backend (config/memory) — qdrant | mem0. Restart required.
 *  - Guarded embeddings-dimensions change — changing the vector size requires a
 *    full Qdrant re-index, so we warn loudly and require explicit confirmation
 *    before persisting. The 409 the route returns is surfaced as the confirm
 *    prompt; the user must opt in (confirmReindex) to actually apply it.
 *
 * The general embeddings form (provider/model/batch size) stays in the existing
 * Settings.tsx EmbeddingsSection — this section is additive.
 */

type MemoryBackend = "qdrant" | "mem0";

interface DomainState {
  readonly memory: { readonly backend: MemoryBackend; readonly source: string };
  readonly embeddings: { readonly dimensions: number };
}

const BASE = "/api/config/embeddings-memory";

function RestartNotice() {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-warning bg-warning-subtle px-1.5 py-0.5 rounded-full">
      <RotateCcw className="w-2.5 h-2.5" />
      Takes effect after restart
    </span>
  );
}

function MemoryBackendField({
  value,
  onChange,
  disabled,
}: {
  readonly value: MemoryBackend;
  readonly onChange: (v: MemoryBackend) => void;
  readonly disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground flex items-center gap-2">
          Memory Backend
          <RestartNotice />
        </div>
        <div className="text-xs text-muted mt-0.5">
          Storage backend for scraped-signal memory. `qdrant` is the live default; `mem0` is the
          phase-2 backend.
        </div>
      </div>
      <select
        className="w-40 shrink-0 bg-bg-2 border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:border-accent disabled:opacity-50"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as MemoryBackend)}
      >
        <option value="qdrant">qdrant</option>
        <option value="mem0">mem0</option>
      </select>
    </div>
  );
}

function DimensionsField({
  value,
  onChange,
  disabled,
}: {
  readonly value: number;
  readonly onChange: (v: number) => void;
  readonly disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground flex items-center gap-2">
          Embeddings Dimensions
          <RestartNotice />
        </div>
        <div className="text-xs text-muted mt-0.5">
          Vector size — must match the Qdrant collection. Changing this requires a full re-index of
          all stored vectors.
        </div>
      </div>
      <input
        type="number"
        min={32}
        max={4096}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-24 shrink-0 bg-bg-2 border border-border rounded-md px-2 py-1 text-xs text-foreground text-right focus:outline-none focus:border-accent disabled:opacity-50"
      />
    </div>
  );
}

export default function EmbeddingsMemorySettings() {
  const { success, error: toastError } = useToast();
  const [state, setState] = useState<DomainState | null>(null);
  const [loading, setLoading] = useState(true);

  const [backendDraft, setBackendDraft] = useState<MemoryBackend>("qdrant");
  const [dimsDraft, setDimsDraft] = useState<number>(512);

  const [savingBackend, setSavingBackend] = useState(false);
  const [savingDims, setSavingDims] = useState(false);
  const [confirmReindex, setConfirmReindex] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ data: DomainState }>(BASE);
        if (cancelled) return;
        setState(res.data);
        setBackendDraft(res.data.memory.backend);
        setDimsDraft(res.data.embeddings.dimensions);
      } catch {
        if (!cancelled) toastError("Failed to load embeddings & memory config.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toastError]);

  const backendDirty = state !== null && backendDraft !== state.memory.backend;
  const dimsDirty = state !== null && dimsDraft !== state.embeddings.dimensions;

  async function saveBackend() {
    setSavingBackend(true);
    try {
      await apiFetch(`${BASE}/memory`, {
        method: "PUT",
        body: JSON.stringify({ backend: backendDraft }),
      });
      setState((prev) =>
        prev ? { ...prev, memory: { backend: backendDraft, source: "override" } } : prev,
      );
      success("Memory backend saved. Restart to apply.");
    } catch {
      toastError("Failed to save memory backend.");
    } finally {
      setSavingBackend(false);
    }
  }

  async function saveDimensions() {
    setSavingDims(true);
    try {
      await apiFetch(`${BASE}/embeddings/dimensions`, {
        method: "PUT",
        body: JSON.stringify({ dimensions: dimsDraft, confirmReindex }),
      });
      setState((prev) => (prev ? { ...prev, embeddings: { dimensions: dimsDraft } } : prev));
      setConfirmReindex(false);
      success("Embeddings dimensions changed. A re-index is required.");
    } catch (err) {
      // 409 = needs confirmation; any other = generic failure.
      const status = (err as { status?: number }).status;
      if (status === 409) {
        toastError("Confirm the re-index to change dimensions.");
      } else {
        toastError("Failed to change embeddings dimensions.");
      }
    } finally {
      setSavingDims(false);
    }
  }

  if (loading || state === null) {
    return <p className="text-xs text-muted py-2">Loading embeddings & memory config…</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Database className="w-4 h-4 text-muted" />
        <h3 className="text-sm font-semibold text-foreground">Embeddings &amp; Memory</h3>
      </div>

      <div className="bg-bg-2 border border-border rounded-lg p-3 flex flex-col gap-3">
        <MemoryBackendField
          value={backendDraft}
          onChange={setBackendDraft}
          disabled={savingBackend}
        />
        {backendDirty && (
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setBackendDraft(state.memory.backend)}
              disabled={savingBackend}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={saveBackend}
              disabled={savingBackend}
              loading={savingBackend}
            >
              Save
            </Button>
          </div>
        )}
      </div>

      <div className="bg-bg-2 border border-border rounded-lg p-3 flex flex-col gap-3">
        <DimensionsField value={dimsDraft} onChange={setDimsDraft} disabled={savingDims} />

        {dimsDirty && (
          <div className="flex flex-col gap-3 border-t border-border pt-3">
            <div className="flex items-start gap-2 text-xs text-warning bg-warning-subtle rounded-md p-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Changing dimensions from <strong>{state.embeddings.dimensions}</strong> to{" "}
                <strong>{dimsDraft}</strong> invalidates every stored vector. The Qdrant collection
                must be dropped and fully re-indexed before search works again.
              </span>
            </div>
            <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={confirmReindex}
                onChange={(e) => setConfirmReindex(e.target.checked)}
                className="accent-accent"
              />
              I understand this requires a full Qdrant re-index.
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDimsDraft(state.embeddings.dimensions);
                  setConfirmReindex(false);
                }}
                disabled={savingDims}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={saveDimensions}
                disabled={savingDims || !confirmReindex}
                loading={savingDims}
              >
                Change &amp; Require Re-index
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
