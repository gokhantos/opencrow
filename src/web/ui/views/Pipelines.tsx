import { useState, useEffect, useCallback, useRef } from "react";
import {
  Play,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  ChevronDown,
  ChevronRight,
  Zap,
  Database,
  Brain,
  ShieldCheck,
  Save,
  Lightbulb,
} from "lucide-react";
import { apiFetch } from "../api";
import { relativeTime } from "../lib/format";
import { cn } from "../lib/cn";
import { PageHeader, LoadingState, EmptyState } from "../components";
import { useToast } from "../components/Toast";

// ── Types ──────────────────────────────────────────────────────────────

interface PipelineResultSummary {
  readonly totalSourcesQueried: number;
  readonly totalSignalsFound: number;
  readonly totalIdeasGenerated: number;
  readonly totalIdeasKept: number;
  readonly totalIdeasDuplicate: number;
  readonly topThemes: readonly string[];
  readonly ideaIds: readonly string[];
  readonly durationMs: number;
}

interface PipelineRunRow {
  readonly id: string;
  readonly pipelineId: string;
  readonly status: string;
  readonly category: string;
  readonly config: Record<string, unknown>;
  readonly resultSummary: PipelineResultSummary | null;
  readonly error: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly createdAt: number;
}

interface PipelineStep {
  readonly id: string;
  readonly runId: string;
  readonly stepName: string;
  readonly status: string;
  readonly inputSummary: string | null;
  readonly outputSummary: string | null;
  readonly durationMs: number | null;
  readonly error: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

interface PipelineDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly defaultConfig: Record<string, unknown>;
  readonly latestRun: PipelineRunRow | null;
}

interface RunIdea {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly reasoning: string;
  readonly category: string;
  readonly quality_score: number | null;
  readonly sources_used: string;
  readonly created_at: number;
}

interface RunDetail extends PipelineRunRow {
  readonly steps: readonly PipelineStep[];
}

// ── Status helpers ──────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-bg-3 text-muted border border-border",
  running: "bg-accent-subtle text-accent border border-accent/20",
  completed: "bg-success-subtle text-success border border-success/20",
  failed: "bg-danger-subtle text-danger border border-danger/20",
};

const STATUS_ICONS: Record<string, typeof CheckCircle2> = {
  pending: Clock,
  running: Loader2,
  completed: CheckCircle2,
  failed: XCircle,
};

const STEP_ICONS: Record<string, typeof Database> = {
  landscape: Database,
  reviews: Database,
  capabilities: Brain,
  deep_search: Brain,
  synthesis: Lightbulb,
  validate: ShieldCheck,
  store: Save,
  // Legacy
  trends: Zap,
  pain_points: Database,
  collect: Database,
  signals: Zap,
  analysis: Brain,
  generation: Lightbulb,
  synthesize: Brain,
};

