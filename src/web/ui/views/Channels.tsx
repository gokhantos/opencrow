import { useState, useEffect } from "react";
import {
  apiFetch,
  enableChannel,
  disableChannel,
  restartChannel,
} from "../api";
import ChannelSetupForm from "./ChannelSetupForm";
import { LoadingState, Button, StatusBadge, Toggle } from "../components";
import { cn } from "../lib/cn";

interface ChannelMeta {
  id: string;
  label: string;
  icon: string;
  order: number;
}

interface ChannelSnapshot {
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  lastError?: string | null;
  allowedUserIds?: number[];
  [key: string]: unknown;
}

interface ChannelEntry {
  id: string;
  meta: ChannelMeta;
  capabilities: { media: boolean; groups: boolean };
  snapshot: ChannelSnapshot;
}

interface ChannelsResponse {
  success: boolean;
  data: ChannelEntry[];
}

const channelStatusMap: Record<string, string> = {
  Connected: "green",
  Disabled: "gray",
  Disconnected: "red",
  "Not configured": "yellow",
};

function getChannelStatus(snapshot: ChannelSnapshot): string {
  if (!snapshot.enabled) return "Disabled";
  if (snapshot.connected) return "Connected";
  if (!snapshot.configured) return "Not configured";
  return "Disconnected";
}

function ChannelCard({
  entry,
  onRefresh,
}: {
  entry: ChannelEntry;
  onRefresh: () => void;
}) {
  const [showSetup, setShowSetup] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const { meta, snapshot } = entry;
  const statusLabel = getChannelStatus(snapshot);

  async function handleToggle() {
    setActionLoading(true);
    try {
      if (snapshot.enabled) {
        await disableChannel(meta.id);
      } else {
        await enableChannel(meta.id);
      }
      onRefresh();
    } catch {
      // error handled by refresh
    } finally {
      setActionLoading(false);
    }
  }

  async function handleRestart() {
    setActionLoading(true);
    try {
      await restartChannel(meta.id);
      onRefresh();
    } catch {
      // error handled by refresh
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <div className="bg-bg-1 border border-border rounded-lg p-6 transition-colors hover:border-border-2">
      <div className="flex items-center gap-4 mb-5">
        <div className="text-2xl leading-none shrink-0">{meta.icon}</div>
        <div className="flex-1">
          <div className="text-base font-semibold text-strong mb-1">
            {meta.label}
          </div>
          <StatusBadge status={statusLabel} colorMap={channelStatusMap} />
        </div>
      </div>

      <div className="flex flex-col gap-3 mb-5 text-sm">
        <div className="flex items-center justify-between py-1 border-b border-border">
          <span className="text-faint text-sm font-medium">Enabled</span>
          <Toggle
            checked={snapshot.enabled}
            onChange={handleToggle}
            disabled={actionLoading}
          />
        </div>

        <div className="flex items-center justify-between py-1 border-b border-border">
          <span className="text-faint text-sm font-medium">Connected</span>
          <span className="flex items-center gap-3 text-sm">
            <span
              className={cn(
                "inline-block w-2 h-2 rounded-full shrink-0",
                snapshot.connected ? "bg-success" : "bg-danger",
              )}
            />
            {snapshot.connected ? "Yes" : "No"}
          </span>
        </div>

        {snapshot.lastError && (
          <div className="flex items-center justify-between py-1 border-b border-border">
            <span className="text-faint text-sm font-medium">Error</span>
            <span className="text-danger text-sm">{snapshot.lastError}</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setShowSetup((s) => !s)}
        >
          {showSetup ? "Hide" : "Configure"}
        </Button>
        {snapshot.enabled && snapshot.connected && (
          <Button
            variant="secondary"
            size="sm"
            onClick={handleRestart}
            disabled={actionLoading}
          >
            Restart
          </Button>
        )}
      </div>

      {showSetup && (
        <div className="mt-4 pt-4 border-t border-border">
          <ChannelSetupForm
            channelId={meta.id}
            snapshot={snapshot as Record<string, unknown>}
            onSaved={() => {
              setShowSetup(false);
              onRefresh();
            }}
          />
        </div>
      )}
    </div>
  );
}

export default function Channels() {
  const [channels, setChannels] = useState<ChannelEntry[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchChannels();
    const interval = setInterval(fetchChannels, 5000);
    return () => clearInterval(interval);
  }, []);

  async function fetchChannels() {
    try {
      const res = await apiFetch<ChannelsResponse>("/api/channels");
      setChannels(res.data);
      setError("");
    } catch {
      setError("Failed to load channel data");
    }
  }

  if (error) {
    return <p className="text-danger">{error}</p>;
  }

  if (!channels) {
    return <LoadingState />;
  }

  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-widest text-faint mb-5">
        Channel Status
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
        {channels.map((entry) => (
          <ChannelCard key={entry.id} entry={entry} onRefresh={fetchChannels} />
        ))}
      </div>
    </div>
  );
}
