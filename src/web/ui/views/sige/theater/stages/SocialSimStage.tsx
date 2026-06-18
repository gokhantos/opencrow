/**
 * SocialSimStage — visualises the social simulation result.
 *
 * Shows:
 *  - A dot grid of citizen actions, colored by actionType, with staggered
 *    CSS animation to simulate them "animating in".
 *  - An ECharts horizontal bar chart for adoption rates per idea.
 *  - An ECharts pie chart for sentiment distribution.
 *  - A compact list of remix variants.
 *
 * Null-guards all artifact access — socialResult may be null until the
 * social_simulation stage completes.
 */
import { useMemo, useRef } from "react";
import * as echarts from "echarts";
import { cn } from "../../../../lib/cn";
import { useChart } from "../../../../lib/useChart";
import type { SocialSimResult, CitizenActionType } from "../../types";
import type { StageStatus } from "../StagePanel";

// ─── Action-type color map ────────────────────────────────────────────────────

const ACTION_COLORS: Record<CitizenActionType, { dot: string; label: string; badge: string }> = {
  adopt: {
    dot: "#22c55e",
    label: "Adopt",
    badge: "bg-success-subtle text-success border border-success/20",
  },
  resist: {
    dot: "#ef4444",
    label: "Resist",
    badge: "bg-danger-subtle text-danger border border-danger/20",
  },
  remix: {
    dot: "#6366f1",
    label: "Remix",
    badge: "bg-accent-subtle text-accent border border-accent/20",
  },
  combine: {
    dot: "#a855f7",
    label: "Combine",
    badge: "bg-[#a855f718] text-[#a855f7] border border-[#a855f733]",
  },
  oppose: {
    dot: "#f97316",
    label: "Oppose",
    badge: "bg-[#f9731618] text-[#f97316] border border-[#f9731633]",
  },
  ignore: {
    dot: "#64748b",
    label: "Ignore",
    badge: "bg-bg-3 text-muted border border-border",
  },
};

const ACTION_ORDER: readonly CitizenActionType[] = [
  "adopt",
  "resist",
  "remix",
  "combine",
  "oppose",
  "ignore",
];

// ─── Citizen dot grid ──────────────────────────────────────────────────────────

const MAX_DOTS = 200;
const DOT_SIZE = 8;
const DOT_GAP = 4;

interface DotGridProps {
  readonly actions: readonly { readonly actionType: CitizenActionType }[];
}

function DotGrid({ actions }: DotGridProps) {
  const dots = actions.slice(0, MAX_DOTS);

  return (
    <div
      className="flex flex-wrap"
      style={{ gap: `${DOT_GAP}px` }}
      aria-label={`${dots.length} citizen actions`}
    >
      {dots.map((a, i) => {
        const meta = ACTION_COLORS[a.actionType];
        const color = meta?.dot ?? "#64748b";
        // Stagger delay in 20ms increments, wrapping at 40 steps
        const delayMs = (i % 40) * 20;
        return (
          <div
            key={i}
            title={meta?.label ?? a.actionType}
            className="rounded-full opacity-0 animate-[fadeIn_0.3s_ease-out_forwards]"
            style={{
              width: DOT_SIZE,
              height: DOT_SIZE,
              background: color,
              animationDelay: `${delayMs}ms`,
            }}
          />
        );
      })}
    </div>
  );
}

// ─── Legend ────────────────────────────────────────────────────────────────────

interface LegendProps {
  readonly counts: Partial<Record<CitizenActionType, number>>;
}

function Legend({ counts }: LegendProps) {
  const entries = ACTION_ORDER.filter((type) => (counts[type] ?? 0) > 0);
  if (entries.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mt-3">
      {entries.map((type) => {
        const meta = ACTION_COLORS[type];
        const count = counts[type] ?? 0;
        return (
          <span
            key={type}
            className={cn(
              "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs",
              meta?.badge ?? "bg-bg-3 text-muted border border-border",
            )}
          >
            <span
              className="w-1.5 h-1.5 rounded-full inline-block"
              style={{ background: meta?.dot ?? "#64748b" }}
            />
            {meta?.label ?? type} {count}
          </span>
        );
      })}
    </div>
  );
}

// ─── Adoption rate bar chart ───────────────────────────────────────────────────

const MAX_ADOPTION_BARS = 15;

interface AdoptionChartProps {
  readonly adoptionRates: Readonly<Record<string, number>>;
}

function AdoptionChart({ adoptionRates }: AdoptionChartProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  const entries = useMemo(
    () =>
      Object.entries(adoptionRates)
        .sort(([, a], [, b]) => b - a)
        .slice(0, MAX_ADOPTION_BARS),
    [adoptionRates],
  );

  const option = useMemo<echarts.EChartsOption>(
    () => ({
      tooltip: {
        trigger: "axis" as const,
        formatter: (params: unknown) => {
          const ps = params as Array<{ name: string; value: number }>;
          const p = ps[0];
          if (!p) return "";
          return `${p.name}<br/>Adoption: ${(p.value * 100).toFixed(1)}%`;
        },
        backgroundColor: "#0f172a",
        borderColor: "#1e293b",
        textStyle: { color: "#e2e8f0", fontSize: 11 },
      },
      grid: { left: 80, right: 20, top: 8, bottom: 8, containLabel: false },
      xAxis: {
        type: "value" as const,
        min: 0,
        max: 1,
        axisLabel: {
          color: "#64748b",
          fontSize: 10,
          formatter: (v: number) => `${(v * 100).toFixed(0)}%`,
        },
        splitLine: { lineStyle: { color: "#1e293b" } },
      },
      yAxis: {
        type: "category" as const,
        data: entries.map(([id]) => id.slice(0, 8)),
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
          type: "bar" as const,
          data: entries.map(([, rate]) => rate),
          itemStyle: {
            color: "#22c55e",
            borderRadius: [0, 3, 3, 0] as [number, number, number, number],
          },
          barMaxWidth: 20,
        },
      ],
    }),
    [entries],
  );

  useChart(ref, option);

  if (entries.length === 0) return null;

  const height = Math.max(100, entries.length * 26 + 16);

  return (
    <div>
      <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
        Adoption Rates
      </p>
      <div ref={ref} style={{ height }} />
    </div>
  );
}

