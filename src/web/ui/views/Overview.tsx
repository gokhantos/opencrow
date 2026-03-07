import React, { useState, useEffect, useCallback } from "react";
import { apiFetch, getToken, setToken, clearToken } from "../api";
import { formatUptime } from "../lib/format";
import { cn } from "../lib/cn";
import { PageHeader, Button, Input, StatusBadge } from "../components";
import { Clock, Users, Zap, Shield, Wifi, WifiOff, Key, MessageCircle, Send } from "lucide-react";
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

  // Initial fetch + fallback polling when WS is disconnected
  useEffect(() => {
    fetchStatus();
    if (!wsConnected) {
      const interval = setInterval(fetchStatus, 10000);
      return () => clearInterval(interval);
    }
  }, [wsConnected]);

  async function fetchStatus() {
    try {
      const data = await apiFetch<StatusData>("/api/status");
      setStatus(data);
      setError("");
    } catch {
      setError("Failed to load status");
    }
  }

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
  const connectedCount = channelEntries.filter(
    ([, v]) => v.status === "connected",
  ).length;
  const allConnected =
    channelEntries.length > 0 && connectedCount === channelEntries.length;
  const anyConnected = connectedCount > 0;

  const statusLabel = allConnected
    ? "Online"
    : anyConnected
      ? "Partial"
      : status
        ? "Offline"
        : "\u2014";

  const statusVariant = allConnected
    ? "green"
    : anyConnected
      ? "yellow"
      : status
        ? "red"
        : "gray";

  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle={
          status
            ? `v${status.version} \u00b7 ${channelEntries.length} channels \u00b7 ${status.sessions} sessions`
            : undefined
        }
      />

      {error && (
        <div className="bg-danger-subtle border border-danger/20 rounded-lg px-4 py-3 text-danger text-sm mb-6">
          {error}
        </div>
      )}

      {/* Stat Cards */}
      <div className="grid grid-cols-4 max-md:grid-cols-2 max-sm:grid-cols-1 gap-4 mb-8">
        <StatCard icon={<Zap size={16} />} label="Status">
          <StatusBadge status={statusLabel} variant={statusVariant as "green" | "yellow" | "red" | "gray"} />
        </StatCard>
        <StatCard icon={<Clock size={16} />} label="Uptime">
          <span className="font-mono text-sm text-strong">
            {status ? formatUptime(status.uptime) : "\u2014"}
          </span>
        </StatCard>
        <StatCard icon={<Users size={16} />} label="Sessions">
          <span className="font-mono text-sm text-strong">
            {status ? String(status.sessions) : "\u2014"}
          </span>
        </StatCard>
        <StatCard icon={<Shield size={16} />} label="Version">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-strong">
              {status ? `v${status.version}` : "\u2014"}
            </span>
            {status?.authEnabled && (
              <span className="text-[10px] font-semibold text-success bg-success-subtle px-1.5 py-0.5 rounded uppercase tracking-wide">
                Auth
              </span>
            )}
          </div>
        </StatCard>
      </div>

      {/* Channels */}
      {channelEntries.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-faint m-0">
              Channels
            </h3>
            <span className="font-mono text-sm font-medium text-muted bg-bg-2 px-2.5 py-1 rounded-md">
              {connectedCount}/{channelEntries.length}
            </span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
            {channelEntries.map(([name, info]) => {
              const connected = info.status === "connected";
              return (
                <div
                  key={name}
                  className={cn(
                    "flex items-center gap-3 px-4 py-3 rounded-lg bg-bg-1 border border-border transition-colors hover:border-border-2",
                    !connected && "opacity-60",
                  )}
                >
                  {connected ? (
                    <Wifi size={14} className="text-success shrink-0" />
                  ) : (
                    <WifiOff size={14} className="text-danger shrink-0" />
                  )}
                  <span className="text-sm font-semibold text-strong capitalize flex-1 truncate">
                    {name.replace("Agent:", "").replace("agent:", "")}
                  </span>
                  <ChannelTypeBadges type={info.type} />
                  <span
                    className={cn(
                      "text-xs font-mono capitalize",
                      connected ? "text-success" : "text-danger",
                    )}
                  >
                    {info.status}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Token Management */}
      {status?.authEnabled && (
        <div className="mb-8">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-faint mb-4">
            Access Token
          </h3>
          {getToken() ? (
            <div className="flex items-center justify-between px-4 py-3 rounded-lg bg-bg-1 border border-border">
              <div className="flex items-center gap-3">
                <Key size={14} className="text-success shrink-0" />
                <span className="text-sm text-foreground">
                  Token configured
                </span>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  clearToken();
                  setTokenMsg("Token cleared. Refresh to re-enter.");
                }}
              >
                Clear token
              </Button>
            </div>
          ) : (
            <form
              onSubmit={handleTokenSave}
              className="px-4 py-4 rounded-lg bg-bg-1 border border-border"
            >
              <div className="flex gap-3">
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
              </div>
              {tokenMsg && (
                <p className="text-danger text-sm mt-2">{tokenMsg}</p>
              )}
            </form>
          )}
          {tokenMsg && getToken() && (
            <p className="text-muted text-sm mt-2">{tokenMsg}</p>
          )}
        </div>
      )}
    </div>
  );
}

function ChannelTypeBadges({ type }: { readonly type: string }) {
  const types = type.split("+");
  return (
    <div className="flex items-center gap-1 shrink-0">
      {types.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted bg-bg-2 px-1.5 py-0.5 rounded"
          title={t}
        >
          {t === "telegram" ? <Send size={10} /> : <MessageCircle size={10} />}
          {t === "telegram" ? "TG" : "WA"}
        </span>
      ))}
    </div>
  );
}

function StatCard({
  icon,
  label,
  children,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-4 rounded-lg bg-bg-1 border border-border transition-colors hover:border-border-2">
      <div className="w-9 h-9 rounded-md flex items-center justify-center shrink-0 bg-bg-2 text-muted border border-border">
        {icon}
      </div>
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">
          {label}
        </span>
        {children}
      </div>
    </div>
  );
}
