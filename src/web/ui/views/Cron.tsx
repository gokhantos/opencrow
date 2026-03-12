import { useState, useEffect, useCallback, useRef } from "react";
import { z } from "zod";
import { Controller } from "react-hook-form";
import { apiFetch } from "../api";
import {
  PageHeader,
  LoadingState,
  EmptyState,
  Button,
  Input,
  Toggle,
  FormField,
} from "../components";
import { useZodForm } from "../hooks/useZodForm";

interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  deleteAfterRun: boolean;
  priority: number;
  schedule: {
    kind: string;
    at?: string;
    everyMs?: number;
    expr?: string;
    tz?: string;
  };
  payload: {
    kind: string;
    message: string;
    agentId?: string;
    timeoutSeconds?: number;
  };
  delivery: { mode: string; channel?: string; chatId?: string };
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

interface CronProgressEntry {
  type: string;
  text: string;
  ts: number;
}

interface CronRun {
  id: string;
  jobId: string;
  status: string;
  resultSummary: string | null;
  error: string | null;
  durationMs: number | null;
  startedAt: number;
  endedAt: number | null;
  progress: CronProgressEntry[] | null;
}

interface CronStatus {
  running: boolean;
  jobCount: number;
  nextDueAt: number | null;
}

interface AgentOption {
  id: string;
  name: string;
}

/* ─── Form Schema ─── */

const cronJobSchema = z.object({
  name: z.string().min(1, "Name is required"),
  scheduleKind: z.string(),
  at: z.string(),
  everyMs: z.string(),
  cronExpr: z.string(),
  tz: z.string(),
  message: z.string().min(1, "Message is required"),
  agentId: z.string(),
  deleteAfterRun: z.boolean(),
  priority: z.string(),
});

type CronJobFormValues = z.input<typeof cronJobSchema>;

/* ─── Helpers ─── */

