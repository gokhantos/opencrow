/**
 * ExpertGameStage — client-side replay of the 4 expert-game rounds.
 *
 * Renders a play/scrubber control. For each round frame: idea cards appear,
 * eliminated ideas fade out, selected ideas are highlighted, coalitions are
 * grouped. Equilibria are shown as badges (type + stability). MetaGameHealth
 * is visualised via small ECharts gauges.
 *
 * Null-guards all artifact access — expertResult or its rounds may be
 * null/empty, and individual idea fields are optional.
 */
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Play, Pause, SkipBack, SkipForward } from "lucide-react";
import * as echarts from "echarts";
import { cn } from "../../../../lib/cn";
import { useChart } from "../../../../lib/useChart";
import type {
  ExpertGameResult,
  ScoredIdea,
  Coalition,
  MetaGameHealth,
} from "../../types";
import type { StageStatus } from "../StagePanel";
import { expertResultToFrames } from "../transforms";

// ─── Equilibrium badge ─────────────────────────────────────────────────────────

const EQUILIBRIUM_BADGE: Record<string, string> = {
  nash: "bg-accent-subtle text-accent border border-accent/20",
  pareto: "bg-success-subtle text-success border border-success/20",
  dominant: "bg-warning-subtle text-warning border border-warning/20",
  evolutionary_stable: "bg-[#7928ca18] text-[#7928ca] border border-[#7928ca33]",
  signaling_separating: "bg-bg-3 text-muted border border-border",
  signaling_pooling: "bg-bg-3 text-muted border border-border",
};

function equilibriumBadgeClass(type: string): string {
  return EQUILIBRIUM_BADGE[type] ?? "bg-bg-3 text-muted border border-border";
}

// ─── Idea card ────────────────────────────────────────────────────────────────

interface IdeaCardProps {
  readonly idea: ScoredIdea;
  readonly isSelected: boolean;
  readonly isEliminated: boolean;
}