const STEP_LABELS: Record<string, string> = {
  landscape: "App Landscape",
  reviews: "Reviews",
  capabilities: "Capabilities",
  deep_search: "Deep Search",
  synthesis: "Synthesize",
  validate: "Validate",
  store: "Store",
  // Legacy
  trends: "Trends",
  pain_points: "Pain Points",
  collect: "Collect",
  signals: "Signals",
  analysis: "Analysis",
  generation: "Generate",
  synthesize: "Synthesize",
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

// ── Step Progress Bar ────────────────────────────────────────────────

function StepProgressBar({
  steps,
}: {
  readonly steps: readonly PipelineStep[];
}) {
  if (steps.length === 0) return null;

  return (
    <div className="flex items-center gap-1">
      {steps.map((step, i) => {
        const Icon = STEP_ICONS[step.stepName] ?? Database;
        const isLast = i === steps.length - 1;

        return (
          <div key={step.id} className="flex items-center gap-1">
            <div
              className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium",
                step.status === "completed" &&
                  "bg-success-subtle text-success",
                step.status === "running" && "bg-accent-subtle text-accent",
                step.status === "failed" && "bg-danger-subtle text-danger",
                step.status === "pending" && "bg-bg-3 text-faint",
              )}
              title={step.outputSummary ?? step.stepName}
            >
              {step.status === "running" ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Icon size={11} />
              )}
              <span className="max-md:hidden">
                {STEP_LABELS[step.stepName] ?? step.stepName}
              </span>
              {step.durationMs !== null && (
                <span className="text-faint font-mono text-[10px]">
                  {formatDuration(step.durationMs)}
                </span>
              )}
            </div>
            {!isLast && (
              <ChevronRight size={10} className="text-border-2 shrink-0" />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Stat Card ────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  highlight,
}: {
  readonly label: string;
  readonly value: number;
  readonly highlight?: boolean;
}) {
  return (
    <div className="p-3 bg-bg-1 rounded border border-border">
      <div className="text-xs text-faint mb-1">{label}</div>
      <div
        className={cn(
          "text-xl font-bold font-mono",
          highlight ? "text-accent" : "text-strong",
        )}
      >
        {value}
      </div>
    </div>
  );
}

// ── Run Row (single fetch, shared data between progress bar + detail) ─

function RunRow({ run }: { readonly run: PipelineRunRow }) {
  const [expanded, setExpanded] = useState(run.status === "running");
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [ideas, setIdeas] = useState<readonly RunIdea[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [expandedIdeaId, setExpandedIdeaId] = useState<string | null>(null);
  const StatusIcon = STATUS_ICONS[run.status] ?? Clock;

  // Single fetch for both progress bar and detail panel
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await apiFetch<{ success: boolean; data: RunDetail }>(
          `/api/pipelines-runs/${run.id}`,
        );
        if (active && res.success) {
          setDetail(res.data);
          setLoadError(false);
        }
      } catch {
        if (active) setLoadError(true);
      }
    }
    load();
    const interval =
      run.status === "running" ? setInterval(load, 3000) : undefined;
    return () => {
      active = false;
      if (interval) clearInterval(interval);
    };
  }, [run.id, run.status]);

  // Fetch ideas when expanded and run is completed
  useEffect(() => {
    if (!expanded || run.status === "running") return;
    let active = true;
    async function loadIdeas() {
      try {
        const res = await apiFetch<{ success: boolean; data: readonly RunIdea[] }>(
          `/api/pipelines-runs/${run.id}/ideas`,
        );
        if (active && res.success) setIdeas(res.data);
      } catch {
        // ignore
      }
    }
    loadIdeas();
    return () => { active = false; };
  }, [run.id, expanded, run.status]);

  const steps = detail?.steps ?? [];

  return (
    <div className="bg-bg-1 rounded-lg border border-border overflow-hidden">
      <button
        className="w-full flex items-center gap-3 p-4 text-left cursor-pointer hover:bg-bg-2 transition-colors"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <div
          className={cn(
            "p-1.5 rounded",
            STATUS_STYLES[run.status] ?? "bg-bg-3 text-muted",
          )}
        >
          {run.status === "running" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <StatusIcon size={14} />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-strong capitalize">
              {run.pipelineId.replace(/-/g, " ")}
            </span>
            <span
              className={cn(
                "px-2 py-0.5 rounded-full text-xs font-medium capitalize",
                STATUS_STYLES[run.status] ?? "bg-bg-3 text-muted",
              )}
            >
              {run.status}
            </span>
            {run.resultSummary && (
              <span className="text-xs text-muted">
                {run.resultSummary.totalIdeasKept} ideas in{" "}
                {formatDuration(run.resultSummary.durationMs)}
              </span>
            )}
          </div>
          <div className="text-xs text-faint mt-0.5">
            {relativeTime(run.createdAt)}
            {run.category && (
              <span className="ml-2 text-accent">
                {run.category.replace(/_/g, " ")}
              </span>
            )}
          </div>
          {steps.length > 0 && (
            <div className="mt-1.5">
              <StepProgressBar steps={steps} />
            </div>
          )}
        </div>

        <ChevronDown
          size={16}
          className={cn(
            "text-faint transition-transform shrink-0",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-border">
          {!detail && !loadError && (
            <div className="py-4 text-center text-faint text-sm">
              Loading...
            </div>
          )}
          {loadError && (
            <div className="py-4 text-center text-danger text-sm">
              Failed to load run details
            </div>
          )}
          {detail && (
            <div className="mt-3 space-y-3">
              {/* Steps detail */}
              {detail.steps.length > 0 && (
                <div className="space-y-2">
                  {detail.steps.map((step) => {
                    const Icon = STEP_ICONS[step.stepName] ?? Database;
                    return (
                      <div
                        key={step.id}
                        className="flex items-start gap-3 p-3 bg-bg rounded-md border border-border"
                      >
                        <div
                          className={cn(
                            "mt-0.5 p-1.5 rounded",
                            step.status === "completed" &&
                              "bg-success-subtle text-success",
                            step.status === "running" &&
                              "bg-accent-subtle text-accent",
                            step.status === "failed" &&
                              "bg-danger-subtle text-danger",
                            step.status === "pending" && "bg-bg-3 text-faint",
                          )}
                        >
                          {step.status === "running" ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Icon size={14} />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-strong">
                              {STEP_LABELS[step.stepName] ?? step.stepName}
                            </span>
                            {step.durationMs !== null && (
                              <span className="text-xs text-faint font-mono">
                                {formatDuration(step.durationMs)}
                              </span>
                            )}
                          </div>
                          {step.outputSummary && (
                            <p className="text-xs text-muted mt-1 leading-relaxed">
                              {step.outputSummary}
                            </p>
                          )}
                          {step.error && (
                            <p className="text-xs text-danger mt-1">
                              {step.error}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Result summary */}
              {detail.resultSummary && (
                <div className="p-4 bg-bg rounded-md border border-border">
                  <h4 className="text-sm font-semibold text-strong mb-3">
                    Results
                  </h4>
                  <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
                    <StatCard
                      label="Sources Queried"
                      value={detail.resultSummary.totalSourcesQueried}
                    />
                    <StatCard
                      label="Signals Found"
                      value={detail.resultSummary.totalSignalsFound}
                    />
                    <StatCard
                      label="Ideas Generated"
                      value={detail.resultSummary.totalIdeasGenerated}
                    />
                    <StatCard
                      label="Ideas Kept"
                      value={detail.resultSummary.totalIdeasKept}
                      highlight
                    />
                  </div>
                  {detail.resultSummary.topThemes.length > 0 && (
                    <div className="mt-3">
                      <span className="text-xs text-faint font-medium">
                        Top Themes:
                      </span>
                      <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {detail.resultSummary.topThemes.map((theme) => (
                          <span
                            key={theme}
                            className="px-2 py-0.5 rounded-full bg-accent-subtle text-accent text-xs font-medium"
                          >
                            {theme}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Generated Ideas */}
              {ideas.length > 0 && (
                <div className="p-4 bg-bg rounded-md border border-border">
                  <h4 className="text-sm font-semibold text-strong mb-3">
                    Generated Ideas ({ideas.length})
                  </h4>
                  <div className="space-y-2">
                    {ideas.map((idea) => (
                      <div
                        key={idea.id}
                        className="p-3 bg-bg-1 rounded-md border border-border hover:border-border-2 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <button
                              className="text-left w-full cursor-pointer bg-transparent border-none p-0"
                              onClick={() =>
                                setExpandedIdeaId(
                                  expandedIdeaId === idea.id
                                    ? null
                                    : idea.id,
                                )
                              }
                            >
                              <div className="flex items-center gap-2">
                                <h5 className="text-sm font-semibold text-strong">
                                  {idea.title}
                                </h5>
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-accent-subtle text-accent border border-accent/20 capitalize shrink-0">
                                  {idea.category.replace(/_/g, " ")}
                                </span>
                                {idea.quality_score !== null && (
                                  <span
                                    className={cn(
                                      "px-2 py-0.5 rounded-full text-[10px] font-semibold font-mono shrink-0",
                                      idea.quality_score >= 4
                                        ? "bg-success-subtle text-success border border-success/20"
                                        : idea.quality_score >= 3
                                          ? "bg-warning-subtle text-warning border border-warning/20"
                                          : "bg-bg-3 text-muted border border-border",
                                    )}
                                  >
                                    {idea.quality_score.toFixed(1)}
                                  </span>
                                )}
                                <ChevronRight
                                  size={12}
                                  className={cn(
                                    "text-faint transition-transform shrink-0 ml-auto",
                                    expandedIdeaId === idea.id &&
                                      "rotate-90",
                                  )}
                                />
                              </div>
                            </button>
                            <p className="text-xs text-muted mt-1 leading-relaxed">
                              {idea.summary}
                            </p>
                            {idea.sources_used && (
                              <p className="text-[10px] text-faint mt-1 italic">
                                Sources: {idea.sources_used}
                              </p>
                            )}
                          </div>
                        </div>
                        {expandedIdeaId === idea.id && idea.reasoning && (
                          <div className="mt-3 px-4 py-3 bg-accent-subtle border-l-2 border-l-accent rounded-r-md text-xs text-muted leading-relaxed whitespace-pre-wrap">
                            {idea.reasoning}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Error */}
              {detail.error && (
                <div className="p-3 bg-danger-subtle border border-danger/20 rounded-md">
                  <p className="text-sm text-danger font-mono">
                    {detail.error}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Pipeline Card ─────────────────────────────────────────────────────

function PipelineCard({
  pipeline,
  onRun,
  isRunning,
}: {
  readonly pipeline: PipelineDefinition;
  readonly onRun: (id: string) => void;
  readonly isRunning: boolean;
}) {
  const latestRun = pipeline.latestRun;

  return (
    <div className="p-5 bg-bg-1 rounded-lg border border-border hover:border-border-2 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-accent-subtle text-accent rounded-lg">
            <Zap size={20} />
          </div>
          <div>
            <h3 className="font-heading text-base font-semibold text-strong">
              {pipeline.name}
            </h3>
            <p className="text-sm text-muted mt-0.5 leading-relaxed max-w-lg">
              {pipeline.description}
            </p>
          </div>
        </div>

        <button
          disabled={isRunning}
          onClick={() => onRun(pipeline.id)}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors shrink-0",
            isRunning
              ? "bg-bg-3 text-faint cursor-not-allowed"
              : "bg-accent text-white cursor-pointer hover:bg-accent/80",
          )}
        >
          {isRunning ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              Running...
            </>
          ) : (
            <>
              <Play size={14} />
              Run Now
            </>
          )}
        </button>
      </div>

      {/* Latest run info */}
      {latestRun && (
        <div className="mt-4 pt-3 border-t border-border flex items-center gap-4 text-xs text-faint">
          <span>Last run: {relativeTime(latestRun.createdAt)}</span>
          <span
            className={cn(
              "px-2 py-0.5 rounded-full font-medium capitalize",
              STATUS_STYLES[latestRun.status] ?? "bg-bg-3 text-muted",
            )}
          >
            {latestRun.status}
          </span>
          {latestRun.resultSummary && (
            <>
              <span className="text-success font-semibold">
                {latestRun.resultSummary.totalIdeasKept} ideas
              </span>
              <span>
                {formatDuration(latestRun.resultSummary.durationMs)}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────

export default function Pipelines() {
  const toast = useToast();
  const [pipelines, setPipelines] = useState<readonly PipelineDefinition[]>(
    [],
  );
  const [runs, setRuns] = useState<readonly PipelineRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningPipelines, setRunningPipelines] = useState<
    ReadonlySet<string>
  >(new Set());
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fetchData = useCallback(async () => {
    try {
      const [pipelinesRes, runsRes] = await Promise.all([
        apiFetch<{ success: boolean; data: readonly PipelineDefinition[] }>(
          "/api/pipelines",
        ),
        apiFetch<{ success: boolean; data: readonly PipelineRunRow[] }>(
          "/api/pipelines-runs?limit=20",
        ),
      ]);

      if (pipelinesRes.success) setPipelines(pipelinesRes.data);
      if (runsRes.success) {
        setRuns(runsRes.data);
        const running = new Set<string>();
        for (const run of runsRes.data) {
          if (run.status === "running") {
            running.add(run.pipelineId);
          }
        }
        setRunningPipelines(running);
      }
    } catch {
      // Silently fail on poll — toast only on explicit user actions
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => {
      clearInterval(interval);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [fetchData]);

  const handleRun = useCallback(
    async (pipelineId: string) => {
      try {
        const res = await apiFetch<{
          success: boolean;
          message: string;
          runId: string;
        }>(`/api/pipelines/${pipelineId}/run`, { method: "POST" });

        if (res.success) {
          toast.success(`Pipeline started (${res.runId})`);
          setRunningPipelines((prev) => new Set([...prev, pipelineId]));
          refreshTimer.current = setTimeout(fetchData, 1000);
        }
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to start pipeline";
        toast.error(msg);
      }
    },
    [fetchData, toast],
  );

  if (loading) {
    return <LoadingState message="Loading pipelines..." />;
  }

  return (
    <div>
      <PageHeader
        title="Idea Pipelines"
        count={pipelines.length}
        subtitle="AI-powered idea generation from all your data sources"
      />

      {/* Pipeline Cards */}
      {pipelines.length === 0 ? (
        <EmptyState
          title="No pipelines configured"
          description="Pipelines will appear here when configured."
        />
      ) : (
        <div className="space-y-4 mb-8">
          {pipelines.map((p) => (
            <PipelineCard
              key={p.id}
              pipeline={p}
              onRun={handleRun}
              isRunning={runningPipelines.has(p.id)}
            />
          ))}
        </div>
      )}

      {/* Recent Runs */}
      {runs.length > 0 && (
        <>
          <h2 className="font-heading text-lg font-semibold text-strong mb-4">
            Recent Runs
          </h2>
          <div className="space-y-3">
            {runs.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
