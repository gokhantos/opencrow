import React, { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../api";
import { formatUptime } from "../lib/format";
import { cn } from "../lib/cn";
import { LoadingState, EmptyState, PageHeader, Button } from "../components";

interface ProcessInfo {
  name: string;
  pid: number;
  status: "alive" | "stale" | "dead";
  startedAt: number;
  lastHeartbeat: number;
  uptimeSeconds: number;
  metadata: Record<string, unknown>;
  desired?: boolean;
  syncStatus?: "synced" | "starting" | "restarting" | "crash-loop" | "stopped";
  restartCount?: number;
  backoffMs?: number;
  nextRetryAt?: number | null;
  orchestrated?: boolean;
}

interface RestartEvent {
  readonly name: string;
  readonly timestamp: number;
  readonly reason: "crash" | "manual" | "started";
}

interface ProcessGroup {
  label: string;
  icon: string;
  processes: readonly ProcessInfo[];
}

function getProcessType(name: string): string {
  if (name.startsWith("agent:")) return "agent";
  if (name.startsWith("scraper:")) return "scraper";
  if (name === "cron") return "cron";
  if (name === "web") return "web";
  if (name === "market") return "market";
  if (name === "core") return "core";
  if (name === "embedding") return "embedding";
  return "other";
}

function displayName(name: string): string {
  if (name.startsWith("agent:")) return name.slice(6);
  if (name.startsWith("scraper:")) {
    const id = name.slice(8);
    const labels: Record<string, string> = {
      hackernews: "Hacker News",
      producthunt: "Product Hunt",
      "x-bookmarks": "X Bookmarks",
      "x-autolike": "X Autolike",
      "x-autofollow": "X Autofollow",
      "x-timeline": "X Timeline",
    };
    return labels[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
  }
  const labels: Record<string, string> = {
    core: "Core",
    cron: "Cron",
    web: "Web",
    market: "Market",
    embedding: "Embedding",
  };
  return labels[name] ?? name;
}

function groupProcesses(
  processes: readonly ProcessInfo[],
): readonly ProcessGroup[] {
  const sorted = [...processes].sort((a, b) => a.name.localeCompare(b.name));
  const infra = sorted.filter((p) =>
    ["core", "cron", "web", "market", "embedding"].includes(p.name),
  );
  const agents = sorted.filter((p) => p.name.startsWith("agent:"));
  const scrapers = sorted.filter((p) => p.name.startsWith("scraper:"));
  const other = sorted.filter(
    (p) =>
      !["core", "cron", "web", "market", "embedding"].includes(p.name) &&
      !p.name.startsWith("agent:") &&
      !p.name.startsWith("scraper:"),
  );

  const groups: ProcessGroup[] = [];
  if (infra.length > 0)
    groups.push({ label: "Infrastructure", icon: "server", processes: infra });
  if (agents.length > 0)
    groups.push({ label: "Agents", icon: "bot", processes: agents });
  if (scrapers.length > 0)
    groups.push({ label: "Scrapers", icon: "download", processes: scrapers });
  if (other.length > 0)
    groups.push({ label: "Other", icon: "box", processes: other });
  return groups;
}

const TYPE_BADGE: Record<string, { bg: string; text: string }> = {
  core: { bg: "bg-purple-500/10", text: "text-purple-400" },
  cron: { bg: "bg-amber-500/10", text: "text-amber-400" },
  web: { bg: "bg-blue-500/10", text: "text-blue-400" },
  market: { bg: "bg-emerald-500/10", text: "text-emerald-400" },
  embedding: { bg: "bg-violet-500/10", text: "text-violet-400" },
  agent: { bg: "bg-cyan-500/10", text: "text-cyan-400" },
  scraper: { bg: "bg-orange-500/10", text: "text-orange-400" },
  other: { bg: "bg-bg-3", text: "text-muted" },
};

const STATUS_BORDER: Record<string, string> = {
  alive: "border-l-success",
  stale: "border-l-warning",
  dead: "border-l-danger",
};

const SYNC_CONFIG: Record<string, { bg: string; text: string; label: string }> =
  {
    synced: { bg: "bg-success/10", text: "text-success", label: "Synced" },
    starting: { bg: "bg-accent/10", text: "text-accent", label: "Starting" },
    restarting: {
      bg: "bg-warning/10",
      text: "text-warning",
      label: "Restarting",
    },
    "crash-loop": {
      bg: "bg-danger/10",
      text: "text-danger",
      label: "Crash loop",
    },
    stopped: { bg: "bg-bg-3", text: "text-muted", label: "Stopped" },
  };

function TypeBadge({ type }: { type: string }) {
  const fallback = { bg: "bg-bg-3", text: "text-muted" };
  const style = TYPE_BADGE[type] ?? fallback;
  return (
    <span
      className={cn(
        "text-[10px] font-semibold px-1.5 py-0.5 rounded tracking-wide uppercase",
        style.bg,
        style.text,
      )}
    >
      {type}
    </span>
  );
}

function SyncBadge({ syncStatus }: { syncStatus?: string }) {
  if (!syncStatus) return null;
  const c = SYNC_CONFIG[syncStatus] ?? { bg: "", text: "", label: syncStatus };
  const spinning = syncStatus === "starting" || syncStatus === "restarting";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-md tracking-wide uppercase whitespace-nowrap",
        c.bg,
        c.text,
      )}
    >
      {spinning && (
        <span className="w-2 h-2 border-[1.5px] border-current border-t-transparent rounded-full animate-spin" />
      )}
      {c.label}
    </span>
  );
}

