// Shared preset/filter bar for the App Store keyword screens — the exact
// same preset buttons + numeric-filter/trend/hide-junk panel back both the
// Keywords table (OpportunitiesTab.tsx) and the Concepts view (ConceptsTab.tsx),
// since both hit member-level filters with identical semantics (see
// `clusterMemberFilterSchema` in src/web/routes/appstore.ts — same shape as
// the opportunities filters, minus `genreZone`, which clusters span). Kept as
// a standalone module (not exported from either tab) so neither screen owns
// the other's UI.
import { Toggle } from "../../components";
import { cn } from "../../lib/cn";
import { PRESETS, TREND_OPTIONS } from "./opportunities-format";
import type { NumericDraft, PresetId, TrendFilterValue } from "./opportunities-format";

export const selectClass =
  "px-2 py-1.5 bg-bg-1 border border-border-2 rounded-lg text-foreground text-xs font-mono outline-none transition-colors duration-150 focus:border-accent cursor-pointer";

export const numericInputClass =
  "px-2 py-1.5 bg-bg-1 border border-border-2 rounded-lg text-foreground text-xs font-mono outline-none transition-colors duration-150 focus:border-accent w-[110px]";

// ─── Preset bar ──────────────────────────────────────────────────────────────

interface PresetBarProps {
  readonly activePreset: PresetId | null;
  readonly onSelect: (id: PresetId) => void;
}

export function PresetBar({ activePreset, onSelect }: PresetBarProps) {
  return (
    <div className="flex items-center gap-2 flex-wrap" role="group" aria-label="Filter presets">
      {PRESETS.map((preset) => {
        const isActive = activePreset === preset.id;
        return (
          <button
            key={preset.id}
            type="button"
            aria-pressed={isActive}
            onClick={() => onSelect(preset.id)}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors duration-150 border",
              isActive
                ? "bg-accent text-white border-accent"
                : "bg-transparent border-border-2 text-muted hover:bg-bg-2 hover:border-border-hover hover:text-foreground",
            )}
          >
            {preset.label}
          </button>
        );
      })}
      {activePreset === null && (
        <span className="px-2 py-1 text-xs font-medium text-faint">Custom</span>
      )}
    </div>
  );
}

// ─── Filter panel (compact, power-user controls next to the presets) ────────

interface NumericFilterInputProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}

export function NumericFilterInput({ label, value, onChange }: NumericFilterInputProps) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-faint">{label}</span>
      <input
        type="number"
        step="any"
        inputMode="decimal"
        value={value}
        placeholder="Any"
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className={numericInputClass}
      />
    </div>
  );
}

export interface FilterPanelProps {
  readonly draft: NumericDraft;
  readonly onDraftChange: (next: NumericDraft) => void;
  readonly trend: TrendFilterValue | null;
  readonly onTrendChange: (value: TrendFilterValue | "") => void;
  readonly hideJunk: boolean;
  readonly onHideJunkChange: (checked: boolean) => void;
}

export function FilterPanel({
  draft,
  onDraftChange,
  trend,
  onTrendChange,
  hideJunk,
  onHideJunkChange,
}: FilterPanelProps) {
  return (
    <div className="flex items-end gap-3 flex-wrap p-2.5 rounded-lg border border-border-2 bg-bg-1">
      <NumericFilterInput
        label="Min demand"
        value={draft.minDemand}
        onChange={(v) => onDraftChange({ ...draft, minDemand: v })}
      />
      <NumericFilterInput
        label="Max competitiveness"
        value={draft.maxCompetitiveness}
        onChange={(v) => onDraftChange({ ...draft, maxCompetitiveness: v })}
      />
      <NumericFilterInput
        label="Min incumbent weakness"
        value={draft.minIncumbentWeakness}
        onChange={(v) => onDraftChange({ ...draft, minIncumbentWeakness: v })}
      />
      <NumericFilterInput
        label="Min opportunity"
        value={draft.minOpportunity}
        onChange={(v) => onDraftChange({ ...draft, minOpportunity: v })}
      />
      <NumericFilterInput
        label="Min buildability"
        value={draft.minBuildability}
        onChange={(v) => onDraftChange({ ...draft, minBuildability: v })}
      />

      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-faint">Trend</span>
        <select
          className={selectClass}
          value={trend ?? ""}
          aria-label="Trend filter"
          onChange={(e) => onTrendChange(e.target.value as TrendFilterValue | "")}
        >
          {TREND_OPTIONS.map((opt) => (
            <option key={opt.value || "any"} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <Toggle checked={hideJunk} onChange={onHideJunkChange} label="Hide junk" />
    </div>
  );
}
