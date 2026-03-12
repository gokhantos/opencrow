import { useState, useRef, useEffect } from "react";
import { cn } from "../../lib/cn";
import { OVERLAY_INDICATORS, OSCILLATOR_GROUPS } from "./types";

interface Props {
  readonly enabledOverlays: ReadonlySet<string>;
  readonly enabledOscillators: ReadonlySet<string>;
  readonly onToggleOverlay: (key: string) => void;
  readonly onToggleOscillator: (id: string) => void;
}

export default function IndicatorToggles({
  enabledOverlays,
  enabledOscillators,
  onToggleOverlay,
  onToggleOscillator,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleMouse = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleMouse);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleMouse);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const activeCount =
    [...enabledOverlays].length + [...enabledOscillators].length;

  return (
    <div ref={wrapRef} className="absolute top-1.5 right-3 z-10">
      <button
        className={cn(
          "flex items-center gap-1.5 py-1.5 px-3 border border-border-2 rounded-md bg-bg-1 text-muted text-sm font-semibold cursor-pointer transition-all duration-150 ease-in-out hover:bg-bg-3 hover:text-foreground hover:border-border-hover",
          open && "bg-bg-3 text-accent border-accent",
        )}
        onClick={() => setOpen((prev) => !prev)}
        aria-label="Toggle chart indicators"
        aria-expanded={open}
        aria-haspopup="true"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M3 3v18h18" />
          <path d="M7 16l4-8 4 4 5-10" />
        </svg>
        {activeCount > 0 && (
          <span className="font-mono text-xs py-px px-1.5 rounded-full bg-accent-subtle text-accent">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute top-[calc(100%+4px)] right-0 w-[220px] max-h-[400px] overflow-y-auto bg-bg-1 border border-border-2 rounded-lg p-1.5 animate-[menuDrop_0.15s_ease-out]">
          <div className="mb-1">
            <div className="font-heading text-xs font-semibold uppercase tracking-wide text-faint py-1.5 px-2 pt-1.5 pb-0.5">
              Overlays
            </div>
            {OVERLAY_INDICATORS.map((ind) => {
              const active = enabledOverlays.has(ind.key);
              return (
                <button
                  key={ind.key}
                  className={cn(
                    "flex items-center gap-2 w-full py-1.5 px-2.5 border-none rounded-md bg-transparent text-muted text-sm font-medium cursor-pointer text-left transition-all duration-150 ease-in-out hover:bg-bg-3 hover:text-foreground",
                    active && "text-strong bg-bg-3",
                  )}
                  onClick={() => onToggleOverlay(ind.key)}
                  role="checkbox"
                  aria-checked={active}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: ind.color }}
                  />
                  {ind.label}
                </button>
              );
            })}
          </div>
          <div>
            <div className="font-heading text-xs font-semibold uppercase tracking-wide text-faint py-1.5 px-2 pt-1.5 pb-0.5">
              Oscillators
            </div>
            {OSCILLATOR_GROUPS.map((grp) => {
              const active = enabledOscillators.has(grp.id);
              const color = grp.colors[0] ?? "#8e8a83";
              return (
                <button
                  key={grp.id}
                  className={cn(
                    "flex items-center gap-2 w-full py-1.5 px-2.5 border-none rounded-md bg-transparent text-muted text-sm font-medium cursor-pointer text-left transition-all duration-150 ease-in-out hover:bg-bg-3 hover:text-foreground",
                    active && "text-strong bg-bg-3",
                  )}
                  onClick={() => onToggleOscillator(grp.id)}
                  role="checkbox"
                  aria-checked={active}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: color }}
                  />
                  {grp.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
