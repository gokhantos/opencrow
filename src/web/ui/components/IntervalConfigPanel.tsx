import { useState, useEffect } from "react";
import { apiFetch } from "../api";
import { useToast } from "./Toast";
import { Button } from "./Button";
import { Settings2, ChevronDown } from "lucide-react";

export interface IntervalConfigField {
  readonly key: string;
  readonly label: string;
  readonly desc: string;
  readonly min: number;
  readonly max: number;
  readonly defaultValue: number;
}

interface IntervalConfigPanelProps {
  readonly scraperId: string;
  readonly fields: readonly IntervalConfigField[];
}

export function IntervalConfigPanel({ scraperId, fields }: IntervalConfigPanelProps) {
  const { success, error: toastError } = useToast();
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<Record<string, number>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.defaultValue])),
  );
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ data: Record<string, number> }>(
          `/api/features/scraper-config/${scraperId}`,
        );
        if (!cancelled) {
          setConfig(res.data);
          setLoaded(true);
        }
      } catch {
        if (!cancelled) {
          setLoaded(true);
          toastError("Failed to load config.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, scraperId, toastError, loaded]);

  async function handleSave() {
    setSaving(true);
    try {
      await apiFetch(`/api/features/scraper-config/${scraperId}`, {
        method: "PUT",
        body: JSON.stringify(config),
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
        <ChevronDown
          className={`w-3.5 h-3.5 text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="border-t border-border px-4 py-3 flex flex-col gap-3">
          {!loaded ? (
            <p className="text-xs text-muted">Loading...</p>
          ) : (
            <>
              {fields.map((f) => (
                <div key={f.key} className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-foreground">{f.label}</div>
                    <div className="text-xs text-muted mt-0.5">{f.desc}</div>
                  </div>
                  <input
                    type="number"
                    min={f.min}
                    max={f.max}
                    value={config[f.key] ?? f.defaultValue}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      if (!isNaN(n)) setConfig((prev) => ({ ...prev, [f.key]: n }));
                    }}
                    className="w-20 shrink-0 bg-bg-2 border border-border rounded-md px-2 py-1 text-xs text-foreground text-right focus:outline-none focus:border-accent"
                  />
                </div>
              ))}
              <div className="flex justify-end">
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
            </>
          )}
        </div>
      )}
    </div>
  );
}
