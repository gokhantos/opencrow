/**
 * AgentLedger — per-agent action breakdown for one expert-game round or the
 * taste_filter step.
 *
 * Render contract (matching CONTRACT spec):
 *   - One row per agent, sorted by createdAt asc.
 *   - Role badge, actionType chip, confidence meter (0-1), score if present.
 *   - Expandable reasoning block.
 *   - IDEAS parsed defensively from action.content; falls back to raw text.
 *   - For taste_filter substep, renders pass/eliminate verdicts from artifacts.
 *
 * Design: refined instrument-panel aesthetic — dark bg tokens, accent #a78bfa
 * (text-accent), cn() for composition.
 *
 * Accessibility: role="list", aria-expanded on expand buttons, aria meter attrs.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, Zap, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "../../../lib/cn";
import type { AgentActionRecord, RoundLedger, RoundArtifacts } from "../types";
import {
  parseActionContent,
  extractTasteVerdicts,
  mergeArtifacts,
} from "./agentLedgerHelpers";

// ─── Role badge colours ────────────────────────────────────────────────────────

const ROLE_COLOURS: Record<string, string> = {
  challenger: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  defender: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  synthesizer: "bg-purple-500/15 text-purple-300 border-purple-500/30",
  skeptic: "bg-red-500/15 text-red-300 border-red-500/30",
  advocate: "bg-green-500/15 text-green-300 border-green-500/30",
  evaluator: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30",
};

function roleBadgeClass(role: string): string {
  return ROLE_COLOURS[role.toLowerCase()] ?? "bg-bg-3 text-muted border-border";
}

// ─── Confidence meter ──────────────────────────────────────────────────────────

function ConfidenceMeter({ value }: { readonly value: number }) {
  const pct = Math.max(0, Math.min(1, value));
  const colour = pct >= 0.75 ? "bg-success/70" : pct >= 0.45 ? "bg-accent/70" : "bg-warning/70";
  return (
    <div className="flex items-center gap-1.5">
      <div
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-label={`Confidence ${Math.round(pct * 100)}%`}
        className="w-14 h-1.5 bg-bg-3 rounded-full overflow-hidden"
      >
        <div
          className={cn("h-full rounded-full transition-all duration-500", colour)}
          style={{ width: `${Math.round(pct * 100)}%` }}
        />
      </div>
      <span className="font-mono text-[10px] text-faint tabular-nums">
        {Math.round(pct * 100)}%
      </span>
    </div>
  );
}

// ─── Ideas list ────────────────────────────────────────────────────────────────

function IdeasList({ ideas, parseError, raw }: ReturnType<typeof parseActionContent>) {
  if (parseError) {
    return (
      <div className="mt-1.5">
        <span className="text-[10px] text-faint uppercase tracking-wide font-semibold">Content</span>
        <p className="mt-1 text-[11px] text-muted font-mono leading-relaxed break-all">
          {raw.length > 200 ? `${raw.slice(0, 200)}…` : raw}
        </p>
      </div>
    );
  }
  if (ideas.length === 0) return null;
  return (
    <div className="mt-1.5">
      <span className="text-[10px] text-faint uppercase tracking-wide font-semibold">Ideas</span>
      <ul className="mt-1 space-y-0.5">
        {ideas.map((idea, i) => (
          <li key={i} className="flex items-start gap-1.5">
            <Zap size={9} className="text-accent/60 mt-0.5 shrink-0" aria-hidden="true" />
            <span className="text-[11px] text-muted leading-snug">{idea.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Single agent row ──────────────────────────────────────────────────────────

function AgentRow({ action, isLast }: { readonly action: AgentActionRecord; readonly isLast: boolean }) {
  const [open, setOpen] = useState(false);
  const parsed = parseActionContent(action.content);
  const hasExpand = action.reasoning.length > 0 || parsed.ideas.length > 0 || parsed.parseError;

  return (
    <li className={cn("pl-2 py-2.5 px-3", !isLast && "border-b border-border/40")}>
      {/* Top row: role + actionType + confidence + score + expand toggle */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded border uppercase tracking-wide shrink-0", roleBadgeClass(action.role))}>
          {action.role}
        </span>
        <span className="text-[10px] font-mono bg-bg-3 border border-border px-1.5 py-0.5 rounded text-faint shrink-0">
          {action.actionType}
        </span>
        <ConfidenceMeter value={action.confidence} />
        {action.score != null && (
          <span className="ml-auto font-mono text-[10px] text-foreground tabular-nums shrink-0">
            score <span className="text-accent font-bold">{action.score.toFixed(3)}</span>
          </span>
        )}
        {hasExpand && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? "Collapse detail" : "Expand detail"}
            className={cn(
              "ml-auto flex items-center gap-0.5 text-[10px] text-muted hover:text-foreground",
              "bg-transparent border-none cursor-pointer p-0 transition-colors",
              action.score != null && "ml-2",
            )}
          >
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        )}
      </div>

      {/* Agent ID — subtle secondary line */}
      <div className="mt-0.5 text-[10px] text-faint font-mono truncate">{action.agentId}</div>

      {/* Expanded detail */}
      {open && (
        <div className="mt-2 space-y-1.5 pl-1">
          {action.reasoning.length > 0 && (
            <div>
              <span className="text-[10px] text-faint uppercase tracking-wide font-semibold">Reasoning</span>
              <p className="mt-0.5 text-[11px] text-muted leading-relaxed m-0">{action.reasoning}</p>
            </div>
          )}
          <IdeasList {...parsed} />
          {action.targetIdeas.length > 0 && (
            <div>
              <span className="text-[10px] text-faint uppercase tracking-wide font-semibold">Targets</span>
              <div className="mt-0.5 flex flex-wrap gap-1">
                {action.targetIdeas.map((t, i) => (
                  <span key={i} className="text-[10px] font-mono bg-bg-3 border border-border px-1.5 py-0.5 rounded text-faint">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ─── Taste filter verdict panel ────────────────────────────────────────────────

function TasteFilterPanel({ artifacts }: { readonly artifacts: RoundArtifacts }) {
  if (artifacts.tasteFilter == null) return null;
  const verdicts = extractTasteVerdicts(artifacts.tasteFilter);
  if (verdicts.length === 0) return null;

  return (
    <div className="px-3 py-2.5 border-t border-border/40">
      <span className="text-[10px] text-faint uppercase tracking-wide font-semibold">
        Taste Filter Verdicts
      </span>
      <ul role="list" className="mt-1.5 space-y-1">
        {verdicts.map((v, i) => {
          const isPass = v.verdict === "pass";
          const label = v.title ?? v.ideaId ?? `Item ${i + 1}`;
          return (
            <li key={i} className="flex items-center gap-1.5">
              {isPass
                ? <CheckCircle2 size={11} className="text-success shrink-0" aria-hidden="true" />
                : <XCircle size={11} className="text-danger shrink-0" aria-hidden="true" />}
              <span className={cn("text-[11px]", isPass ? "text-success/80" : "text-danger/80")}>
                {label}
              </span>
              <span className={cn("ml-auto text-[10px] font-semibold uppercase tracking-wide", isPass ? "text-success/60" : "text-danger/60")}>
                {isPass ? "pass" : "eliminate"}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── Empty / loading / error states ───────────────────────────────────────────

function LedgerLoading() {
  return (
    <div className="px-3 py-4 space-y-2" aria-busy="true" aria-label="Loading agent ledger">
      {[1, 2, 3].map((n) => (
        <div key={n} className="flex items-center gap-2">
          <div className="h-4 w-14 bg-bg-3 rounded animate-pulse" />
          <div className="h-4 w-20 bg-bg-3 rounded animate-pulse" />
          <div className="h-3 w-16 bg-bg-3 rounded animate-pulse" />
        </div>
      ))}
    </div>
  );
}

// ─── Public component ──────────────────────────────────────────────────────────

export interface AgentLedgerProps {
  /** The round ledger(s) to display. May contain one or multiple rounds. */
  readonly ledgers: readonly RoundLedger[];
  readonly loading: boolean;
  readonly error: string | null;
  /** When true, renders taste_filter verdict panel from artifacts. */
  readonly isTasteFilter?: boolean;
}

/**
 * AgentLedger renders a compact instrument-panel list of agent actions.
 * Purely presentational — callers supply the fetched data.
 * Agents are sorted by createdAt ascending.
 */
export function AgentLedger({ ledgers, loading, error, isTasteFilter = false }: AgentLedgerProps) {
  if (loading) return <LedgerLoading />;

  if (error) {
    return (
      <div className="px-3 py-3 text-xs text-danger/80" role="alert">
        Failed to load ledger: {error}
      </div>
    );
  }

  const allActions = ledgers
    .flatMap((l) => l.actions)
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt);

  if (allActions.length === 0) {
    return (
      <div className="px-3 py-3 text-xs text-faint italic">
        No agent actions recorded for this round yet.
      </div>
    );
  }

  const combinedArtifacts = mergeArtifacts(ledgers.map((l) => l.artifacts));

  return (
    <div
      className="bg-bg-1 border border-border/60 rounded-lg overflow-hidden"
      aria-label="Agent action ledger"
    >
      <ul role="list" aria-label="Agent actions">
        {allActions.map((action, i) => (
          <AgentRow
            key={`${action.agentId}-${action.round}-${i}`}
            action={action}
            isLast={i === allActions.length - 1 && (!isTasteFilter || combinedArtifacts == null)}
          />
        ))}
      </ul>
      {isTasteFilter && combinedArtifacts != null && (
        <TasteFilterPanel artifacts={combinedArtifacts} />
      )}
    </div>
  );
}
