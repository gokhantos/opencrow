import React, { useState, useEffect, useCallback } from "react";
import { apiFetch, getToken, setToken, clearToken } from "../api";
import { formatUptime, formatNumber, formatCountdown } from "../lib/format";
import { cn } from "../lib/cn";
import { Button, Input } from "../components";
import {
  Clock, Users, Shield, Key, Send, MessageCircle, Zap,
  Bot, Cpu, DollarSign, Database, Timer, Activity,
  CheckCircle, AlertTriangle, XCircle,
} from "lucide-react";
import { useSystemEvents } from "../hooks/useSystemEvents";

/* ─── API response types ─── */

interface ChannelInfo {
  status: string;
  type: string;
}

interface StatusData {
  uptime: number;
  authEnabled: boolean;
  version: string;
  sessions: number;
  channels: Record<string, ChannelInfo>;
}

interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  totalRequests: number;
}

interface CronStatus {
  running: boolean;
  jobCount: number;
  nextDueAt: number | null;
}

interface ProcessHealth {
  name: string;
  status: "alive" | "stale" | "dead";
  uptimeSeconds: number;
  restartCount?: number;
}

interface MemoryStats {
  totalSources: number;
  totalChunks: number;
  totalTokens: number;
  agentsWithMemory: number;
}

interface AgentItem {
  id: string;
  name: string;
}

/* ─── Helpers ─── */

type SystemStatus = "online" | "partial" | "offline" | "loading";

function deriveStatus(
  status: StatusData | null,
  channelEntries: [string, ChannelInfo][],
): { label: string; variant: SystemStatus; connectedCount: number } {
  if (!status) return { label: "Loading", variant: "loading", connectedCount: 0 };

  const connectedCount = channelEntries.filter(
    ([, v]) => v.status === "connected",
  ).length;
  const allConnected =
    channelEntries.length > 0 && connectedCount === channelEntries.length;
  const anyConnected = connectedCount > 0;

  if (allConnected) return { label: "All Systems Online", variant: "online", connectedCount };
  if (anyConnected) return { label: "Partial Connectivity", variant: "partial", connectedCount };
  return { label: "Systems Offline", variant: "offline", connectedCount };
}

function uptimePercent(uptimeSeconds: number): number {
  const maxDisplay = 30 * 24 * 3600;
  return Math.min((uptimeSeconds / maxDisplay) * 100, 100);
}

function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

/* ─── Component ─── */

