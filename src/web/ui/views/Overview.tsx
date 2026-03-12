import React, { useState, useEffect, useCallback } from "react";
import { apiFetch, getToken, setToken, clearToken } from "../api";
import { formatUptime } from "../lib/format";
import { cn } from "../lib/cn";
import { Button, Input } from "../components";
import { Clock, Users, Shield, Key, Send, MessageCircle, Zap } from "lucide-react";
import { useSystemEvents } from "../hooks/useSystemEvents";

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

export default function Overview() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [error, setError] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [tokenMsg, setTokenMsg] = useState("");

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

  useEffect(() => {
    fetchStatus();
    if (!wsConnected) {
      const interval = setInterval(fetchStatus, 10000);
      return () => clearInterval(interval);
    }
  }, [wsConnected, fetchStatus]);

  async function handleTokenSave(e: React.FormEvent) {
    e.preventDefault();
    if (!tokenInput.trim()) return;
    setToken(tokenInput.trim());
    try {
      await apiFetch<StatusData>("/api/status");
      setTokenMsg("Token saved.");
      setTokenInput("");
    } catch {
      clearToken();
      setTokenMsg("Invalid token.");
    }
  }

  const channelEntries = status ? Object.entries(status.channels) : [];
  const { label: statusLabel, variant: statusVariant, connectedCount } =
    deriveStatus(status, channelEntries);

  return (
    <div className="ov-root">
      {/* Hero */}
      <div className="ov-hero">
        <div className="ov-orb-wrap">
          <div className="ov-orb-ring-outer" />
          <div className="ov-orb-ring" />
          <div className={`ov-orb ov-orb--${statusVariant}`}>
            <Zap size={28} color="rgba(255,255,255,0.7)" strokeWidth={2.5} />
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

      {/* Bento Stats */}
      <div className="ov-bento">
        {/* Status — wide */}
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

        {/* Uptime — wide */}
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

        {/* Sessions — narrow */}
        <div className="ov-card ov-card--sessions">
          <div className="ov-card-label">
            <Users size={11} />
            Sessions
          </div>
          <div className="ov-card-value">
            {status ? String(status.sessions) : "\u2014"}
          </div>
        </div>

        {/* Version — narrow */}
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