function formatSchedule(s: CronJob["schedule"]): string {
  if (s.kind === "at") return `Once at ${s.at ?? "unknown"}`;
  if (s.kind === "every") {
    const sec = Math.floor((s.everyMs ?? 0) / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    const rem = min % 60;
    return rem > 0 ? `${hr}h ${rem}m` : `${hr}h`;
  }
  if (s.kind === "cron") return `${s.expr ?? ""}${s.tz ? ` (${s.tz})` : ""}`;
  return "Unknown";
}

function formatTs(ts: number | null): string {
  if (!ts) return "-";
  return new Date(ts * 1000).toLocaleString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatProgressTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
}

const PROGRESS_ICON: Record<string, string> = {
  thinking: "\u2022",
  tool_start: "\u25B6",
  tool_done: "\u2713",
  iteration: "\u2192",
  subagent_start: "\u25C6",
  subagent_done: "\u2714",
};

const PROGRESS_LABEL: Record<string, string> = {
  thinking: "thought",
  tool_start: "tool",
  tool_done: "result",
  iteration: "step",
  subagent_start: "agent",
  subagent_done: "done",
};

const selectClass =
  "w-full px-4 py-2.5 bg-bg border border-border rounded-lg text-foreground text-sm outline-none transition-colors duration-150 focus:border-accent";

const POLL_INTERVAL_MS = 3000;

/* ─── Status Dot ─── */

function StatusDot({
  status,
  pulse,
}: {
  status: "ok" | "error" | "running" | "disabled" | "idle";
  pulse?: boolean;
}) {
  const colors: Record<string, string> = {
    ok: "bg-success",
    error: "bg-danger",
    running: "bg-accent",
    disabled: "bg-faint",
    idle: "bg-muted",
  };
  return (
    <span className="relative flex items-center justify-center w-2.5 h-2.5">
      {pulse && (
        <span
          className={`absolute inset-0 rounded-full ${colors[status] ?? colors.idle} opacity-40 animate-ping`}
        />
      )}
      <span
        className={`relative block w-2 h-2 rounded-full ${colors[status] ?? colors.idle}`}
      />
    </span>
  );
}

/* ─── Progress Panel (collapsible, fixed height) ─── */

function ProgressPanel({
  progress,
  expanded,
  onToggle,
}: {
  progress: CronProgressEntry[] | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const entries = progress ?? [];
  const latestEntry = entries[entries.length - 1];

  useEffect(() => {
    if (expanded) {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [entries.length, expanded]);

  return (
    <div className="cr-progress">
      <button
        type="button"
        onClick={onToggle}
        className="cr-progress-toggle"
      >
        <span className="cr-progress-toggle-left">
          <span className="w-3 h-3 border-2 border-faint border-t-accent rounded-full animate-spin inline-block" />
          <span className="cr-progress-label">Live</span>
          <span className="cr-progress-count">{entries.length}</span>
        </span>
        {!expanded && latestEntry && (
          <span className="cr-progress-preview">
            {PROGRESS_LABEL[latestEntry.type] ?? latestEntry.type}:{" "}
            {latestEntry.text.slice(0, 60)}
            {latestEntry.text.length > 60 ? "..." : ""}
          </span>
        )}
        <span className="cr-progress-chevron" data-expanded={expanded}>
          {"\u25BE"}
        </span>
      </button>
      {expanded && (
        <div className="cr-progress-body">
          {entries.length === 0 ? (
            <div className="cr-progress-empty">Waiting for output...</div>
          ) : (
            entries.map((entry, i) => (
              <div key={i} className="cr-progress-entry">
                <span className="cr-progress-time">
                  {formatProgressTime(entry.ts)}
                </span>
                <span className="cr-progress-icon">
                  {PROGRESS_ICON[entry.type] ?? "\u2022"}
                </span>
                <span className="cr-progress-type">
                  {PROGRESS_LABEL[entry.type] ?? entry.type}
                </span>
                <span className="cr-progress-text">{entry.text}</span>
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}

/* ─── Run Row ─── */

function RunRow({ run }: { run: CronRun }) {
  const isRunning = run.status === "running";
  const statusColor: Record<string, string> = {
    ok: "text-success",
    error: "text-danger",
    fail: "text-danger",
    running: "text-accent",
    timeout: "text-warning",
  };

  return (
    <div className="cr-run-row">
      <span className="cr-run-time">{formatTs(run.startedAt)}</span>
      <span className={statusColor[run.status] ?? "text-muted"}>
        <span className="cr-run-status">
          <StatusDot
            status={
              run.status === "ok"
                ? "ok"
                : run.status === "running"
                  ? "running"
                  : "error"
            }
            pulse={isRunning}
          />
          {run.status.toUpperCase()}
        </span>
      </span>
      <span className="cr-run-duration">
        {isRunning ? "-" : formatDuration(run.durationMs)}
      </span>
      <span className={`cr-run-result ${run.error ? "cr-run-error" : ""}`}>
        {isRunning
          ? "In progress..."
          : (run.error ?? run.resultSummary?.slice(0, 120) ?? "-")}
      </span>
    </div>
  );
}

/* ─── Job Card ─── */

function JobCard({
  job,
  activeRun,
  isExpanded,
  runs,
  runsLoading,
  onToggleExpand,
  onToggleEnabled,
  onRunNow,
  onDelete,
}: {
  job: CronJob;
  activeRun?: CronRun;
  isExpanded: boolean;
  runs: CronRun[];
  runsLoading: boolean;
  onToggleExpand: () => void;
  onToggleEnabled: () => void;
  onRunNow: () => void;
  onDelete: () => void;
}) {
  const [progressExpanded, setProgressExpanded] = useState(false);
  const isRunning = !!activeRun;

  const resolvedStatus = isRunning
    ? "running"
    : !job.enabled
      ? "disabled"
      : job.lastStatus === "ok"
        ? "ok"
        : job.lastStatus === "error" || job.lastStatus === "fail"
          ? "error"
          : "idle";

  return (
    <div
      className={`cr-card ${job.enabled ? "cr-enabled" : "cr-disabled"}`}
    >
      {/* Header */}
      <div className="cr-card-header">
        <div className="cr-card-name-row">
          <StatusDot status={resolvedStatus} pulse={isRunning} />
          <button
            type="button"
            className="cr-card-name"
            onClick={onToggleExpand}
          >
            {job.name}
          </button>
          {job.deleteAfterRun && (
            <span className="cr-badge-oneshot">once</span>
          )}
        </div>
        <div className="cr-card-badges">
          <Toggle checked={job.enabled} onChange={onToggleEnabled} />
        </div>
      </div>

      {/* Details grid */}
      <div className="cr-card-details">
        <div className="cr-detail">
          <span className="cr-detail-label">Schedule</span>
          <span className="cr-detail-value">
            {formatSchedule(job.schedule)}
          </span>
        </div>
        <div className="cr-detail">
          <span className="cr-detail-label">Next Run</span>
          <span className="cr-detail-value">{formatTs(job.nextRunAt)}</span>
        </div>
        <div className="cr-detail">
          <span className="cr-detail-label">Priority</span>
          <span className="cr-detail-value">
            {job.priority <= 3 ? "High" : job.priority <= 7 ? "Medium" : "Normal"}{" "}
            <span className="text-faint">({job.priority})</span>
          </span>
        </div>
        {job.payload.agentId && (
          <div className="cr-detail">
            <span className="cr-detail-label">Agent</span>
            <span className="cr-detail-value">{job.payload.agentId}</span>
          </div>
        )}
        <div className="cr-detail cr-message-preview">
          <span className="cr-detail-label">Message</span>
          <span className="cr-message-text">{job.payload.message}</span>
        </div>
      </div>

      {/* Live Progress — only when running */}
      {activeRun && (
        <div className="px-5 pt-3">
          <ProgressPanel
            progress={activeRun.progress}
            expanded={progressExpanded}
            onToggle={() => setProgressExpanded((v) => !v)}
          />
        </div>
      )}

      {/* Expanded: Recent Runs */}
      {isExpanded && (
        <div className="cr-runs-panel">
          <div className="cr-runs-title">Recent Runs</div>
          {runsLoading ? (
            <span className="w-4 h-4 border-2 border-border-2 border-t-accent rounded-full animate-spin inline-block" />
          ) : runs.length === 0 ? (
            <div className="cr-runs-empty">No runs yet</div>
          ) : (
            <div className="cr-runs-list">
              {runs.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="cr-card-actions">
        <Button variant="secondary" size="sm" onClick={onToggleExpand}>
          {isExpanded ? "Hide Runs" : "Runs"}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={onRunNow}
          disabled={isRunning}
        >
          {isRunning ? (
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 border-2 border-faint border-t-accent rounded-full animate-spin inline-block" />
              Running
            </span>
          ) : (
            "Run Now"
          )}
        </Button>
        <Button
          variant="danger"
          size="sm"
          onClick={onDelete}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

/* ─── Main Component ─── */

export default function Cron() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [status, setStatus] = useState<CronStatus | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [activeRuns, setActiveRuns] = useState<Record<string, CronRun>>({});
  const prevActiveJobIds = useRef<Set<string>>(new Set());

  const {
    register,
    handleSubmit,
    reset,
    control,
    watch,
    formState: { errors, isSubmitting: formSaving },
  } = useZodForm(cronJobSchema, {
    defaultValues: {
      name: "",
      scheduleKind: "every",
      at: "",
      everyMs: "3600000",
      cronExpr: "0 * * * *",
      tz: "",
      message: "",
      agentId: "",
      deleteAfterRun: false,
      priority: "10",
    },
  });
  const [formError, setFormError] = useState("");
  const scheduleKind = watch("scheduleKind");
  const everyMsValue = watch("everyMs");

  const loadJobs = useCallback(async () => {
    try {
      const [jobsRes, statusRes, activeRes] = await Promise.all([
        apiFetch<{ success: boolean; data: CronJob[] }>("/api/cron/jobs"),
        apiFetch<{ success: boolean; data: CronStatus }>("/api/cron/status"),
        apiFetch<{ success: boolean; data: CronRun[] }>(
          "/api/cron/active-runs",
        ),
      ]);
      if (jobsRes.success) setJobs(jobsRes.data);
      if (statusRes.success) setStatus(statusRes.data);

      if (activeRes.success) {
        const byJob: Record<string, CronRun> = {};
        for (const run of activeRes.data) {
          byJob[run.jobId] = run;
        }

        const currentActiveJobIds = new Set(Object.keys(byJob));
        const prevIds = prevActiveJobIds.current;
        for (const jobId of prevIds) {
          if (!currentActiveJobIds.has(jobId) && expandedJobId === jobId) {
            apiFetch<{ success: boolean; data: CronRun[] }>(
              `/api/cron/jobs/${jobId}/runs`,
            )
              .then((res) => {
                if (res.success) setRuns(res.data);
              })
              .catch((err) => console.error("Failed to load cron runs", err));
          }
        }
        prevActiveJobIds.current = currentActiveJobIds;
        setActiveRuns(byJob);
      }
    } catch {
      // cron might be disabled
    } finally {
      setLoading(false);
    }
  }, [expandedJobId]);

  useEffect(() => {
    loadJobs();
    const timer = setInterval(loadJobs, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadJobs]);

  useEffect(() => {
    apiFetch<{ success: boolean; data: AgentOption[] }>("/api/agents")
      .then((res) => {
        if (res.success) setAgents(res.data);
      })
      .catch((err) => console.error("Failed to load agents", err));
  }, []);

  async function toggleJob(id: string) {
    await apiFetch(`/api/cron/jobs/${id}/toggle`, { method: "POST" }).catch(
      () => null,
    );
    loadJobs();
  }

  async function runNow(id: string) {
    await apiFetch(`/api/cron/jobs/${id}/run`, { method: "POST" }).catch(
      () => null,
    );
    loadJobs();
  }

  async function deleteJob(id: string) {
    if (!confirm("Delete this cron job?")) return;
    await apiFetch(`/api/cron/jobs/${id}`, { method: "DELETE" }).catch(
      () => null,
    );
    loadJobs();
  }

  async function loadRuns(jobId: string) {
    if (expandedJobId === jobId) {
      setExpandedJobId(null);
      return;
    }
    setExpandedJobId(jobId);
    setRunsLoading(true);
    try {
      const res = await apiFetch<{ success: boolean; data: CronRun[] }>(
        `/api/cron/jobs/${jobId}/runs`,
      );
      if (res.success) setRuns(res.data);
    } catch {
      setRuns([]);
    } finally {
      setRunsLoading(false);
    }
  }

  async function onCreateJob(values: CronJobFormValues) {
    setFormError("");

    const schedule =
      values.scheduleKind === "at"
        ? { kind: "at" as const, at: values.at }
        : values.scheduleKind === "every"
          ? { kind: "every" as const, everyMs: Number(values.everyMs) }
          : {
              kind: "cron" as const,
              expr: values.cronExpr,
              tz: values.tz || undefined,
            };

    const body = {
      name: values.name,
      schedule,
      payload: {
        kind: "agentTurn" as const,
        message: values.message,
        agentId: values.agentId || undefined,
      },
      deleteAfterRun: values.deleteAfterRun,
      priority: Number(values.priority),
    };

    try {
      const res = await apiFetch<{ success: boolean; error?: string }>(
        "/api/cron/jobs",
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      if (res.success) {
        setShowForm(false);
        reset();
        setFormError("");
        loadJobs();
      } else {
        setFormError(
          typeof res.error === "string" ? res.error : JSON.stringify(res.error),
        );
      }
    } catch {
      setFormError("Failed to create job");
    }
  }

  if (loading) {
    return <LoadingState message="Loading cron..." />;
  }

  if (status === null) {
    return (
      <EmptyState
        title="Cron Unavailable"
        description="Could not reach the cron scheduler. The cron process may still be starting."
      />
    );
  }

  const activeCount = Object.keys(activeRuns).length;

  return (
    <div className="cr-page p-6">
      <PageHeader
        title="Cron Jobs"
        subtitle={
          <>
            {status.running ? "Running" : "Stopped"} | {status.jobCount} jobs
            {activeCount > 0 ? ` | ${activeCount} active` : ""}
            {status.nextDueAt ? ` | Next: ${formatTs(status.nextDueAt)}` : ""}
          </>
        }
        actions={
          <Button
            variant={showForm ? "secondary" : "primary"}
            size="sm"
            onClick={() => setShowForm(!showForm)}
          >
            {showForm ? "Cancel" : "New Job"}
          </Button>
        }
      />

      {showForm && (
        <div className="cr-form-card">
          <div className="cr-form-title">Create Job</div>
          {formError && <div className="cr-error">{formError}</div>}
          <form onSubmit={handleSubmit(onCreateJob)}>
            <div className="cr-form-grid">
              <div>
                <FormField error={errors.name}>
                  <Input
                    label="Name"
                    type="text"
                    {...register("name")}
                  />
                </FormField>
              </div>
              <div>
                <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                  Schedule Type
                </label>
                <Controller
                  control={control}
                  name="scheduleKind"
                  render={({ field }) => (
                    <select className={selectClass} {...field}>
                      <option value="every">Interval</option>
                      <option value="cron">Cron Expression</option>
                      <option value="at">One-time</option>
                    </select>
                  )}
                />
              </div>

              {scheduleKind === "at" && (
                <div>
                  <Input
                    label="Date/Time"
                    type="datetime-local"
                    {...register("at")}
                  />
                </div>
              )}
              {scheduleKind === "every" && (
                <div className="cr-form-row">
                  <div className="flex-1">
                    <Input
                      label="Interval (ms)"
                      type="number"
                      min={1000}
                      {...register("everyMs")}
                    />
                  </div>
                  <span className="cr-form-hint mt-5">
                    {Number(everyMsValue) >= 3600000
                      ? `${Math.floor(Number(everyMsValue) / 3600000)}h`
                      : Number(everyMsValue) >= 60000
                        ? `${Math.floor(Number(everyMsValue) / 60000)}m`
                        : `${Math.floor(Number(everyMsValue) / 1000)}s`}
                  </span>
                </div>
              )}
              {scheduleKind === "cron" && (
                <>
                  <div>
                    <Input
                      label="Cron Expression"
                      type="text"
                      placeholder="0 * * * *"
                      {...register("cronExpr")}
                    />
                  </div>
                  <div>
                    <Input
                      label="Timezone"
                      type="text"
                      placeholder="America/New_York"
                      {...register("tz")}
                    />
                  </div>
                </>
              )}

              <div className="cr-form-full">
                <FormField error={errors.message}>
                  <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                    Message
                  </label>
                  <textarea
                    className="w-full px-4 py-2.5 bg-bg border border-border rounded-lg text-foreground text-sm outline-none transition-colors duration-150 focus:border-accent placeholder:text-faint resize-none"
                    rows={2}
                    placeholder="Task for the agent..."
                    {...register("message")}
                  />
                </FormField>
              </div>

              <div>
                <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                  Agent
                </label>
                <Controller
                  control={control}
                  name="agentId"
                  render={({ field }) => (
                    <select className={selectClass} {...field}>
                      <option value="">Default</option>
                      {agents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} ({a.id})
                        </option>
                      ))}
                    </select>
                  )}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                  Priority
                </label>
                <Controller
                  control={control}
                  name="priority"
                  render={({ field }) => (
                    <select className={selectClass} {...field}>
                      <option value="1">High (1)</option>
                      <option value="3">Medium-High (3)</option>
                      <option value="5">Medium (5)</option>
                      <option value="10">Normal (10)</option>
                      <option value="15">Low (15)</option>
                    </select>
                  )}
                />
              </div>
              <div className="flex items-end pb-1">
                <Controller
                  control={control}
                  name="deleteAfterRun"
                  render={({ field }) => (
                    <Toggle
                      label="Delete after first run"
                      checked={field.value}
                      onChange={field.onChange}
                    />
                  )}
                />
              </div>
            </div>

            <div className="cr-form-actions">
              <Button type="submit" size="sm" loading={formSaving} disabled={formSaving}>
                Create
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setShowForm(false);
                  reset();
                  setFormError("");
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="cr-empty">
          <div className="cr-empty-icon">+</div>
          <div className="cr-empty-title">No cron jobs</div>
          <div className="cr-empty-desc">
            Create one above or ask an agent to schedule a task.
          </div>
        </div>
      ) : (
        <div className="cr-grid">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              activeRun={activeRuns[job.id]}
              isExpanded={expandedJobId === job.id}
              runs={expandedJobId === job.id ? runs : []}
              runsLoading={runsLoading && expandedJobId === job.id}
              onToggleExpand={() => loadRuns(job.id)}
              onToggleEnabled={() => toggleJob(job.id)}
              onRunNow={() => runNow(job.id)}
              onDelete={() => deleteJob(job.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