function BackoffCountdown({ nextRetryAt }: { nextRetryAt: number }) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.ceil((nextRetryAt - Date.now()) / 1000)),
  );

  useEffect(() => {
    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((nextRetryAt - Date.now()) / 1000));
      setRemaining(left);
    }, 1000);
    return () => clearInterval(timer);
  }, [nextRetryAt]);

  if (remaining <= 0) return <span className="text-muted">retrying...</span>;

  return (
    <span className="text-warning font-mono tabular-nums">{remaining}s</span>
  );
}

function ProcessCard({
  process: proc,
  index,
  onAction,
}: {
  process: ProcessInfo;
  index: number;
  onAction: (name: string, action: "restart" | "stop" | "start") => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const isStopped = proc.syncStatus === "stopped";
  const isCrashLoop = proc.syncStatus === "crash-loop";
  const isBackoff = proc.status === "dead" && proc.syncStatus === "restarting";
  const isOrchestrated = proc.orchestrated ?? false;
  const type = getProcessType(proc.name);

  async function fire(action: "restart" | "stop" | "start") {
    setPending(true);
    try {
      await onAction(proc.name, action);
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className={cn(
        "group relative bg-bg-1 border border-border rounded-lg overflow-hidden",
        "border-l-[3px] transition-all duration-200",
        "hover:border-border-hover hover:bg-bg-1/80",
        STATUS_BORDER[proc.status] ?? "border-l-border",
        isCrashLoop && "border-l-danger bg-danger/[0.03]",
        isStopped && "opacity-50",
      )}
      style={{
        animation: `agCardIn 0.3s ease-out ${index * 30}ms both`,
      }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 px-4 pt-3.5 pb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn(
              "w-2 h-2 rounded-full shrink-0 mt-0.5",
              proc.status === "alive" &&
                "bg-success shadow-[0_0_6px_rgba(45,212,191,0.4)]",
              proc.status === "stale" &&
                "bg-warning shadow-[0_0_6px_rgba(251,191,36,0.4)]",
              proc.status === "dead" &&
                "bg-danger shadow-[0_0_6px_rgba(248,113,113,0.4)]",
            )}
          />
          <span className="font-semibold text-strong text-sm truncate">
            {displayName(proc.name)}
          </span>
          <TypeBadge type={type} />
        </div>
        <SyncBadge syncStatus={proc.syncStatus} />
      </div>

      {/* Metrics */}
      <div className="flex items-center gap-4 px-4 pb-2">
        <div className="flex flex-col">
          <span className="text-[10px] text-faint uppercase tracking-widest leading-none">
            Uptime
          </span>
          <span className="text-sm text-foreground font-mono mt-1">
            {proc.uptimeSeconds ? formatUptime(proc.uptimeSeconds) : "\u2014"}
          </span>
        </div>
        {proc.pid > 0 && (
          <div className="flex flex-col">
            <span className="text-[10px] text-faint uppercase tracking-widest leading-none">
              PID
            </span>
            <span className="text-sm text-muted font-mono mt-1">
              {proc.pid}
            </span>
          </div>
        )}
        {(proc.restartCount ?? 0) > 0 && (
          <div className="flex flex-col">
            <span className="text-[10px] text-faint uppercase tracking-widest leading-none">
              Restarts
            </span>
            <span className="text-sm text-warning font-mono mt-1">
              {proc.restartCount}
            </span>
          </div>
        )}
      </div>

      {/* Backoff countdown */}
      {(isBackoff || isCrashLoop) && proc.nextRetryAt && (
        <div className="flex items-center gap-2 px-4 pb-2">
          <span className="text-[10px] text-faint uppercase tracking-widest">
            Next retry
          </span>
          <BackoffCountdown nextRetryAt={proc.nextRetryAt} />
          {proc.backoffMs && proc.backoffMs > 1000 && (
            <span className="text-[10px] text-faint">
              (backoff {Math.round(proc.backoffMs / 1000)}s)
            </span>
          )}
        </div>
      )}

      {/* Crash loop detail */}
      {isCrashLoop && !proc.nextRetryAt && (
        <div className="flex items-center gap-2 px-4 pb-2">
          <span className="text-[11px] text-danger">
            Stopped — exceeded max restarts
          </span>
        </div>
      )}

      {/* Actions */}
      <div
        className={cn(
          "flex items-center justify-end gap-1.5 px-3 py-2",
          "border-t border-border/50",
          "opacity-0 group-hover:opacity-100 transition-opacity duration-150",
        )}
      >
        {isOrchestrated && isStopped && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fire("start")}
            disabled={pending}
            loading={pending}
            className="text-success text-xs"
          >
            Start
          </Button>
        )}
        {isOrchestrated && isCrashLoop && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fire("start")}
            disabled={pending}
            loading={pending}
            className="text-success text-xs"
          >
            Reset & Start
          </Button>
        )}
        {isOrchestrated && !isStopped && !isCrashLoop && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fire("stop")}
            disabled={pending}
            loading={pending}
            className="text-danger text-xs"
          >
            Stop
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => fire("restart")}
          disabled={pending || isStopped}
          loading={pending}
          className="text-xs"
        >
          Restart
        </Button>
      </div>
    </div>
  );
}

