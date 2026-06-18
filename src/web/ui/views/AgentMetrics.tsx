import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../api";
import {
  PageHeader,
  LoadingState,
  EmptyState,
  FilterTabs,
} from "../components";
import {
  formatNumber,
  relativeTime,
  formatTime,
  formatCost,
  formatDuration,
} from "../lib/format";
import { cn } from "../lib/cn";
import {
  type AgentUsage,
  type ModelUsage,
  type TimePoint,
  type RecentRecord,
  type CronJob,
  RANGES,
  sinceEpoch,
} from "./agent-metrics/types";
import {
  CostTimelineChart,
  CostByAgentChart,
  CostByModelChart,
  TokenDistributionChart,
  ActivityTimelineChart,
} from "./agent-metrics/charts";
import { ChartCard, StatCard, CacheBar, TH } from "./agent-metrics/primitives";

// ============================================================================
// Main Component
// ============================================================================

export default function AgentMetrics() {
  const [range, setRange] = useState("7d");
  const [selectedAgent, setSelectedAgent] = useState("all");
  const [byAgent, setByAgent] = useState<AgentUsage[]>([]);
  const [byModel, setByModel] = useState<ModelUsage[]>([]);
  const [timeseries, setTimeseries] = useState<TimePoint[]>([]);
  const [recent, setRecent] = useState<RecentRecord[]>([]);
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (signal: AbortSignal) => {
    const since = sinceEpoch(range);
    const qs = since ? `?since=${since}` : "";
    const granularity = range === "24h" ? "hour" : "day";
    const tsQs = since
      ? `?since=${since}&granularity=${granularity}`
      : `?granularity=${granularity}`;

    try {
      const [agentRes, modelRes, tsRes, recentRes, cronRes] =
        await Promise.all([
          apiFetch<{ success: boolean; data: AgentUsage[] }>(
            `/api/usage/by-agent${qs}`,
            { signal },
          ),
          apiFetch<{ success: boolean; data: ModelUsage[] }>(
            `/api/usage/by-model${qs}`,
            { signal },
          ),
          apiFetch<{ success: boolean; data: TimePoint[] }>(
            `/api/usage/timeseries${tsQs}`,
            { signal },
          ),
          apiFetch<{ success: boolean; data: RecentRecord[] }>(
            `/api/usage/recent?limit=200${since ? `&since=${since}` : ""}`,
            { signal },
          ),
          apiFetch<{ success: boolean; data: CronJob[] }>("/api/cron/jobs", { signal }),
        ]);

      if (signal.aborted) return;
      if (agentRes.success) setByAgent(agentRes.data);
      if (modelRes.success) setByModel(modelRes.data);
      if (tsRes.success) setTimeseries(tsRes.data);
      if (recentRes.success) setRecent(recentRes.data);
      if (cronRes.success) setCronJobs(cronRes.data);
      setError(null);
    } catch (_err) {
      if (signal.aborted) return;
      setError("Failed to load metrics. Will retry.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    setLoading(true);
    const controller = new AbortController();
    void fetchData(controller.signal);
    const interval = setInterval(() => void fetchData(controller.signal), 30_000);
    return () => {
      clearInterval(interval);
      controller.abort();
    };
  }, [fetchData]);

  if (loading && byAgent.length === 0)
    return <LoadingState message="Loading metrics..." />;

  if (error && byAgent.length === 0)
    return <EmptyState description={error} />;

  // ---------- Derived data ----------

  const agentIds = byAgent.map((a) => a.agentId);
  const isAllAgents = selectedAgent === "all";

  const selected = isAllAgents
    ? null
    : (byAgent.find((a) => a.agentId === selectedAgent) ?? null);

  const filteredRecent = isAllAgents
    ? recent
    : recent.filter((r) => r.agentId === selectedAgent);

  const agentCronJobs = isAllAgents
    ? cronJobs.filter((j) => j.payload.agentId)
    : cronJobs.filter((j) => j.payload.agentId === selectedAgent);

  const sum = (fn: (a: AgentUsage) => number) =>
    byAgent.reduce((s, a) => s + fn(a), 0);

  const totalReqs = selected?.requestCount ?? sum((a) => a.requestCount);
  const totalCost = selected?.totalCostUsd ?? sum((a) => a.totalCostUsd);
  const totalInput =
    selected?.totalInputTokens ?? sum((a) => a.totalInputTokens);
  const totalOutput =
    selected?.totalOutputTokens ?? sum((a) => a.totalOutputTokens);
  const totalCacheRead =
    selected?.totalCacheReadTokens ?? sum((a) => a.totalCacheReadTokens);
  const totalCacheCreation =
    selected?.totalCacheCreationTokens ??
    sum((a) => a.totalCacheCreationTokens);
  const costPerReq = totalReqs > 0 ? totalCost / totalReqs : 0;
  const cacheHitPct =
    totalInput > 0 ? Math.round((totalCacheRead / totalInput) * 100) : 0;

  const relevantRecent = filteredRecent.filter((r) => r.durationMs > 0);
  const avgDuration =
    relevantRecent.length > 0
      ? Math.round(
          relevantRecent.reduce((s, r) => s + r.durationMs, 0) /
            relevantRecent.length,
        )
      : 0;

  // ---------- Render ----------

  return (
    <div className="max-w-[1400px]">
      <PageHeader
        title="Agent Metrics"
        subtitle="Performance, cost, and usage analysis"
      />

      <FilterTabs
        tabs={RANGES.map((r) => ({ id: r.id, label: r.label }))}
        active={range}
        onChange={setRange}
      />

      {/* Agent selector */}
      <div className="flex flex-wrap gap-1.5 mb-6">
        {[
          { id: "all", label: "All Agents" },
          ...agentIds.map((id) => ({ id, label: id })),
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setSelectedAgent(t.id)}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer border-none",
              selectedAgent === t.id
                ? "bg-accent text-white"
                : "bg-bg-1 text-muted hover:bg-bg-2",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 max-lg:grid-cols-2 max-sm:grid-cols-1 gap-3 mb-6">
        <StatCard
          label="Total Requests"
          value={formatNumber(totalReqs)}
          sub={`${formatNumber(totalInput + totalOutput)} total tokens`}
          accentColor="#a78bfa"
        />
        <StatCard
          label="Total Cost"
          value={formatCost(totalCost)}
          sub={
            totalReqs > 0
              ? `${formatCost(costPerReq)} avg per request`
              : undefined
          }
          accentColor="#f59e0b"
        />
        <StatCard
          label="Avg Response"
          value={formatDuration(avgDuration)}
          sub={
            relevantRecent.length > 0
              ? `from ${relevantRecent.length} recent requests`
              : undefined
          }
          accentColor="#2dd4bf"
        />
        <StatCard
          label="Cache Hit Rate"
          value={`${cacheHitPct}%`}
          progress={cacheHitPct}
          sub={
            totalCacheRead > 0
              ? `${formatNumber(totalCacheRead)} cached / ${formatNumber(totalInput)} input`
              : undefined
          }
          accentColor={
            cacheHitPct >= 70
              ? "#2dd4bf"
              : cacheHitPct >= 40
                ? "#3b82f6"
                : "#fbbf24"
          }
        />
      </div>

      {/* Cost over time */}
      {timeseries.length > 0 && (
        <ChartCard title="Cost & Requests Over Time" className="mb-5">
          <CostTimelineChart
            data={timeseries}
            granularity={range === "24h" ? "hour" : "day"}
          />
        </ChartCard>
      )}

      {/* Two-column: Agent/Model breakdown + Token Distribution */}
      {isAllAgents && byAgent.length > 0 && (
        <div className="grid grid-cols-[1fr_320px] max-lg:grid-cols-1 gap-4 mb-5">
          <ChartCard title="Cost by Agent">
            <CostByAgentChart data={byAgent} />
          </ChartCard>
          <ChartCard title="Token Distribution">
            <TokenDistributionChart
              input={totalInput}
              output={totalOutput}
              cacheRead={totalCacheRead}
              cacheCreation={totalCacheCreation}
            />
          </ChartCard>
        </div>
      )}

      {/* Single agent: Token dist + Activity in two columns */}
      {!isAllAgents && (
        <div className="grid grid-cols-[320px_1fr] max-lg:grid-cols-1 gap-4 mb-5">
          <ChartCard title="Token Distribution">
            <TokenDistributionChart
              input={totalInput}
              output={totalOutput}
              cacheRead={totalCacheRead}
              cacheCreation={totalCacheCreation}
            />
          </ChartCard>
          {filteredRecent.length > 0 && (
            <ChartCard title="Activity Timeline">
              <ActivityTimelineChart
                data={filteredRecent}
                granularity={range === "24h" ? "hour" : "day"}
                agentIds={[selectedAgent]}
              />
            </ChartCard>
          )}
        </div>
      )}

      {/* All Agents: Model breakdown + Activity */}
      {isAllAgents && (
        <div className="grid grid-cols-2 max-lg:grid-cols-1 gap-4 mb-5">
          {byModel.length > 0 && (
            <ChartCard title="Cost by Model">
              <CostByModelChart data={byModel} />
            </ChartCard>
          )}
          {filteredRecent.length > 0 && (
            <ChartCard title="Activity Timeline">
              <ActivityTimelineChart
                data={filteredRecent}
                granularity={range === "24h" ? "hour" : "day"}
                agentIds={agentIds}
              />
            </ChartCard>
          )}
        </div>
      )}

      {/* Cron jobs */}
      {agentCronJobs.length > 0 && (
        <div className="bg-bg-1 border border-border rounded-lg overflow-hidden mb-5">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between">
            <h3 className="text-xs font-semibold text-muted uppercase tracking-[0.1em]">
              Cron Jobs
            </h3>
            <span className="text-[11px] font-mono text-faint">
              {agentCronJobs.length} jobs
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className={cn(TH, "text-left")}>Name</th>
                  <th className={cn(TH, "text-left")}>Agent</th>
                  <th className={cn(TH, "text-center")}>Status</th>
                  <th className={cn(TH, "text-right")}>Last Run</th>
                  <th className={cn(TH, "text-right")}>Next Run</th>
                </tr>
              </thead>
              <tbody>
                {agentCronJobs.map((job) => (
                  <tr
                    key={job.id}
                    className="border-b border-border/30 hover:bg-bg-2/50 transition-colors"
                  >
                    <td className="px-4 py-2.5 font-mono text-foreground text-sm">
                      {job.name}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-muted text-xs">
                      {job.payload.agentId ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span
                        className={cn(
                          "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium",
                          job.lastStatus === "ok"
                            ? "bg-success/10 text-success"
                            : job.lastStatus === "error"
                              ? "bg-danger-subtle text-danger"
                              : "bg-bg-3 text-faint",
                        )}
                      >
                        {job.lastStatus ?? "pending"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-faint text-xs whitespace-nowrap">
                      {job.lastRunAt ? relativeTime(job.lastRunAt) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right text-faint text-xs whitespace-nowrap">
                      {job.nextRunAt ? formatTime(job.nextRunAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent activity */}
      <div className="bg-bg-1 border border-border rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-[0.1em]">
            Recent Activity
          </h3>
          <span className="text-[11px] font-mono text-faint">
            {filteredRecent.length} requests
          </span>
        </div>
        {filteredRecent.length === 0 ? (
          <EmptyState description="No usage records yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {isAllAgents && (
                    <th className={cn(TH, "text-left")}>Agent</th>
                  )}
                  <th className={cn(TH, "text-left")}>Model</th>
                  <th className={cn(TH, "text-left")}>Source</th>
                  <th className={cn(TH, "text-right")}>Input</th>
                  <th className={cn(TH, "text-right")}>Output</th>
                  <th className={cn(TH, "text-center")}>Cache</th>
                  <th className={cn(TH, "text-right")}>Cost</th>
                  <th className={cn(TH, "text-right")}>Duration</th>
                  <th className={cn(TH, "text-right")}>When</th>
                </tr>
              </thead>
              <tbody>
                {filteredRecent.slice(0, 50).map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-border/30 hover:bg-bg-2/50 transition-colors"
                  >
                    {isAllAgents && (
                      <td className="px-4 py-2 font-mono text-foreground text-sm">
                        {r.agentId}
                      </td>
                    )}
                    <td className="px-4 py-2 font-mono text-xs text-muted max-w-[140px] truncate">
                      {r.model}
                    </td>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-bg-3 text-muted">
                        {r.source}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-accent">
                      {formatNumber(r.inputTokens)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-success">
                      {formatNumber(r.outputTokens)}
                    </td>
                    <td className="px-4 py-2">
                      <CacheBar
                        total={r.inputTokens}
                        cached={r.cacheReadTokens}
                      />
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-warning">
                      {formatCost(r.costUsd)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-muted text-xs">
                      {formatDuration(r.durationMs)}
                    </td>
                    <td className="px-4 py-2 text-right text-faint whitespace-nowrap text-xs">
                      {relativeTime(r.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