function IdeaCard({ idea, isSelected, isEliminated }: IdeaCardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2.5 transition-all duration-500",
        isEliminated
          ? "opacity-30 border-border bg-bg scale-95"
          : isSelected
          ? "border-accent/60 bg-accent-subtle/30 shadow-[0_0_0_1.5px_var(--color-accent,#6366f1)33]"
          : "border-border bg-bg",
      )}
      title={idea.description ?? idea.title}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <span className="text-xs font-semibold text-strong leading-tight line-clamp-2">
          {idea.title || idea.id.slice(0, 8)}
        </span>
        {isSelected && (
          <span className="shrink-0 text-[10px] font-bold text-accent bg-accent-subtle px-1.5 py-0.5 rounded-full leading-none">
            ✓
          </span>
        )}
        {isEliminated && (
          <span className="shrink-0 text-[10px] font-bold text-danger bg-danger-subtle px-1.5 py-0.5 rounded-full leading-none">
            ✕
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 mt-1.5">
        <span className="text-[10px] font-mono text-faint">{idea.id.slice(0, 8)}</span>
        <span className="text-[10px] text-muted font-mono">
          E {idea.expertScore.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

// ─── Coalition group ───────────────────────────────────────────────────────────

interface CoalitionGroupProps {
  readonly coalition: Coalition;
  readonly index: number;
}

function CoalitionGroup({ coalition, index }: CoalitionGroupProps) {
  return (
    <div className="bg-bg-1 border border-border rounded-lg px-3 py-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-semibold text-muted uppercase tracking-wide">
          Coalition {index + 1}
        </span>
        <span className="text-[10px] font-mono text-faint">
          stab {(coalition.stability * 100).toFixed(0)}%
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {coalition.members.map((m, i) => (
          <span
            key={i}
            className="text-[10px] font-mono bg-bg-2 border border-border text-faint px-1.5 py-0.5 rounded"
          >
            {m.slice(0, 8)}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── MetaGameHealth gauges ─────────────────────────────────────────────────────

interface MetaHealthGaugeProps {
  readonly label: string;
  readonly value: number;
  readonly color: string;
}

function MetaHealthGauge({ label, value, color }: MetaHealthGaugeProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const option = useMemo<echarts.EChartsOption>(
    () => ({
      series: [
        {
          type: "gauge" as const,
          radius: "90%",
          startAngle: 200,
          endAngle: -20,
          min: 0,
          max: 1,
          splitNumber: 4,
          itemStyle: { color },
          progress: { show: true, width: 6 },
          pointer: { show: false },
          axisLine: {
            lineStyle: {
              width: 6,
              color: [[1, "#1e293b"]] as [number, string][],
            },
          },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: { show: false },
          detail: {
            valueAnimation: true,
            formatter: (v: number) => `${(v * 100).toFixed(0)}%`,
            color: "#94a3b8",
            fontSize: 10,
            offsetCenter: [0, "60%"],
          },
          data: [{ value: Math.max(0, Math.min(1, value)) }],
        },
      ],
    }),
    [value, color],
  );

  useChart(ref, option);

  return (
    <div className="flex flex-col items-center">
      <div ref={ref} className="w-20 h-16" />
      <span className="text-[10px] text-faint text-center leading-tight mt-0.5">
        {label}
      </span>
    </div>
  );
}

// ─── AgentBalance mini-bar ─────────────────────────────────────────────────────

function AgentBalanceBar({ scores }: { readonly scores: Readonly<Record<string, number>> }) {
  const entries = Object.entries(scores).slice(0, 8);
  if (entries.length === 0) return null;

  return (
    <div className="space-y-1">
      {entries.map(([role, score]) => (
        <div key={role} className="flex items-center gap-2">
          <span className="text-[10px] text-faint w-28 truncate capitalize">
            {role.replace(/_/g, " ")}
          </span>
          <div className="flex-1 h-1.5 bg-bg-3 rounded-full overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all duration-500"
              style={{ width: `${Math.min(100, Math.max(0, score * 100))}%` }}
            />
          </div>
          <span className="text-[10px] font-mono text-muted w-8 text-right">
            {score.toFixed(2)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── MetaGameHealthPanel ──────────────────────────────────────────────────────

function MetaGameHealthPanel({ health }: { readonly health: MetaGameHealth }) {
  return (
    <div className="bg-bg-1 border border-border rounded-lg px-4 py-3 mt-4">
      <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-3">
        Meta-Game Health
      </p>
      <div className="flex items-start gap-6 flex-wrap">
        <div className="flex gap-4">
          <MetaHealthGauge
            label="Diversity"
            value={health.diversityIndex}
            color="#6366f1"
          />
          <MetaHealthGauge
            label="Convergence"
            value={health.convergenceRate}
            color="#22c55e"
          />
          <MetaHealthGauge
            label="Novelty"
            value={health.noveltyScore}
            color="#f59e0b"
          />
        </div>

        {health.agentBalanceScores &&
          Object.keys(health.agentBalanceScores).length > 0 && (
            <div className="flex-1 min-w-48">
              <p className="text-[10px] font-semibold text-faint uppercase tracking-wide mb-2">
                Agent Balance
              </p>
              <AgentBalanceBar scores={health.agentBalanceScores} />
            </div>
          )}
      </div>
    </div>
  );
}

// ─── Round type label ──────────────────────────────────────────────────────────

const ROUND_TYPE_LABELS: Record<string, string> = {
  divergent_generation: "Divergent Generation",
  strategic_interaction: "Strategic Interaction",
  evolutionary_tournament: "Evolutionary Tournament",
  equilibrium_analysis: "Equilibrium Analysis",
};

// ─── Scrubber + controls ──────────────────────────────────────────────────────

interface ScrubberProps {
  readonly frameIndex: number;
  readonly total: number;
  readonly playing: boolean;
  readonly onPlay: () => void;
  readonly onPause: () => void;
  readonly onSeek: (i: number) => void;
}

function Scrubber({ frameIndex, total, playing, onPlay, onPause, onSeek }: ScrubberProps) {
  return (
    <div className="flex items-center gap-3 bg-bg-2 border border-border rounded-lg px-4 py-2.5">
      {/* Back to first */}
      <button
        type="button"
        onClick={() => onSeek(0)}
        disabled={frameIndex === 0}
        className="text-muted hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors bg-transparent border-none p-0 cursor-pointer"
        aria-label="First round"
      >
        <SkipBack size={14} />
      </button>

      {/* Play / Pause */}
      <button
        type="button"
        onClick={playing ? onPause : onPlay}
        className="text-accent hover:text-accent/80 transition-colors bg-transparent border-none p-0 cursor-pointer"
        aria-label={playing ? "Pause replay" : "Play replay"}
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>

      {/* Advance one */}
      <button
        type="button"
        onClick={() => onSeek(Math.min(total - 1, frameIndex + 1))}
        disabled={frameIndex >= total - 1}
        className="text-muted hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors bg-transparent border-none p-0 cursor-pointer"
        aria-label="Next round"
      >
        <SkipForward size={14} />
      </button>

      {/* Step dots */}
      <div className="flex items-center gap-1.5 ml-1">
        {Array.from({ length: total }, (_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onSeek(i)}
            className={cn(
              "rounded-full transition-all cursor-pointer border-none bg-transparent p-0",
              i === frameIndex
                ? "w-4 h-2.5 bg-accent"
                : "w-2 h-2 bg-border-2 hover:bg-accent/50",
            )}
            aria-label={`Round ${i + 1}`}
          />
        ))}
      </div>

      <span className="ml-auto text-xs font-mono text-muted whitespace-nowrap">
        Round {frameIndex + 1} / {total}
      </span>
    </div>
  );
}

// ─── Public component ──────────────────────────────────────────────────────────

export interface ExpertGameStageProps {
  readonly expertResult: ExpertGameResult | undefined | null;
  readonly status: StageStatus;
}

const AUTO_PLAY_MS = 2500;
const MAX_RENDERED_IDEAS = 50;

export function ExpertGameStage({ expertResult, status }: ExpertGameStageProps) {
  const frames = useMemo(() => expertResultToFrames(expertResult), [expertResult]);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const advance = useCallback(() => {
    setFrameIndex((i) => {
      if (i >= frames.length - 1) {
        setPlaying(false);
        return i;
      }
      return i + 1;
    });
  }, [frames.length]);

  // Auto-play logic
  useEffect(() => {
    if (!playing) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    timerRef.current = setTimeout(advance, AUTO_PLAY_MS);
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [playing, frameIndex, advance]);

  // Reset when expertResult changes
  useEffect(() => {
    setFrameIndex(0);
    setPlaying(false);
  }, [expertResult]);

  // ── Empty / loading states ─────────────────────────────────────────────────

  if (!expertResult && status === "running") {
    return (
      <div className="px-5 py-6 text-sm text-muted italic">
        Expert game in progress…
      </div>
    );
  }

  if (!expertResult || frames.length === 0) {
    return (
      <div className="px-5 py-6 text-sm text-muted italic">
        No expert game data available.
      </div>
    );
  }

  const frame = frames[frameIndex];
  if (!frame) {
    return (
      <div className="px-5 py-6 text-sm text-muted italic">
        Round data unavailable.
      </div>
    );
  }

  // Cap rendered ideas for performance
  const allIdeas = frame.selectedIdeas.slice(0, MAX_RENDERED_IDEAS);
  // Collect eliminated IDs not already in selected (we show them ghosted)
  const eliminatedIdeas = [...frame.eliminatedIdeaIds]
    .filter((id) => !frame.selectedIdeaIds.has(id))
    .slice(0, Math.max(0, MAX_RENDERED_IDEAS - allIdeas.length));

  // Construct ghost cards for eliminated ideas that weren't in selectedIdeas
  const eliminatedCards = eliminatedIdeas.map(
    (id): ScoredIdea => ({
      id,
      title: id.slice(0, 8),
      description: "",
      proposedBy: "",
      round: frame.roundNumber,
      expertScore: 0,
      incentiveBreakdown: {
        diversityBonus: 0,
        buildingBonus: 0,
        surpriseBonus: 0,
        accuracyPenalty: 0,
        memoryReward: 0,
        coalitionStability: 0,
        signalCredibility: 0,
        socialViability: 0,
      },
    }),
  );

  const roundTypeLabel =
    ROUND_TYPE_LABELS[frame.roundType] ??
    frame.roundType.replace(/_/g, " ");

  return (
    <div className="px-5 py-5 space-y-4">
      {/* Controls */}
      <Scrubber
        frameIndex={frameIndex}
        total={frames.length}
        playing={playing}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onSeek={(i) => {
          setFrameIndex(i);
          setPlaying(false);
        }}
      />

      {/* Round type heading */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-semibold text-strong">
          Round {frame.roundNumber}
        </span>
        <span className="text-xs bg-bg-3 border border-border text-muted px-2.5 py-0.5 rounded-full capitalize">
          {roundTypeLabel}
        </span>
      </div>

      {/* Idea grid */}
      {(allIdeas.length > 0 || eliminatedCards.length > 0) && (
        <div>
          <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
            Ideas ({allIdeas.length + eliminatedCards.length})
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {allIdeas.map((idea) => (
              <IdeaCard
                key={idea.id}
                idea={idea}
                isSelected={frame.selectedIdeaIds.has(idea.id)}
                isEliminated={frame.eliminatedIdeaIds.has(idea.id)}
              />
            ))}
            {eliminatedCards.map((ghost) => (
              <IdeaCard
                key={ghost.id}
                idea={ghost}
                isSelected={false}
                isEliminated={true}
              />
            ))}
          </div>
        </div>
      )}

      {/* Equilibria badges */}
      {frame.equilibria.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
            Equilibria
          </p>
          <div className="space-y-2">
            {frame.equilibria.map((eq, i) => (
              <div key={i} className="flex items-start gap-3 flex-wrap">
                <span
                  className={cn(
                    "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize whitespace-nowrap",
                    equilibriumBadgeClass(eq.type),
                  )}
                >
                  {eq.type.replace(/_/g, " ")}
                </span>
                <span className="text-xs font-mono text-muted">
                  {(eq.stability * 100).toFixed(0)}% stable
                </span>
                {eq.description && (
                  <span className="text-xs text-faint leading-tight flex-1">
                    {eq.description}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Coalitions */}
      {frame.coalitions.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
            Coalitions
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {frame.coalitions.map((c, i) => (
              <CoalitionGroup key={c.id} coalition={c} index={i} />
            ))}
          </div>
        </div>
      )}

      {/* MetaGameHealth — always from the result, not per-frame */}
      <MetaGameHealthPanel health={expertResult.metaGameHealth} />
    </div>
  );
}
