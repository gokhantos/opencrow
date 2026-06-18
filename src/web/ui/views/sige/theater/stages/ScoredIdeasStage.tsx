/**
 * ScoredIdeasStage — ranked idea list with expert-vs-social diverging bars
 * and an expandable incentive breakdown on each row.
 *
 * Reuses the ScoreBar / breakdown-entries pattern from IdeasTab.tsx but adds
 * an ECharts diverging bar overview chart at the top.
 *
 * Data source: fusedScores passed from ProcessTheater (already fetched as part
 * of the session object). Falls back to null empty state gracefully.
 *
 * Null-guards all accesses — fusedScores may be undefined/null until the
 * scoring stage completes.
 */
import { useState, useRef, useMemo } from "react";
import * as echarts from "echarts";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "../../../../lib/cn";
import { useChart } from "../../../../lib/useChart";
import type { FusedScore } from "../../types";
import type { StageStatus } from "../StagePanel";

// ─── IncentiveBreakdown entries ───────────────────────────────────────────────

interface BreakdownEntry {
  readonly label: string;
  readonly value: number;
  readonly positive: boolean;
}

function breakdownEntries(bd: FusedScore["breakdown"]): readonly BreakdownEntry[] {
  return [
    { label: "Diversity bonus", value: bd.diversityBonus, positive: true },
    { label: "Building bonus", value: bd.buildingBonus, positive: true },
    { label: "Surprise bonus", value: bd.surpriseBonus, positive: true },
    { label: "Memory reward", value: bd.memoryReward, positive: true },
    { label: "Coalition stability", value: bd.coalitionStability, positive: true },
    { label: "Signal credibility", value: bd.signalCredibility, positive: true },
    { label: "Social viability", value: bd.socialViability, positive: true },
    { label: "Accuracy penalty", value: bd.accuracyPenalty, positive: false },
  ];
}

// ─── Score bar ────────────────────────────────────────────────────────────────

interface ScoreBarProps {
  readonly expertScore: number;
  readonly socialScore: number;
  readonly fusedScore: number;
}

function ScoreBar({ expertScore, socialScore, fusedScore }: ScoreBarProps) {
  const expertPct = Math.round(Math.min(Math.max(expertScore, 0), 1) * 100);
  const socialPct = Math.round(Math.min(Math.max(socialScore, 0), 1) * 100);

  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 flex gap-0.5 h-2 rounded-full overflow-hidden bg-bg-2">
        <div
          className="bg-accent rounded-l-full transition-all"
          style={{ width: `${expertPct}%` }}
          title={`Expert: ${expertPct}%`}
        />
        <div
          className="bg-warning rounded-r-full transition-all"
          style={{ width: `${socialPct}%` }}
          title={`Social: ${socialPct}%`}
        />
      </div>
      <span className="text-xs font-mono font-semibold text-strong whitespace-nowrap">
        {fusedScore.toFixed(3)}
      </span>
    </div>
  );
}

// ─── Idea row ─────────────────────────────────────────────────────────────────

interface IdeaRowProps {
  readonly idea: FusedScore;
  readonly rank: number;
}

