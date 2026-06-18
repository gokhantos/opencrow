/**
 * ProgressTimeline — mission-control signal timeline for a SIGE session.
 *
 * Renders a vertical spine of the 6 pipeline steps, each expandable to its
 * substeps. Running nodes pulse; a stalled run shows a decisive amber STALLED
 * banner with the reason and elapsed stall time. Live elapsed timers tick every
 * second via a single shared interval seeded from the polled `startedAt`.
 *
 * Design direction: refined instrument panel — cohesive with the existing dark
 * #0a0a0c / accent #a78bfa tokens. NOT a maximalist redesign.
 *
 * Accessibility:
 *   - Each step is a <button> with aria-expanded; substeps have role="list".
 *   - State icons carry aria-label. Pulsing animation is suppressed under
 *     prefers-reduced-motion.
 *   - STALLED banner has role="alert" for screen-reader urgency.
 */
import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Circle,
  Loader2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Clock,
} from "lucide-react";
import { cn } from "../../../lib/cn";
import type {
  SessionProgress,
  ProgressStep,
  ProgressSubstep,
  SubstepState,
  RoundLedger,
} from "../types";
import { TERMINAL_STATUSES } from "../statusConfig";
import { fetchSessionActions } from "../api";
import { AgentLedger } from "./AgentLedger";

// ─── Constants ────────────────────────────────────────────────────────────────

const STEP_ORDER: readonly string[] = [
  "knowledge_construction",
  "game_formulation",
  "expert_game",
  "social_simulation",
  "scoring",
  "report_generation",
];

/**
 * Substep keys that have a drillable agent ledger.
 * round_1..round_4 map to round numbers 1-4; taste_filter is a pseudo-round.
 */
const LEDGER_SUBSTEP_KEYS = new Set([
  "round_1",
  "round_2",
  "round_3",
  "round_4",
  "taste_filter",
]);

/** Parse the round number from a substep key like "round_3" → 3, taste_filter → 0 */
function substepKeyToRound(key: string): number | undefined {
  if (key === "taste_filter") return 0;
  const m = key.match(/^round_(\d+)$/);
  if (m?.[1] != null) return Number(m[1]);
  return undefined;
}

// ─── Ledger cache ─────────────────────────────────────────────────────────────

/** In-memory cache keyed by `${sessionId}:${round}` to avoid re-fetching on collapse/expand. */
const ledgerCache = new Map<string, readonly RoundLedger[]>();

// ─── useLedger hook ────────────────────────────────────────────────────────────

interface UseLedgerResult {
  readonly ledgers: readonly RoundLedger[];
  readonly loading: boolean;
  readonly error: string | null;
}

/**
 * Lazy-fetch: does nothing until `enabled` is true.
 * Caches per (sessionId, round) so re-expanding doesn't re-fetch.
 * Aborts the request on unmount or when `enabled` flips back to false.
 */