// ─── Sentiment distribution pie ───────────────────────────────────────────────

const SENTIMENT_COLORS = [
  "#22c55e", "#6366f1", "#f59e0b", "#f97316", "#ef4444", "#64748b",
];

interface SentimentChartProps {
  readonly sentimentDistribution: Readonly<Record<string, number>>;
}

function SentimentChart({ sentimentDistribution }: SentimentChartProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  const pieData = useMemo(
    () =>
      Object.entries(sentimentDistribution).map(([name, value], i) => ({
        name,
        value,
        itemStyle: { color: SENTIMENT_COLORS[i % SENTIMENT_COLORS.length] ?? "#64748b" },
      })),
    [sentimentDistribution],
  );

  const option = useMemo<echarts.EChartsOption>(
    () => ({
      tooltip: {
        trigger: "item" as const,
        formatter: "{b}: {d}%",
        backgroundColor: "#0f172a",
        borderColor: "#1e293b",
        textStyle: { color: "#e2e8f0", fontSize: 11 },
      },
      legend: {
        orient: "vertical" as const,
        right: 0,
        top: "center",
        textStyle: { color: "#94a3b8", fontSize: 10 },
        icon: "circle",
        itemWidth: 8,
        itemHeight: 8,
      },
      series: [
        {
          type: "pie" as const,
          radius: ["40%", "72%"],
          center: ["38%", "50%"],
          avoidLabelOverlap: false,
          label: { show: false },
          data: pieData,
        },
      ],
    }),
    [pieData],
  );

  useChart(ref, option);

  if (pieData.length === 0) return null;

  return (
    <div>
      <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
        Sentiment Distribution
      </p>
      <div ref={ref} style={{ height: 160 }} />
    </div>
  );
}

// ─── Remix variants list ──────────────────────────────────────────────────────

const MAX_REMIXES = 10;

interface RemixListProps {
  readonly variants: SocialSimResult["remixVariants"];
}

function RemixList({ variants }: RemixListProps) {
  const shown = variants.slice(0, MAX_REMIXES);
  if (shown.length === 0) return null;

  return (
    <div>
      <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
        Remix Variants
      </p>
      <div className="space-y-2">
        {shown.map((v, i) => (
          <div
            key={i}
            className="bg-bg border border-border rounded-lg px-3 py-2"
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-mono text-faint">
                {v.originalIdeaId.slice(0, 8)}
              </span>
              <span className="text-[10px] text-faint">→</span>
              <span className="text-[10px] font-mono text-faint">
                {v.citizenId.slice(0, 8)}
              </span>
              <span className="ml-auto text-[10px] font-mono text-success">
                {(v.adoptionRate * 100).toFixed(0)}% adopted
              </span>
            </div>
            <p className="text-xs text-muted m-0 line-clamp-2 leading-snug">
              {v.remixedContent}
            </p>
          </div>
        ))}
        {variants.length > MAX_REMIXES && (
          <p className="text-xs text-faint italic">
            +{variants.length - MAX_REMIXES} more variants…
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Public component ──────────────────────────────────────────────────────────

export interface SocialSimStageProps {
  readonly socialResult: SocialSimResult | undefined | null;
  readonly status: StageStatus;
}

export function SocialSimStage({ socialResult, status }: SocialSimStageProps) {
  // Empty / loading states
  if (!socialResult && status === "running") {
    return (
      <div className="px-5 py-6 text-sm text-muted italic">
        Social simulation in progress…
      </div>
    );
  }

  if (!socialResult) {
    return (
      <div className="px-5 py-6 text-sm text-muted italic">
        No social simulation data available.
      </div>
    );
  }

  const actions = socialResult.citizenActions ?? [];
  const adoptionRates = socialResult.adoptionRates ?? {};
  const sentimentDistribution = socialResult.sentimentDistribution ?? {};
  const remixVariants = socialResult.remixVariants ?? [];

  // Count per action type for the legend
  const counts: Partial<Record<CitizenActionType, number>> = {};
  for (const a of actions) {
    counts[a.actionType] = (counts[a.actionType] ?? 0) + 1;
  }

  const hasAdoption = Object.keys(adoptionRates).length > 0;
  const hasSentiment = Object.keys(sentimentDistribution).length > 0;

  return (
    <div className="px-5 py-5 space-y-5">
      {/* Citizen dot grid */}
      {actions.length > 0 ? (
        <div>
          <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
            Citizen Actions ({actions.length} total)
          </p>
          <DotGrid actions={actions} />
          <Legend counts={counts} />
        </div>
      ) : (
        <p className="text-sm text-muted italic">No citizen actions recorded.</p>
      )}

      {/* Charts side by side if both present */}
      {(hasAdoption || hasSentiment) && (
        <div
          className={cn(
            "grid gap-5",
            hasAdoption && hasSentiment ? "grid-cols-1 lg:grid-cols-2" : "grid-cols-1",
          )}
        >
          {hasAdoption && <AdoptionChart adoptionRates={adoptionRates} />}
          {hasSentiment && <SentimentChart sentimentDistribution={sentimentDistribution} />}
        </div>
      )}

      {/* Remix variants */}
      <RemixList variants={remixVariants} />
    </div>
  );
}
