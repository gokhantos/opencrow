import React, { useState } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../../components";

interface PresetItem {
  readonly label: string;
  readonly value: number;
}

interface JobControlsProps {
  readonly isRunning: boolean;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onRunNow: () => void;
  readonly actionLoading: boolean;
  // Interval
  readonly intervalMinutes: number;
  readonly onIntervalChange: (minutes: number) => void;
  readonly intervalPresets?: ReadonlyArray<PresetItem>;
  // Optional: per-run count
  readonly maxPerRun?: number;
  readonly onMaxPerRunChange?: (value: number) => void;
  readonly maxPerRunPresets?: ReadonlyArray<PresetItem>;
  readonly maxPerRunLabel?: string;
  // Optional: language filter
  readonly languages?: ReadonlyArray<string> | null;
  readonly onLanguagesChange?: (langs: string[]) => void;
  readonly availableLanguages?: ReadonlyArray<{ readonly label: string; readonly code: string }>;
  // Button labels
  readonly startLabel?: string;
  readonly runNowLabel?: string;
  // Extra settings content (sources, custom fields)
  readonly children?: React.ReactNode;
}

const DEFAULT_INTERVAL_PRESETS: ReadonlyArray<PresetItem> = [
  { label: "5m", value: 5 },
  { label: "15m", value: 15 },
  { label: "30m", value: 30 },
  { label: "1h", value: 60 },
  { label: "2h", value: 120 },
  { label: "4h", value: 240 },
];

const PILL_BASE =
  "py-1.5 px-4 rounded-full bg-bg-2 border border-border text-muted font-mono text-xs font-medium cursor-pointer transition-all duration-150";
const PILL_HOVER =
  "hover:not-disabled:bg-accent-subtle hover:not-disabled:border-accent hover:not-disabled:text-accent";
const PILL_ACTIVE = "bg-accent-subtle border-accent text-accent font-semibold";
const PILL_DISABLED = "disabled:opacity-40 disabled:cursor-not-allowed";
const SECTION_LABEL =
  "font-sans text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-faint mb-2";

/**
 * Shared action bar + collapsible settings panel used by all X feature views.
 * Actions (Start/Stop, Run Now) are always visible.
 * Settings (interval, per-run, languages, custom children) collapse into a panel.
 */
export function JobControls({
  isRunning,
  onStart,
  onStop,
  onRunNow,
  actionLoading,
  intervalMinutes,
  onIntervalChange,
  intervalPresets = DEFAULT_INTERVAL_PRESETS,
  maxPerRun,
  onMaxPerRunChange,
  maxPerRunPresets,
  maxPerRunLabel = "Per run",
  languages,
  onLanguagesChange,
  availableLanguages,
  startLabel = "Start",
  runNowLabel = "Run Now",
  children,
}: JobControlsProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  const showPerRun =
    maxPerRun != null && onMaxPerRunChange != null && maxPerRunPresets != null;
  const showLanguages =
    availableLanguages != null &&
    availableLanguages.length > 0 &&
    languages != null &&
    onLanguagesChange != null;

  function toggleLanguage(code: string) {
    if (!onLanguagesChange || !languages) return;
    const next = languages.includes(code)
      ? languages.filter((c) => c !== code)
      : [...languages, code];
    onLanguagesChange(next);
  }

  // Summary of current settings for the collapsed state
  const activePreset = intervalPresets.find((p) => p.value === intervalMinutes);
  const settingsSummary = [
    activePreset ? activePreset.label : `${intervalMinutes}m`,
    ...(showPerRun ? [`${maxPerRun}/${maxPerRunLabel.toLowerCase()}`] : []),
    ...(showLanguages && languages!.length > 0
      ? [languages!.join(",").toUpperCase()]
      : []),
  ].join(" · ");

  return (
    <div className="mb-5">
      {/* Action bar — always visible */}
      <div className="flex items-center gap-3 mb-3">
        {isRunning ? (
          <Button variant="danger" size="sm" onClick={onStop}>
            Stop
          </Button>
        ) : (
          <Button size="sm" onClick={onStart}>
            {startLabel}
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={onRunNow}
          loading={actionLoading}
        >
          {actionLoading ? "Running..." : runNowLabel}
        </Button>

        <div className="flex-1" />

        {/* Settings toggle */}
        <button
          type="button"
          onClick={() => setSettingsOpen((v) => !v)}
          className={cn(
            "flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-sans transition-all duration-150 cursor-pointer",
            "border border-transparent",
            settingsOpen
              ? "bg-bg-3 text-strong border-border"
              : "text-faint hover:text-muted hover:bg-bg-2",
          )}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
          </svg>
          <span className="max-sm:hidden">{settingsOpen ? "Hide" : "Settings"}</span>
          {!settingsOpen && (
            <span className="font-mono text-faint max-sm:hidden">{settingsSummary}</span>
          )}
        </button>
      </div>

      {/* Collapsible settings panel */}
      <div
        className={cn(
          "overflow-hidden transition-all duration-200 ease-out",
          settingsOpen ? "max-h-[500px] opacity-100" : "max-h-0 opacity-0",
        )}
      >
        <div className="bg-bg-2 border border-border rounded-lg p-4 flex flex-col gap-4">
          {/* Interval row */}
          <div>
            <div className={SECTION_LABEL}>Interval</div>
            <div className="flex gap-1.5 flex-wrap">
              {intervalPresets.map((p) => (
                <button
                  key={p.value}
                  className={cn(
                    PILL_BASE,
                    PILL_HOVER,
                    intervalMinutes === p.value && PILL_ACTIVE,
                    PILL_DISABLED,
                  )}
                  onClick={() => onIntervalChange(p.value)}
                  disabled={isRunning}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Per-run count */}
          {showPerRun && (
            <div>
              <div className={SECTION_LABEL}>{maxPerRunLabel}</div>
              <div className="flex gap-1.5 flex-wrap">
                {maxPerRunPresets!.map((p) => (
                  <button
                    key={p.value}
                    className={cn(
                      PILL_BASE,
                      PILL_HOVER,
                      maxPerRun === p.value && PILL_ACTIVE,
                      PILL_DISABLED,
                    )}
                    onClick={() => onMaxPerRunChange!(p.value)}
                    disabled={isRunning}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Language filter */}
          {showLanguages && (
            <div>
              <div className={cn(SECTION_LABEL, "flex items-center gap-2")}>
                Language filter
                {languages!.length === 0 && (
                  <span className="font-normal opacity-50 normal-case tracking-normal">
                    (any)
                  </span>
                )}
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {availableLanguages!.map((l) => {
                  const active = languages!.includes(l.code);
                  return (
                    <button
                      key={l.code}
                      className={cn(
                        PILL_BASE,
                        PILL_HOVER,
                        active && PILL_ACTIVE,
                        PILL_DISABLED,
                      )}
                      onClick={() => toggleLanguage(l.code)}
                      disabled={isRunning}
                    >
                      {l.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Extra settings from parent */}
          {children}
        </div>
      </div>
    </div>
  );
}