function useLedger(
  sessionId: string | undefined,
  round: number | undefined,
  enabled: boolean,
): UseLedgerResult {
  const cacheKey =
    sessionId != null && round != null ? `${sessionId}:${round}` : null;

  const cached = cacheKey != null ? ledgerCache.get(cacheKey) : undefined;

  const [ledgers, setLedgers] = useState<readonly RoundLedger[]>(cached ?? []);
  const [loading, setLoading] = useState(!cached && enabled);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const fetchedRef = useRef(cached != null);

  useEffect(() => {
    if (!enabled || sessionId == null || round == null) return;
    if (fetchedRef.current) return;

    fetchedRef.current = true;
    setLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;

    // taste_filter is pseudo-round 0 — pass no round filter to get all actions
    // for that step (the API may store taste_filter actions under a different round
    // value; passing undefined fetches all rounds and we display them together).
    const roundParam = round === 0 ? undefined : round;

    fetchSessionActions(sessionId, roundParam, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        if (cacheKey != null) ledgerCache.set(cacheKey, res.rounds);
        setLedgers(res.rounds);
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const msg =
          typeof err === "object" &&
          err !== null &&
          "message" in err
            ? String((err as { message: unknown }).message)
            : "Failed to load";
        setError(msg);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => {
      controller.abort();
    };
    // Only re-run when enabled flips true for a new (sessionId, round) pair.
    // fetchedRef prevents double-fetching on re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sessionId, round]);

  return { ledgers, loading, error };
}

// ─── Time formatting ──────────────────────────────────────────────────────────

/** Format seconds to "Xm Ys" or just "Xs" */
function fmtSec(sec: number): string {
  if (sec < 60) return `${Math.floor(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

// ─── Live elapsed timer hook ──────────────────────────────────────────────────

/**
 * Returns a tick counter that increments every second while any step/substep
 * is in running state. Used to force re-renders for live elapsed timers without
 * pulling tick state into each node.
 */
function useTick(active: boolean): number {
  const [tick, setTick] = useState(0);
  const idRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!active) {
      if (idRef.current !== null) {
        clearInterval(idRef.current);
        idRef.current = null;
      }
      return;
    }
    idRef.current = setInterval(() => setTick((n) => n + 1), 1000);
    return () => {
      if (idRef.current !== null) {
        clearInterval(idRef.current);
        idRef.current = null;
      }
    };
  }, [active]);

  return tick;
}

// ─── Icon helpers ─────────────────────────────────────────────────────────────

interface StateIconProps {
  readonly state: SubstepState;
  readonly small?: boolean;
}

function StateIcon({ state, small }: StateIconProps) {
  const size = small ? 13 : 16;
  switch (state) {
    case "done":
      return (
        <CheckCircle2
          size={size}
          className="text-success shrink-0"
          aria-label="done"
        />
      );
    case "running":
      return (
        <Loader2
          size={size}
          className="text-accent shrink-0 animate-spin motion-reduce:animate-none"
          aria-label="running"
        />
      );
    case "error":
      return (
        <AlertCircle
          size={size}
          className="text-danger shrink-0"
          aria-label="error"
        />
      );
    default:
      return (
        <Circle
          size={size}
          className="text-border-2 shrink-0"
          aria-label="waiting"
        />
      );
  }
}

// ─── Live elapsed display ──────────────────────────────────────────────────────

interface ElapsedProps {
  readonly startedAt: number | null; // epoch seconds
  readonly endedAt: number | null;
  readonly elapsedSec: number | null;
  readonly state: SubstepState;
  readonly nowSec: number; // current epoch seconds from tick
}

function Elapsed({ startedAt, endedAt, elapsedSec, state, nowSec }: ElapsedProps) {
  let sec: number | null = null;

  if (state === "running" && startedAt != null) {
    sec = nowSec - startedAt;
  } else if (elapsedSec != null) {
    sec = elapsedSec;
  } else if (startedAt != null && endedAt != null) {
    sec = endedAt - startedAt;
  }

  if (sec == null || sec < 0) return null;

  return (
    <span
      className={cn(
        "font-mono text-[10px] tabular-nums shrink-0",
        state === "running" ? "text-accent" : "text-faint",
      )}
      aria-label={`elapsed: ${fmtSec(sec)}`}
    >
      {fmtSec(sec)}
    </span>
  );
}

// ─── Substep node ─────────────────────────────────────────────────────────────

interface SubstepNodeProps {
  readonly substep: ProgressSubstep;
  readonly nowSec: number;
  readonly isLast: boolean;
  /** When provided and substep key is a ledger key, enables drill-down fetch. */
  readonly sessionId?: string;
}

function SubstepNode({ substep, nowSec, isLast, sessionId }: SubstepNodeProps) {
  const isLedgerKey = LEDGER_SUBSTEP_KEYS.has(substep.key);
  // Only allow expansion when substep has started (done or running) — no data yet for waiting.
  const canExpand =
    isLedgerKey &&
    sessionId != null &&
    (substep.state === "done" || substep.state === "running");

  const [open, setOpen] = useState(false);
  const round = canExpand ? substepKeyToRound(substep.key) : undefined;
  const { ledgers, loading: ledgerLoading, error: ledgerError } = useLedger(
    canExpand ? sessionId : undefined,
    round,
    open && canExpand,
  );

  const isTasteFilter = substep.key === "taste_filter";

  return (
    <li
      className={cn(
        "pl-2",
        !isLast && "border-b border-border/40",
      )}
    >
      {/* Header row */}
      <div className="flex items-start gap-2.5 py-1.5">
        {/* Spine continuation dot */}
        <div className="flex flex-col items-center shrink-0 mt-0.5">
          <StateIcon state={substep.state} small />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={cn(
                "text-xs font-medium",
                substep.state === "running"
                  ? "text-foreground"
                  : substep.state === "done"
                  ? "text-muted"
                  : substep.state === "error"
                  ? "text-danger"
                  : "text-faint",
              )}
            >
              {substep.label}
            </span>

            {substep.detail != null && (
              <span className="text-[10px] text-faint bg-bg-3 border border-border px-1.5 py-0.5 rounded font-mono">
                {substep.detail}
              </span>
            )}

            <Elapsed
              startedAt={substep.startedAt}
              endedAt={substep.endedAt}
              elapsedSec={substep.elapsedSec}
              state={substep.state}
              nowSec={nowSec}
            />

            {/* Drill-down toggle */}
            {canExpand && (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className={cn(
                  "ml-auto flex items-center gap-0.5 text-[10px] font-mono",
                  "bg-transparent border-none cursor-pointer p-0 transition-colors",
                  open ? "text-accent" : "text-faint hover:text-muted",
                )}
                aria-label={open ? "Collapse agent ledger" : "Expand agent ledger"}
              >
                {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                <span>ledger</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Lazy-loaded agent ledger */}
      {open && canExpand && (
        <div className="pb-2 pr-1">
          <AgentLedger
            ledgers={ledgers}
            loading={ledgerLoading}
            error={ledgerError}
            isTasteFilter={isTasteFilter}
          />
        </div>
      )}
    </li>
  );
}

// ─── Stalled banner ────────────────────────────────────────────────────────────

interface StalledBannerProps {
  readonly stalledForSec: number | null;
  readonly stalledReason: string | null;
}

function StalledBanner({ stalledForSec, stalledReason }: StalledBannerProps) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex items-start gap-2.5 bg-warning-subtle border border-warning/30 rounded-lg px-4 py-3 mb-3"
    >
      <AlertTriangle
        size={15}
        className="text-warning shrink-0 mt-0.5"
        aria-hidden="true"
      />
      <div className="min-w-0">
        <span className="text-xs font-bold text-warning uppercase tracking-wide">
          STALLED
        </span>
        {stalledForSec != null && (
          <span className="text-xs text-warning/80 font-mono ml-2">
            — no activity for {fmtSec(stalledForSec)}
          </span>
        )}
        {stalledReason && (
          <p className="text-xs text-warning/70 mt-0.5 m-0 leading-relaxed">
            {stalledReason}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Pulsing activity beacon ──────────────────────────────────────────────────

function ActivityBeacon() {
  return (
    <span
      className="relative flex h-2 w-2 shrink-0 motion-reduce:contents"
      aria-hidden="true"
    >
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-50 motion-reduce:hidden" />
      <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
    </span>
  );
}

// ─── Step node ────────────────────────────────────────────────────────────────

interface StepNodeProps {
  readonly step: ProgressStep;
  readonly index: number;
  readonly stalled: boolean;
  readonly stalledForSec: number | null;
  readonly stalledReason: string | null;
  readonly nowSec: number;
  readonly defaultOpen?: boolean;
  /** Forwarded to SubstepNode for drill-down ledger fetches. */
  readonly sessionId?: string;
}

function StepNode({
  step,
  index,
  stalled,
  stalledForSec,
  stalledReason,
  nowSec,
  defaultOpen = false,
  sessionId,
}: StepNodeProps) {
  const [open, setOpen] = useState(defaultOpen || step.state === "running");
  const hasSubsteps = step.substeps.length > 0;
  const isRunning = step.state === "running";
  const isStalled = isRunning && stalled;

  // Auto-open when step becomes running
  useEffect(() => {
    if (step.state === "running") setOpen(true);
  }, [step.state]);

  const panelStyle = cn(
    "rounded-xl border overflow-hidden transition-all duration-500",
    "animate-[fadeSlideIn_0.35s_ease-out]",
    isStalled
      ? "border-warning/40 shadow-[0_0_0_2px_var(--color-warning,#fbbf24)22]"
      : isRunning
      ? "border-accent/40 shadow-[0_0_0_2px_var(--color-accent,#a78bfa)22]"
      : step.state === "done"
      ? "border-border"
      : step.state === "error"
      ? "border-danger/30"
      : "border-border opacity-60",
  );

  const headerStyle = cn(
    "flex items-center gap-3 px-4 py-3 transition-colors",
    isStalled
      ? "bg-warning-subtle/20 border-b border-warning/20"
      : isRunning
      ? "bg-accent-subtle/20 border-b border-accent/20"
      : step.state === "done"
      ? "bg-bg-1 border-b border-border"
      : step.state === "error"
      ? "bg-danger-subtle/20 border-b border-danger/20"
      : "bg-bg-1 border-b border-border",
  );

  return (
    <div
      className={panelStyle}
      role="region"
      aria-label={`Step ${index + 1}: ${step.label} — ${step.state}`}
    >
      {/* Step header — clickable to toggle substeps */}
      <button
        type="button"
        onClick={() => hasSubsteps && setOpen((v) => !v)}
        disabled={!hasSubsteps}
        aria-expanded={hasSubsteps ? open : undefined}
        className={cn(
          "w-full text-left bg-transparent border-none",
          headerStyle,
          hasSubsteps && "cursor-pointer hover:bg-bg-2/30",
          !hasSubsteps && "cursor-default",
        )}
      >
        {/* Index badge */}
        <span
          className={cn(
            "w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0",
            step.state === "done"
              ? "bg-success/15 text-success"
              : isStalled
              ? "bg-warning/15 text-warning"
              : isRunning
              ? "bg-accent/15 text-accent"
              : step.state === "error"
              ? "bg-danger/15 text-danger"
              : "bg-bg-3 text-muted",
          )}
        >
          {index + 1}
        </span>

        {/* Title */}
        <span
          className={cn(
            "text-sm font-semibold flex-1 text-left",
            step.state === "waiting" ? "text-muted" : "text-strong",
          )}
        >
          {step.label}
        </span>

        {/* Activity beacon for running (non-stalled) */}
        {isRunning && !isStalled && <ActivityBeacon />}

        {/* Stalled indicator chip */}
        {isStalled && (
          <span className="text-[10px] font-bold text-warning bg-warning-subtle border border-warning/30 px-2 py-0.5 rounded-full uppercase tracking-wide shrink-0">
            STALLED
          </span>
        )}

        {/* Elapsed */}
        <Elapsed
          startedAt={step.startedAt}
          endedAt={step.endedAt}
          elapsedSec={step.elapsedSec}
          state={step.state}
          nowSec={nowSec}
        />

        {/* State icon */}
        <StateIcon state={step.state} />

        {/* Expand chevron */}
        {hasSubsteps && (
          <span className="text-muted ml-1 shrink-0">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        )}
      </button>

      {/* Stalled banner — inside expanded body */}
      {open && (
        <div className="transition-all duration-300">
          {isStalled && (
            <div className="px-4 pt-3">
              <StalledBanner
                stalledForSec={stalledForSec}
                stalledReason={stalledReason}
              />
            </div>
          )}

          {/* Substeps */}
          {hasSubsteps && (
            <ul
              role="list"
              aria-label={`Substeps for ${step.label}`}
              className="px-4 pb-3 space-y-0"
            >
              {step.substeps.map((sub, i) => (
                <SubstepNode
                  key={sub.key}
                  substep={sub}
                  nowSec={nowSec}
                  isLast={i === step.substeps.length - 1}
                  sessionId={sessionId}
                />
              ))}
            </ul>
          )}

          {/* Running with no substeps yet */}
          {isRunning && !hasSubsteps && !isStalled && (
            <div className="px-4 py-3 text-xs text-muted italic">
              Running…
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Spine connector ──────────────────────────────────────────────────────────

function SpineConnector({ done }: { readonly done: boolean }) {
  return (
    <div className="flex justify-center py-0.5" aria-hidden="true">
      <div
        className={cn(
          "w-px h-4 transition-colors duration-700",
          done ? "bg-success/40" : "bg-border-2",
        )}
      />
    </div>
  );
}

// ─── Total elapsed + status bar ───────────────────────────────────────────────

interface SummaryBarProps {
  readonly progress: SessionProgress;
  readonly nowSec: number;
}

function SummaryBar({ progress, nowSec }: SummaryBarProps) {
  const isTerminal = TERMINAL_STATUSES.has(progress.status);
  const totalSec = isTerminal
    ? progress.totalElapsedSec
    : progress.createdAt > 0
    ? nowSec - progress.createdAt
    : progress.totalElapsedSec;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-bg-1 border border-border rounded-xl mb-3 flex-wrap">
      <Clock
        size={13}
        className="text-muted shrink-0"
        aria-hidden="true"
      />
      <span className="text-xs text-muted">Total elapsed</span>
      <span className="font-mono text-xs text-foreground tabular-nums">
        {fmtSec(Math.max(0, totalSec))}
      </span>

      {progress.stalled && (
        <span className="ml-auto text-[10px] font-bold text-warning uppercase tracking-wide bg-warning-subtle border border-warning/30 px-2 py-0.5 rounded-full">
          STALLED
        </span>
      )}

      {progress.status === "completed" && (
        <span className="ml-auto text-[10px] font-bold text-success uppercase tracking-wide bg-success-subtle border border-success/20 px-2 py-0.5 rounded-full">
          DONE
        </span>
      )}

      {progress.status === "failed" && (
        <span className="ml-auto text-[10px] font-bold text-danger uppercase tracking-wide bg-danger-subtle border border-danger/20 px-2 py-0.5 rounded-full">
          FAILED
        </span>
      )}

      {progress.status === "cancelled" && (
        <span className="ml-auto text-[10px] font-bold text-muted uppercase tracking-wide bg-bg-3 border border-border px-2 py-0.5 rounded-full">
          CANCELLED
        </span>
      )}
    </div>
  );
}

// ─── Error panel ──────────────────────────────────────────────────────────────

function ErrorPanel({ error }: { readonly error: string }) {
  return (
    <div
      role="alert"
      className="bg-danger-subtle border border-danger/20 rounded-xl px-4 py-3 mb-3"
    >
      <p className="text-xs font-semibold text-danger uppercase tracking-wide mb-1">
        Error
      </p>
      <p className="text-sm text-danger m-0 font-mono leading-relaxed">
        {error}
      </p>
    </div>
  );
}

// ─── Public component ──────────────────────────────────────────────────────────

export interface ProgressTimelineProps {
  readonly progress: SessionProgress;
  /**
   * Session ID — used to fetch per-round agent ledgers when a substep is
   * expanded. Optional for backwards-compat; without it, substeps won't
   * show the drill-down toggle.
   */
  readonly sessionId?: string;
}

export function ProgressTimeline({ progress, sessionId }: ProgressTimelineProps) {
  const isTerminal = TERMINAL_STATUSES.has(progress.status);

  // Single tick drives ALL live elapsed timers in the tree.
  // useTick increments a counter every second; we only care that it triggers a
  // re-render so Math.floor(Date.now() / 1000) returns a fresh value each tick.
  // Stops automatically once the session reaches a terminal state.
  useTick(!isTerminal);
  const currentNow = Math.floor(Date.now() / 1000);

  // Sort steps by the canonical STEP_ORDER; unknown steps go to the end
  const orderedSteps = [...progress.steps].sort((a, b) => {
    const ai = STEP_ORDER.indexOf(a.key);
    const bi = STEP_ORDER.indexOf(b.key);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  return (
    <div aria-label="Session progress timeline">
      {/* Summary bar */}
      <SummaryBar progress={progress} nowSec={currentNow} />

      {/* Session-level error (failed) */}
      {progress.error != null && progress.status === "failed" && (
        <ErrorPanel error={progress.error} />
      )}

      {/* Step spine */}
      <div>
        {orderedSteps.map((step, i) => {
          const prevStep = i > 0 ? orderedSteps[i - 1] : undefined;
          const connectorDone = prevStep?.state === "done";

          return (
            <div key={step.key}>
              {i > 0 && <SpineConnector done={connectorDone ?? false} />}
              <StepNode
                step={step}
                index={i}
                stalled={progress.stalled && step.state === "running"}
                stalledForSec={progress.stalled && step.state === "running" ? progress.stalledForSec : null}
                stalledReason={progress.stalled && step.state === "running" ? progress.stalledReason : null}
                nowSec={currentNow}
                defaultOpen={step.state === "running" || step.state === "error"}
                sessionId={sessionId}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
