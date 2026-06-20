import { Lightbulb, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { apiFetch } from "../../api";
import { Button, LoadingState, Toggle } from "../../components";
import { useToast } from "../../components/Toast";

/**
 * Ideas/funnel config-as-data Settings section. GETs the current EFFECTIVE
 * values from /api/config/ideas (DB > env > default merged config) and PUTs a
 * PARTIAL per section. Each panel saves independently to its own
 * config_overrides key so two panels never clobber each other.
 *
 * These values are read per pipeline run via loadConfigWithOverrides, so they
 * take effect WITHOUT a restart — no restart notice is shown.
 */

interface OutcomeMemory {
  readonly writeBack: boolean;
  readonly readAtSynthesis: boolean;
  readonly reinforceCap: number;
  readonly avoidCap: number;
  readonly searchLimit: number;
}

interface IncumbentExclusion {
  readonly enabled: boolean;
  readonly topN: number;
}

type BucketBy = "archetype" | "category";

interface DiversityGuard {
  readonly enabled: boolean;
  readonly maxBucketShare: number;
  readonly bucketBy: BucketBy;
}

type Capital = "none" | "bootstrap" | "seed" | "funded";
type Appetite = "none" | "low" | "high";

interface BuilderProfile {
  readonly capital: Capital;
  readonly teamSize: number;
  readonly expertiseDomains: readonly string[];
  readonly regulatoryAppetite: Appetite;
  readonly opsAppetite: Appetite;
}

interface Competability {
  readonly enabled: boolean;
  readonly enforceGate: boolean;
  readonly rejectThreshold: number;
  readonly softPenaltyThreshold: number;
  readonly topNIncumbents: number;
  readonly builderProfile: BuilderProfile;
}

interface EffectiveConfig {
  readonly outcomeMemory: OutcomeMemory;
  readonly incumbentExclusion: IncumbentExclusion;
  readonly diversityGuard: DiversityGuard;
  readonly competability: Competability;
}

interface IdeasConfigResponse {
  readonly effective: EffectiveConfig;
  readonly overrides: Record<string, unknown>;
}

/* ── Shared form primitives ── */

function NumberField({
  label,
  description,
  value,
  min,
  max,
  step,
  onChange,
}: {
  readonly label: string;
  readonly description?: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly onChange: (v: number) => void;
}) {
  const baseId = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div id={`${baseId}-l`} className="text-xs font-medium text-foreground">
          {label}
        </div>
        {description && (
          <div id={`${baseId}-d`} className="text-xs text-muted mt-0.5">
            {description}
          </div>
        )}
      </div>
      <input
        type="number"
        min={min}
        max={max}
        step={step ?? 1}
        value={value}
        aria-labelledby={`${baseId}-l`}
        aria-describedby={description ? `${baseId}-d` : undefined}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange(n);
        }}
        className="w-24 shrink-0 bg-bg-2 border border-border rounded-md px-2 py-1 text-xs text-foreground text-right focus:outline-none focus:border-accent"
      />
    </div>
  );
}

function ToggleField({
  label,
  description,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly description?: string;
  readonly checked: boolean;
  readonly onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">{label}</div>
        {description && <div className="text-xs text-muted mt-0.5">{description}</div>}
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}

function SelectField<T extends string>({
  label,
  description,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly description?: string;
  readonly value: T;
  readonly options: readonly T[];
  readonly onChange: (v: T) => void;
}) {
  const baseId = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div id={`${baseId}-l`} className="text-xs font-medium text-foreground">
          {label}
        </div>
        {description && (
          <div id={`${baseId}-d`} className="text-xs text-muted mt-0.5">
            {description}
          </div>
        )}
      </div>
      <select
        value={value}
        aria-labelledby={`${baseId}-l`}
        aria-describedby={description ? `${baseId}-d` : undefined}
        onChange={(e) => onChange(e.target.value as T)}
        className="w-32 shrink-0 bg-bg-2 border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:border-accent"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </div>
  );
}