function IdeaRow({ idea, rank }: IdeaRowProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={cn(
        "border-b border-border last:border-b-0 transition-colors",
        rank === 1 && "bg-accent-subtle/40",
      )}
    >
      {/* Main row */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-5 py-3.5 flex items-center gap-4 bg-transparent border-none cursor-pointer hover:bg-bg-2 transition-colors"
        aria-expanded={expanded}
        aria-label={`Idea ${rank}: ${idea.ideaId.slice(0, 8)} — expand for breakdown`}
      >
        {/* Rank bubble */}
        <span
          className={cn(
            "w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0",
            rank === 1
              ? "bg-accent text-white"
              : rank === 2
              ? "bg-accent/60 text-white"
              : rank === 3
              ? "bg-accent/30 text-accent"
              : "bg-bg-2 text-muted",
          )}
        >
          {rank}
        </span>

        {/* ID (truncated) */}
        <span className="text-xs font-mono text-muted w-20 truncate shrink-0">
          {idea.ideaId.slice(0, 8)}
        </span>

        {/* Diverging score bar */}
        <div className="flex-1 min-w-0">
          <ScoreBar
            expertScore={idea.expertScore}
            socialScore={idea.socialScore}
            fusedScore={idea.fusedScore}
          />
        </div>

        {/* E / S labels */}
        <div className="hidden sm:flex items-center gap-3 shrink-0 text-xs text-muted font-mono">
          <span className="text-accent">{idea.expertScore.toFixed(3)} E</span>
          <span className="text-warning">{idea.socialScore.toFixed(3)} S</span>
        </div>

        {/* Expand toggle */}
        <span className="text-faint shrink-0">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {/* Expanded: incentive breakdown */}
      {expanded && (
        <div className="px-5 pb-4 pt-1 bg-bg border-t border-border/50">
          <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-3">
            Incentive Breakdown
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {breakdownEntries(idea.breakdown).map(({ label, value, positive }) => (
              <div
                key={label}
                className="bg-bg-1 border border-border rounded-lg px-3 py-2"
              >
                <div className="text-xs text-faint mb-0.5">{label}</div>
                <div
                  className={cn(
                    "text-sm font-semibold font-mono",
                    positive ? "text-success" : "text-danger",
                  )}
                >
                  {positive ? "+" : "−"}
                  {Math.abs(value).toFixed(3)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Overview diverging bar chart ─────────────────────────────────────────────

const CHART_TOP_N = 20;

interface OverviewChartProps {
  readonly scores: readonly FusedScore[];
}

function OverviewChart({ scores }: OverviewChartProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  const top = useMemo(
    () =>
      [...scores]
        .sort((a, b) => b.fusedScore - a.fusedScore)
        .slice(0, CHART_TOP_N),
    [scores],
  );

  const option = useMemo<echarts.EChartsOption>(
    () => ({
      tooltip: {
        trigger: "axis" as const,
        axisPointer: { type: "shadow" as const },
        backgroundColor: "#0f172a",
        borderColor: "#1e293b",
        textStyle: { color: "#e2e8f0", fontSize: 11 },
        formatter: (params: unknown) => {
          const ps = params as Array<{ seriesName: string; value: number; name: string }>;
          if (!ps[0]) return "";
          const name = ps[0].name;
          const lines = ps
            .map((p) => `${p.seriesName}: ${p.value.toFixed(3)}`)
            .join("<br/>");
          return `${name}<br/>${lines}`;
        },
      },
      legend: {
        data: ["Expert", "Social"],
        textStyle: { color: "#94a3b8", fontSize: 10 },
        right: 0,
        top: 0,
      },
      grid: { left: 60, right: 80, top: 28, bottom: 8, containLabel: false },
      xAxis: {
        type: "value" as const,
        min: 0,
        max: 1,
        axisLabel: {
          color: "#64748b",
          fontSize: 10,
          formatter: (v: number) => v.toFixed(1),
        },
        splitLine: { lineStyle: { color: "#1e293b" } },
      },
      yAxis: {
        type: "category" as const,
        data: top.map((s) => s.ideaId.slice(0, 8)),
        axisLabel: {
          color: "#94a3b8",
          fontSize: 10,
          fontFamily: "JetBrains Mono, monospace",
        },
        axisTick: { show: false },
        axisLine: { show: false },
      },
      series: [
        {
          name: "Expert",
          type: "bar" as const,
          data: top.map((s) => s.expertScore),
          itemStyle: {
            color: "#6366f1",
            borderRadius: [0, 3, 3, 0] as [number, number, number, number],
          },
          barMaxWidth: 14,
          barGap: "20%",
        },
        {
          name: "Social",
          type: "bar" as const,
          data: top.map((s) => s.socialScore),
          itemStyle: {
            color: "#f59e0b",
            borderRadius: [0, 3, 3, 0] as [number, number, number, number],
          },
          barMaxWidth: 14,
        },
      ],
    }),
    [top],
  );

  useChart(ref, option);

  if (top.length === 0) return null;

  const height = Math.max(120, top.length * 30 + 36);

  return (
    <div className="bg-bg-1 border border-border rounded-lg p-4">
      <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-3">
        Expert vs Social Score (top {top.length})
      </p>
      <div ref={ref} style={{ height }} />
    </div>
  );
}

// ─── Public component ──────────────────────────────────────────────────────────

export interface ScoredIdeasStageProps {
  readonly fusedScores: readonly FusedScore[] | undefined | null;
  readonly status: StageStatus;
}

export function ScoredIdeasStage({ fusedScores, status }: ScoredIdeasStageProps) {
  // Sort once — highest fused score first
  const sorted = useMemo(() => {
    if (!fusedScores || fusedScores.length === 0) return [];
    return [...fusedScores].sort((a, b) => b.fusedScore - a.fusedScore);
  }, [fusedScores]);

  // Empty / loading states
  if (!fusedScores && status === "running") {
    return (
      <div className="px-5 py-6 text-sm text-muted italic">
        Scoring ideas…
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <div className="px-5 py-6 text-sm text-muted italic">
        No scored ideas available.
      </div>
    );
  }

  return (
    <div className="px-5 py-5 space-y-5">
      {/* Overview chart */}
      <OverviewChart scores={sorted} />

      {/* Ranked rows */}
      <div className="bg-bg-1 border border-border rounded-xl overflow-hidden">
        {/* Column header */}
        <div className="px-5 py-3 border-b border-border flex items-center gap-4 text-xs font-semibold text-muted uppercase tracking-wide">
          <span className="w-6 shrink-0">#</span>
          <span className="w-20 shrink-0">ID</span>
          <span className="flex-1">Score (Expert / Social)</span>
          <span className="hidden sm:block w-28 text-right shrink-0">E / S</span>
          <span className="w-4 shrink-0" />
        </div>

        {/* Idea rows */}
        {sorted.map((idea, idx) => (
          <IdeaRow key={idea.ideaId} idea={idea} rank={idx + 1} />
        ))}

        {/* Legend footer */}
        <div className="px-5 py-3 border-t border-border flex items-center gap-4 text-xs text-faint">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-1.5 rounded-full bg-accent inline-block" />
            Expert
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-1.5 rounded-full bg-warning inline-block" />
            Social
          </span>
          <span className="ml-auto font-mono">
            {sorted.length} idea{sorted.length !== 1 ? "s" : ""} scored
          </span>
        </div>
      </div>
    </div>
  );
}