function GroupSection({
  group,
  startIndex,
  onAction,
}: {
  group: ProcessGroup;
  startIndex: number;
  onAction: (name: string, action: "restart" | "stop" | "start") => Promise<void>;
}) {
  const aliveCount = group.processes.filter((p) => p.status === "alive").length;

  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-3 px-1">
        <h3 className="text-xs uppercase tracking-[0.12em] text-faint font-semibold m-0">
          {group.label}
        </h3>
        <span className="text-[11px] font-mono text-muted">
          {aliveCount}/{group.processes.length}
        </span>
        <div className="flex-1 h-px bg-border" />
      </div>
      <div className="grid grid-cols-3 max-lg:grid-cols-2 max-sm:grid-cols-1 gap-3">
        {group.processes.map((p, i) => (
          <ProcessCard
            key={p.name}
            process={p}
            index={startIndex + i}
            onAction={onAction}
          />
        ))}
      </div>
    </div>
  );
}

function HealthBar({ processes }: { processes: readonly ProcessInfo[] }) {
  const total = processes.length;
  if (total === 0) return null;

  const alive = processes.filter((p) => p.status === "alive").length;
  const stale = processes.filter((p) => p.status === "stale").length;
  const dead = total - alive - stale;

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-5">
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <span className="w-2 h-2 rounded-full bg-success" />
            {alive} alive
          </span>
          {stale > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <span className="w-2 h-2 rounded-full bg-warning" />
              {stale} stale
            </span>
          )}
          {dead > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <span className="w-2 h-2 rounded-full bg-danger" />
              {dead} dead
            </span>
          )}
        </div>
        <span className="text-xs font-mono text-faint">
          {alive}/{total}
        </span>
      </div>
      <div className="flex h-1.5 rounded-full overflow-hidden bg-bg-2">
        {alive > 0 && (
          <div
            className="bg-success transition-all duration-500"
            style={{ width: `${(alive / total) * 100}%` }}
          />
        )}
        {stale > 0 && (
          <div
            className="bg-warning transition-all duration-500"
            style={{ width: `${(stale / total) * 100}%` }}
          />
        )}
        {dead > 0 && (
          <div
            className="bg-danger transition-all duration-500"
            style={{ width: `${(dead / total) * 100}%` }}
          />
        )}
      </div>
    </div>
  );
}

function CrashLoopBanner({ processes }: { processes: readonly ProcessInfo[] }) {
  const crashLooping = processes.filter((p) => p.syncStatus === "crash-loop");
  if (crashLooping.length === 0) return null;

  return (
    <div className="bg-danger/10 border border-danger/30 rounded-lg px-4 py-3 mb-5 flex items-start gap-3">
      <span className="text-danger text-lg leading-none mt-0.5">!</span>
      <div>
        <p className="text-danger font-semibold text-sm m-0">
          Crash loop detected
        </p>
        <p className="text-danger/80 text-xs mt-1 m-0">
          {crashLooping.map((p) => displayName(p.name)).join(", ")}{" "}
          {crashLooping.length === 1 ? "has" : "have"} exceeded the maximum
          restart threshold and will not be retried automatically. Use
          &quot;Reset &amp; Start&quot; to manually recover.
        </p>
      </div>
    </div>
  );
}