/* ── String list editor for builderProfile.expertiseDomains ── */
function StringListField({
  label,
  description,
  values,
  onChange,
}: {
  readonly label: string;
  readonly description?: string;
  readonly values: readonly string[];
  readonly onChange: (v: readonly string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  function add() {
    const trimmed = draft.trim();
    if (trimmed === "" || values.includes(trimmed) || values.length >= 50) return;
    onChange([...values, trimmed.slice(0, 80)]);
    setDraft("");
  }

  function remove(domain: string) {
    onChange(values.filter((v) => v !== domain));
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <div className="text-xs font-medium text-foreground">{label}</div>
        {description && <div className="text-xs text-muted mt-0.5">{description}</div>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {values.length === 0 && (
          <span className="text-xs text-faint">No domains — empty never matches (default).</span>
        )}
        {values.map((domain) => (
          <span
            key={domain}
            className="inline-flex items-center gap-1 text-xs bg-bg-3 text-foreground px-2 py-0.5 rounded-full"
          >
            {domain}
            <button
              type="button"
              aria-label={`Remove ${domain}`}
              onClick={() => remove(domain)}
              className="text-muted hover:text-foreground bg-transparent border-none cursor-pointer p-0 flex items-center"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          maxLength={80}
          placeholder="Add a domain (e.g. fintech)"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          className="flex-1 bg-bg-2 border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:border-accent"
        />
        <Button variant="ghost" size="sm" onClick={add} disabled={draft.trim() === ""}>
          Add
        </Button>
      </div>
    </div>
  );
}

/* ── A panel that owns one override section's draft + save ── */
function ConfigPanel<T>({
  title,
  description,
  section,
  initial,
  toBody,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly section: string;
  readonly initial: T;
  readonly toBody: (draft: T) => unknown;
  readonly children: (draft: T, set: (next: T) => void) => React.ReactNode;
}) {
  const { success, error: toastError } = useToast();
  const [draft, setDraft] = useState<T>(initial);
  const [saving, setSaving] = useState(false);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(initial);

  async function handleSave() {
    setSaving(true);
    try {
      await apiFetch(`/api/config/ideas/${section}`, {
        method: "PUT",
        body: JSON.stringify(toBody(draft)),
      });
      success(`${title} saved.`);
    } catch {
      toastError(`Failed to save ${title}.`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-bg-1 border border-border rounded-xl p-5">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-strong m-0">{title}</h3>
        <p className="text-xs text-muted m-0 mt-0.5 leading-relaxed">{description}</p>
      </div>
      <div className="flex flex-col gap-3">{children(draft, setDraft)}</div>
      <div className="flex justify-end gap-2 pt-4">
        {isDirty && (
          <Button variant="ghost" size="sm" onClick={() => setDraft(initial)} disabled={saving}>
            Reset
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={handleSave}
          disabled={saving || !isDirty}
          loading={saving}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

/* ── Main section ── */
export default function IdeasSettings() {
  const { error: toastError } = useToast();
  const [config, setConfig] = useState<EffectiveConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ data: IdeasConfigResponse }>("/api/config/ideas");
        if (!cancelled) setConfig(res.data.effective);
      } catch {
        if (!cancelled) toastError("Failed to load ideas/funnel config.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <LoadingState message="Loading ideas config..." />;
  if (!config) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3.5">
        <div className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center bg-accent-subtle text-accent">
          <Lightbulb className="w-[18px] h-[18px]" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-strong m-0">Ideas &amp; Funnel</h2>
          <p className="text-xs text-muted m-0 mt-0.5">
            Outcome-memory learning, incumbent exclusion, diversity guard, and the competability
            (small-builder moat) gate. Changes apply on the next pipeline run — no restart required.
          </p>
        </div>
      </div>

      {/* Outcome memory */}
      <ConfigPanel<OutcomeMemory>
        title="Outcome Memory"
        description="Write idea verdicts back to mem0 and inject learned REINFORCE/AVOID guidance at synthesis."
        section="outcomeMemory"
        initial={config.outcomeMemory}
        toBody={(d) => d}
      >
        {(draft, set) => (
          <>
            <ToggleField
              label="Write back verdicts"
              description="Persist idea verdicts to mem0 (the write half of the loop)."
              checked={draft.writeBack}
              onChange={(v) => set({ ...draft, writeBack: v })}
            />
            <ToggleField
              label="Read at synthesis"
              description="Inject learned guidance into the synthesis prompt."
              checked={draft.readAtSynthesis}
              onChange={(v) => set({ ...draft, readAtSynthesis: v })}
            />
            <NumberField
              label="Reinforce cap"
              description="Max REINFORCE bullets injected (1–20)."
              value={draft.reinforceCap}
              min={1}
              max={20}
              onChange={(v) => set({ ...draft, reinforceCap: v })}
            />
            <NumberField
              label="Avoid cap"
              description="Max AVOID bullets injected (1–20)."
              value={draft.avoidCap}
              min={1}
              max={20}
              onChange={(v) => set({ ...draft, avoidCap: v })}
            />
            <NumberField
              label="Search limit"
              description="mem0 results per verdict bucket (1–50)."
              value={draft.searchLimit}
              min={1}
              max={50}
              onChange={(v) => set({ ...draft, searchLimit: v })}
            />
          </>
        )}
      </ConfigPanel>

      {/* Incumbent exclusion */}
      <ConfigPanel<IncumbentExclusion>
        title="Incumbent Exclusion"
        description="Drop or down-rank collector signals that name a top-charted incumbent."
        section="incumbentExclusion"
        initial={config.incumbentExclusion}
        toBody={(d) => d}
      >
        {(draft, set) => (
          <>
            <ToggleField
              label="Enabled"
              checked={draft.enabled}
              onChange={(v) => set({ ...draft, enabled: v })}
            />
            <NumberField
              label="Top-N incumbents"
              description="How many top-charted apps to treat as incumbents (1–1000)."
              value={draft.topN}
              min={1}
              max={1000}
              onChange={(v) => set({ ...draft, topN: v })}
            />
          </>
        )}
      </ConfigPanel>

      {/* Diversity guard */}
      <ConfigPanel<DiversityGuard>
        title="Diversity Guard"
        description="Cap any single archetype/category's share of the kept set so the funnel can't collapse into one monoculture."
        section="diversityGuard"
        initial={config.diversityGuard}
        toBody={(d) => d}
      >
        {(draft, set) => (
          <>
            <ToggleField
              label="Enabled"
              checked={draft.enabled}
              onChange={(v) => set({ ...draft, enabled: v })}
            />
            <NumberField
              label="Max bucket share"
              description="Share ceiling (0–1) any one bucket may occupy. ~0.5 = no archetype over half."
              value={draft.maxBucketShare}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => set({ ...draft, maxBucketShare: v })}
            />
            <SelectField<BucketBy>
              label="Bucket by"
              description="Which candidate field defines a bucket."
              value={draft.bucketBy}
              options={["archetype", "category"]}
              onChange={(v) => set({ ...draft, bucketBy: v })}
            />
          </>
        )}
      </ConfigPanel>

      {/* Competability gate */}
      <ConfigPanel<Competability>
        title="Competability Gate"
        description="Penalize ideas behind a small-builder-fatal moat. Shadow mode logs would-reject decisions without dropping ideas."
        section="competability"
        initial={config.competability}
        toBody={(d) => d}
      >
        {(draft, set) => (
          <>
            <ToggleField
              label="Enabled"
              description="Compute + store the competability scorecard for every idea."
              checked={draft.enabled}
              onChange={(v) => set({ ...draft, enabled: v })}
            />
            <ToggleField
              label="Enforce gate"
              description="Actually drop ideas below the reject threshold (off = shadow mode)."
              checked={draft.enforceGate}
              onChange={(v) => set({ ...draft, enforceGate: v })}
            />
            <NumberField
              label="Reject threshold"
              description="Overall (0–5) below which an idea is hard-rejected when enforcing."
              value={draft.rejectThreshold}
              min={0}
              max={5}
              step={0.1}
              onChange={(v) => set({ ...draft, rejectThreshold: v })}
            />
            <NumberField
              label="Soft-penalty threshold"
              description="Soft-penalty band ceiling (0–5): logged/penalized but not rejected."
              value={draft.softPenaltyThreshold}
              min={0}
              max={5}
              step={0.1}
              onChange={(v) => set({ ...draft, softPenaltyThreshold: v })}
            />
            <NumberField
              label="Top-N incumbents (pre-filter)"
              description="Incumbents the cheap heuristic checks idea text against (1–1000)."
              value={draft.topNIncumbents}
              min={1}
              max={1000}
              onChange={(v) => set({ ...draft, topNIncumbents: v })}
            />

            <div className="border-t border-border pt-3 mt-1 flex flex-col gap-3">
              <div className="text-xs font-medium text-muted uppercase tracking-wide">
                Builder profile
              </div>
              <SelectField<Capital>
                label="Capital"
                description="Sustained capital the builder can deploy."
                value={draft.builderProfile.capital}
                options={["none", "bootstrap", "seed", "funded"]}
                onChange={(v) =>
                  set({ ...draft, builderProfile: { ...draft.builderProfile, capital: v } })
                }
              />
              <NumberField
                label="Team size"
                description="Headcount; heads above 1 discount the logistics moat (1–1000)."
                value={draft.builderProfile.teamSize}
                min={1}
                max={1000}
                onChange={(v) =>
                  set({ ...draft, builderProfile: { ...draft.builderProfile, teamSize: v } })
                }
              />
              <SelectField<Appetite>
                label="Regulatory appetite"
                description="Appetite for entering a regulated market."
                value={draft.builderProfile.regulatoryAppetite}
                options={["none", "low", "high"]}
                onChange={(v) =>
                  set({
                    ...draft,
                    builderProfile: { ...draft.builderProfile, regulatoryAppetite: v },
                  })
                }
              />
              <SelectField<Appetite>
                label="Ops appetite"
                description="Appetite for running physical ops."
                value={draft.builderProfile.opsAppetite}
                options={["none", "low", "high"]}
                onChange={(v) =>
                  set({ ...draft, builderProfile: { ...draft.builderProfile, opsAppetite: v } })
                }
              />
              <StringListField
                label="Expertise domains"
                description="Domains the builder has expertise in; a text match discounts that idea's moat. Up to 50, 80 chars each."
                values={draft.builderProfile.expertiseDomains}
                onChange={(v) =>
                  set({
                    ...draft,
                    builderProfile: { ...draft.builderProfile, expertiseDomains: v },
                  })
                }
              />
            </div>
          </>
        )}
      </ConfigPanel>
    </div>
  );
}