export default function Overview() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [error, setError] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [tokenMsg, setTokenMsg] = useState("");

  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [agents, setAgents] = useState<readonly AgentItem[] | null>(null);
  const [processes, setProcesses] = useState<readonly ProcessHealth[] | null>(null);
  const [cron, setCron] = useState<CronStatus | null>(null);
  const [memory, setMemory] = useState<MemoryStats | null>(null);

  const handleSystemEvent = useCallback(
    (event: { type: string; data: Record<string, unknown> }) => {
      if (event.type === "status") {
        setStatus(event.data as unknown as StatusData);
        setError("");
      }
    },
    [],
  );

  const { connected: wsConnected } = useSystemEvents(handleSystemEvent);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await apiFetch<StatusData>("/api/status");
      setStatus(data);
      setError("");
    } catch {
      setError("Failed to connect to system");
    }
  }, []);

  const fetchExtras = useCallback(async () => {
    const results = await Promise.allSettled([
      apiFetch<{ success: boolean; data: UsageSummary }>("/api/usage/summary"),
      apiFetch<{ success: boolean; data: readonly AgentItem[] }>("/api/agents"),
      apiFetch<{ data: readonly ProcessHealth[] }>("/api/processes"),
      apiFetch<{ success: boolean; data: CronStatus }>("/api/cron/status"),
      apiFetch<{ success: boolean; data: MemoryStats }>("/api/memory/debug/stats"),
    ]);

    if (results[0].status === "fulfilled") setUsage(results[0].value.data);
    if (results[1].status === "fulfilled") setAgents(results[1].value.data);
    if (results[2].status === "fulfilled") setProcesses(results[2].value.data);
    if (results[3].status === "fulfilled") setCron(results[3].value.data);
    if (results[4].status === "fulfilled") setMemory(results[4].value.data);
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchExtras();
    if (!wsConnected) {
      const interval = setInterval(fetchStatus, 10000);
      return () => clearInterval(interval);
    }
  }, [wsConnected, fetchStatus, fetchExtras]);

  async function handleTokenSave(e: React.FormEvent) {
    e.preventDefault();
    if (!tokenInput.trim()) return;
    setToken(tokenInput.trim());
    try {
      await apiFetch<StatusData>("/api/status");
      setTokenMsg("Token saved.");
      setTokenInput("");
      fetchExtras();
    } catch {
      clearToken();
      setTokenMsg("Invalid token.");
    }
  }

  const channelEntries = status ? Object.entries(status.channels) : [];
  const { label: statusLabel, variant: statusVariant, connectedCount } =
    deriveStatus(status, channelEntries);

  const aliveProcesses = processes?.filter((p) => p.status === "alive").length ?? 0;
  const totalProcesses = processes?.length ?? 0;
  const totalTokens = usage
    ? usage.totalInputTokens + usage.totalOutputTokens
    : null;

  return (
    <div className="ov-root">
      {/* Hero */}
      <div className="ov-hero">
        <div className="ov-orb-wrap">
          <div className="ov-orb-ring-outer" />
          <div className="ov-orb-ring" />
          <div className={`ov-orb ov-orb--${statusVariant}`}>
            <img
              src="/logo.png"
              alt="OpenCrow"
              className="ov-orb-logo"
            />
          </div>
        </div>

        <div className="ov-hero-text">
          <h2 className="ov-title">
            <span className="ov-title-gradient">OpenCrow</span>
          </h2>
          <div className="ov-subtitle">
            {status ? (
              <>
                <span>v{status.version}</span>
                <span className="ov-subtitle-sep">/</span>
                <span>{channelEntries.length} channels</span>
                <span className="ov-subtitle-sep">/</span>
                <span>{status.sessions} sessions</span>
                <span className="ov-subtitle-sep">/</span>
                <span className="ov-ws">
                  <span className={cn("ov-ws-dot", wsConnected ? "ov-ws-dot--on" : "ov-ws-dot--off")} />
                  {wsConnected ? "live" : "polling"}
                </span>
              </>
            ) : (
              <span>Connecting...</span>
            )}
          </div>
          <div className={`ov-hero-badge ov-hero-badge--${statusVariant}`}>
            <span className={`ov-hero-dot ov-hero-dot--${statusVariant}`} />
            {statusLabel}
          </div>
        </div>
      </div>

      {/* Error */}
      {error && <div className="ov-error" role="alert">{error}</div>}

      {/* Primary Stats — bento grid */}
      <div className="ov-bento">
        <div className="ov-card ov-card--status">
          <div className="ov-card-label">
            <Zap size={11} />
            System Status
          </div>
          <div className="ov-status-row">
            <span className={`ov-status-dot ov-status-dot--${statusVariant}`} />
            <span className="ov-card-value">
              {status ? (statusVariant === "online" ? "Operational" : statusVariant === "partial" ? "Degraded" : "Down") : "\u2014"}
            </span>
          </div>
          {channelEntries.length > 0 && (
            <div className="ov-card-meta">
              {connectedCount}/{channelEntries.length} channels active
            </div>
          )}
        </div>

        <div className="ov-card ov-card--uptime">
          <div className="ov-card-label">
            <Clock size={11} />
            Uptime
          </div>
          <div className="ov-card-value ov-card-value--mono">
            {status ? formatUptime(status.uptime) : "\u2014"}
          </div>
          {status && (
            <div
              className="ov-uptime-bar-wrap"
              role="progressbar"
              aria-valuenow={Math.round(uptimePercent(status.uptime))}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Uptime over 30 days"
            >
              <div
                className="ov-uptime-bar"
                style={{ width: `${uptimePercent(status.uptime)}%` }}
              />
            </div>
          )}
        </div>

        <div className="ov-card ov-card--sessions">
          <div className="ov-card-label">
            <Users size={11} />
            Sessions
          </div>
          <div className="ov-card-value">
            {status ? String(status.sessions) : "\u2014"}
          </div>
        </div>

        <div className="ov-card ov-card--version">
          <div className="ov-card-label">
            <Shield size={11} />
            Version
          </div>
          <div className="ov-card-value ov-card-value--sm">
            {status ? `v${status.version}` : "\u2014"}
          </div>
          {status?.authEnabled && (
            <div className="ov-card-meta ov-card-meta--success">
              Auth enabled
            </div>
          )}
        </div>
      </div>

      {/* Operational Data — second bento row */}
      <div className="ov-section">
        <div className="ov-section-head">
          <span className="ov-section-title">Operations</span>
          <span className="ov-section-line" />
        </div>
        <div className="ov-bento-ops">
          {/* Token Usage */}
          <div className="ov-card ov-card--usage">
            <div className="ov-card-label">
              <DollarSign size={11} />
              Token Usage
            </div>
            {usage ? (
              <>
                <div className="ov-card-value ov-card-value--mono">
                  {formatNumber(totalTokens ?? 0)}
                </div>
                <div className="ov-usage-breakdown">
                  <span className="ov-usage-item">
                    <span className="ov-usage-dot ov-usage-dot--input" />
                    {formatNumber(usage.totalInputTokens)} in
                  </span>
                  <span className="ov-usage-item">
                    <span className="ov-usage-dot ov-usage-dot--output" />
                    {formatNumber(usage.totalOutputTokens)} out
                  </span>
                </div>
                <div className="ov-card-meta">
                  {formatCost(usage.totalCostUsd)} spent · {formatNumber(usage.totalRequests)} requests
                </div>
              </>
            ) : (
              <div className="ov-card-value">{"\u2014"}</div>
            )}
          </div>

          {/* Agents */}
          <div className="ov-card ov-card--agents">
            <div className="ov-card-label">
              <Bot size={11} />
              Agents
            </div>
            <div className="ov-card-value">
              {agents ? String(agents.length) : "\u2014"}
            </div>
            <div className="ov-card-meta">
              registered
            </div>
          </div>

          {/* Processes */}
          <div className="ov-card ov-card--processes">
            <div className="ov-card-label">
              <Cpu size={11} />
              Processes
            </div>
            {processes ? (
              <>
                <div className="ov-process-grid">
                  {processes.map((p) => (
                    <div key={p.name} className="ov-process-row">
                      <ProcessIcon status={p.status} />
                      <span className="ov-process-name">{p.name}</span>
                      <span className="ov-process-uptime">
                        {formatUptime(p.uptimeSeconds)}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="ov-card-meta">
                  {aliveProcesses}/{totalProcesses} healthy
                </div>
              </>
            ) : (
              <div className="ov-card-value">{"\u2014"}</div>
            )}
          </div>

          {/* Cron */}
          <div className="ov-card ov-card--cron">
            <div className="ov-card-label">
              <Timer size={11} />
              Cron Jobs
            </div>
            {cron ? (
              <>
                <div className="ov-status-row">
                  <span className={cn(
                    "ov-status-dot",
                    cron.running ? "ov-status-dot--online" : "ov-status-dot--offline",
                  )} />
                  <span className="ov-card-value">
                    {cron.jobCount}
                  </span>
                </div>
                <div className="ov-card-meta">
                  {cron.running ? "scheduler active" : "scheduler stopped"}
                  {cron.nextDueAt ? ` · next in ${formatCountdown(cron.nextDueAt)}` : ""}
                </div>
              </>
            ) : (
              <div className="ov-card-value">{"\u2014"}</div>
            )}
          </div>

          {/* Memory */}
          {memory && (
            <div className="ov-card ov-card--memory">
              <div className="ov-card-label">
                <Database size={11} />
                Memory
              </div>
              <div className="ov-card-value ov-card-value--mono">
                {formatNumber(memory.totalChunks)}
              </div>
              <div className="ov-usage-breakdown">
                <span className="ov-usage-item">
                  <span className="ov-usage-dot ov-usage-dot--input" />
                  {memory.totalSources} sources
                </span>
                <span className="ov-usage-item">
                  <span className="ov-usage-dot ov-usage-dot--output" />
                  {memory.agentsWithMemory} agents
                </span>
              </div>
              <div className="ov-card-meta">
                {formatNumber(memory.totalTokens)} tokens indexed
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Channels */}
      {channelEntries.length > 0 && (
        <div className="ov-section">
          <div className="ov-section-head">
            <span className="ov-section-title">Channels</span>
            <span className="ov-section-count">
              {connectedCount}/{channelEntries.length}
            </span>
            <span className="ov-section-line" />
          </div>
          <div className="ov-channels">
            {channelEntries.map(([name, info], i) => {
              const connected = info.status === "connected";
              return (
                <div
                  key={name}
                  className={cn(
                    "ov-channel",
                    connected ? "ov-channel--connected" : "ov-channel--offline",
                  )}
                  style={{ animationDelay: `${i * 50}ms` }}
                >
                  <SignalBars />
                  <div className="ov-channel-info">
                    <div className="ov-channel-name">
                      {name.replace("Agent:", "").replace("agent:", "")}
                    </div>
                    <div className="ov-channel-status">{info.status}</div>
                  </div>
                  <ChannelTypeBadges type={info.type} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Token */}
      {status?.authEnabled && (
        <div className="ov-section">
          <div className="ov-section-head">
            <span className="ov-section-title">Access Token</span>
            <span className="ov-section-line" />
          </div>
          {getToken() ? (
            <div className="ov-token-card">
              <div className="ov-token-row">
                <Key size={14} className="text-success shrink-0" />
                <span className="ov-token-text">Token configured</span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    clearToken();
                    setTokenMsg("Token cleared. Refresh to re-enter.");
                  }}
                >
                  Clear
                </Button>
              </div>
              {tokenMsg && (
                <p className="ov-token-msg ov-token-msg--muted" aria-live="polite">
                  {tokenMsg}
                </p>
              )}
            </div>
          ) : (
            <div className="ov-token-card">
              <form onSubmit={handleTokenSave} className="ov-token-form">
                <Input
                  id="overview-token"
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="Enter access token..."
                />
                <Button type="submit" variant="primary" className="shrink-0">
                  Save
                </Button>
              </form>
              {tokenMsg && (
                <p className="ov-token-msg ov-token-msg--danger" aria-live="polite">
                  {tokenMsg}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Sub-components ─── */

function ProcessIcon({ status }: { readonly status: string }) {
  if (status === "alive") return <CheckCircle size={12} className="ov-process-icon--alive" />;
  if (status === "stale") return <AlertTriangle size={12} className="ov-process-icon--stale" />;
  return <XCircle size={12} className="ov-process-icon--dead" />;
}

function SignalBars() {
  return (
    <div className="ov-channel-signal">
      <span className="ov-signal-bar" />
      <span className="ov-signal-bar" />
      <span className="ov-signal-bar" />
      <span className="ov-signal-bar" />
    </div>
  );
}

const CHANNEL_TYPE_META: Record<string, { icon: React.ReactNode; label: string }> = {
  telegram: { icon: <Send size={9} />, label: "TG" },
  whatsapp: { icon: <MessageCircle size={9} />, label: "WA" },
};

function ChannelTypeBadges({ type }: { readonly type: string }) {
  const types = type.split("+");
  return (
    <div className="ov-channel-badges">
      {types.map((t) => {
        const meta = CHANNEL_TYPE_META[t] ?? {
          icon: <MessageCircle size={9} />,
          label: t.toUpperCase().slice(0, 3),
        };
        return (
          <span key={t} className="ov-channel-badge" title={t}>
            {meta.icon}
            {meta.label}
          </span>
        );
      })}
    </div>
  );
}