function RestartHistory({ events }: { events: readonly RestartEvent[] }) {
  if (events.length === 0) return null;

  return (
    <div className="mt-8">
      <div className="flex items-center gap-3 mb-3 px-1">
        <h3 className="text-xs uppercase tracking-[0.12em] text-faint font-semibold m-0">
          Restart History
        </h3>
        <span className="text-[11px] font-mono text-muted">
          {events.length}
        </span>
        <div className="flex-1 h-px bg-border" />
      </div>
      <div className="bg-bg-1 border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] text-faint uppercase tracking-widest">
              <th className="px-4 py-2.5 font-semibold">Process</th>
              <th className="px-4 py-2.5 font-semibold">Time</th>
              <th className="px-4 py-2.5 font-semibold">Reason</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev, i) => (
              <tr
                key={`${ev.name}-${ev.timestamp}-${i}`}
                className="border-t border-border/50"
              >
                <td className="px-4 py-2 font-medium text-foreground">
                  {displayName(ev.name)}
                </td>
                <td className="px-4 py-2 text-muted font-mono text-xs">
                  {new Date(ev.timestamp).toLocaleTimeString()}
                </td>
                <td className="px-4 py-2">
                  <span
                    className={cn(
                      "text-[11px] font-semibold px-2 py-0.5 rounded-md uppercase",
                      ev.reason === "crash" && "bg-danger/10 text-danger",
                      ev.reason === "manual" && "bg-accent/10 text-accent",
                      ev.reason === "started" && "bg-success/10 text-success",
                    )}
                  >
                    {ev.reason}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const MAX_HISTORY = 50;

export default function Processes() {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [restartHistory, setRestartHistory] = useState<RestartEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const prevRef = React.useRef<Map<string, ProcessInfo>>(new Map());

  const detectRestartEvents = useCallback((current: readonly ProcessInfo[]) => {
    const prev = prevRef.current;
    if (prev.size === 0) {
      // First load — seed prev map, no events
      const nextMap = new Map(current.map((p) => [p.name, p]));
      prevRef.current = nextMap;
      return;
    }

    const newEvents: RestartEvent[] = [];
    for (const proc of current) {
      const old = prev.get(proc.name);
      if (!old) {
        // New process appeared
        if (proc.status === "alive") {
          newEvents.push({
            name: proc.name,
            timestamp: Date.now(),
            reason: "started",
          });
        }
        continue;
      }

      // Restart count increased
      if ((proc.restartCount ?? 0) > (old.restartCount ?? 0)) {
        newEvents.push({
          name: proc.name,
          timestamp: Date.now(),
          reason: "crash",
        });
      }
    }

    if (newEvents.length > 0) {
      setRestartHistory((h) => [...newEvents, ...h].slice(0, MAX_HISTORY));
    }

    prevRef.current = new Map(current.map((p) => [p.name, p]));
  }, []);

  const fetchProcesses = useCallback(async () => {
    try {
      const res = await apiFetch<{ data: ProcessInfo[] }>("/api/processes");
      setProcesses(res.data);
      detectRestartEvents(res.data);
      setError("");
      setLoading(false);
    } catch {
      setError("Failed to load processes");
      setLoading(false);
    }
  }, [detectRestartEvents]);

  useEffect(() => {
    fetchProcesses();
    const interval = setInterval(fetchProcesses, 5000);
    return () => clearInterval(interval);
  }, [fetchProcesses]);

  async function handleAction(
    name: string,
    action: "restart" | "stop" | "start",
  ) {
    try {
      await apiFetch(`/api/processes/${name}/${action}`, { method: "POST" });

      if (action === "restart" || action === "start") {
        setRestartHistory((h) =>
          [
            { name, timestamp: Date.now(), reason: "manual" as const },
            ...h,
          ].slice(0, MAX_HISTORY),
        );
      }

      setTimeout(fetchProcesses, action === "stop" ? 1000 : 2000);
    } catch {
      setError(`Failed to ${action} ${name}`);
    }
  }

  const groups = groupProcesses(processes);

  if (loading) return <LoadingState />;

  let runningIndex = 0;

  return (
    <div className="max-w-[1200px]">
      <PageHeader
        title="Processes"
        count={processes.length}
        actions={
          <Button variant="secondary" size="sm" onClick={fetchProcesses}>
            Refresh
          </Button>
        }
      />

      {error && (
        <div className="bg-danger-subtle border border-danger/20 rounded-lg px-4 py-3 text-danger text-sm mb-5">
          {error}
        </div>
      )}

      <CrashLoopBanner processes={processes} />

      <HealthBar processes={processes} />

      {processes.length === 0 && !error && (
        <EmptyState description="No processes have registered yet." />
      )}

      {groups.map((g) => {
        const idx = runningIndex;
        runningIndex += g.processes.length;
        return (
          <GroupSection
            key={g.label}
            group={g}
            startIndex={idx}
            onAction={handleAction}
          />
        );
      })}

      <RestartHistory events={restartHistory} />
    </div>
  );
}
