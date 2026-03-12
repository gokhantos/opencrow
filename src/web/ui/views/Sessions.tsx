import { useState, useEffect } from "react";
import { apiFetch } from "../api";
import { formatTime } from "../lib/format";
import { LoadingState, EmptyState, PageHeader } from "../components";
import { cn } from "../lib/cn";

interface Session {
  id: string;
  channel: string;
  chatId: string;
  createdAt: number;
  updatedAt: number;
}

interface SessionsResponse {
  success: boolean;
  data: Session[];
}

export default function Sessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 10000);
    return () => clearInterval(interval);
  }, []);

  async function fetchSessions() {
    try {
      const data = await apiFetch<SessionsResponse>("/api/sessions");
      setSessions(data.data ?? []);
      setError("");
    } catch {
      setError("Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return <LoadingState />;
  }

  if (error) {
    return <p className="text-danger">{error}</p>;
  }

  if (sessions.length === 0) {
    return <EmptyState description="No active sessions" />;
  }

  return (
    <div>
      <PageHeader title="Active Sessions" count={sessions.length} />
      <div className="bg-bg-1 border border-border rounded-lg overflow-hidden">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="text-left px-4 py-3 bg-bg-2 text-faint text-xs font-semibold uppercase tracking-[0.1em] border-b border-border">
                Channel
              </th>
              <th className="text-left px-4 py-3 bg-bg-2 text-faint text-xs font-semibold uppercase tracking-[0.1em] border-b border-border">
                Chat ID
              </th>
              <th className="text-left px-4 py-3 bg-bg-2 text-faint text-xs font-semibold uppercase tracking-[0.1em] border-b border-border">
                Last Active
              </th>
              <th className="text-left px-4 py-3 bg-bg-2 text-faint text-xs font-semibold uppercase tracking-[0.1em] border-b border-border">
                Created
              </th>
              <th className="text-left px-4 py-3 bg-bg-2 text-faint text-xs font-semibold uppercase tracking-[0.1em] border-b border-border" />
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id} className="group">
                <td className="px-4 py-3 border-t border-border text-sm text-foreground group-hover:bg-bg-2">
                  <span
                    className={cn(
                      "inline-flex items-center px-3 py-0.5 rounded-full text-xs font-semibold tracking-wide",
                      s.channel === "telegram"
                        ? "bg-accent-subtle text-accent"
                        : "bg-bg-3 text-muted",
                    )}
                  >
                    {s.channel}
                  </span>
                </td>
                <td className="px-4 py-3 border-t border-border text-sm text-foreground font-mono group-hover:bg-bg-2">
                  {s.chatId.length > 30
                    ? `${s.chatId.slice(0, 30)}\u2026`
                    : s.chatId}
                </td>
                <td className="px-4 py-3 border-t border-border text-sm text-foreground group-hover:bg-bg-2">
                  {formatTime(s.updatedAt)}
                </td>
                <td className="px-4 py-3 border-t border-border text-sm text-foreground group-hover:bg-bg-2">
                  {formatTime(s.createdAt)}
                </td>
                <td className="px-4 py-3 border-t border-border text-sm text-foreground group-hover:bg-bg-2">
                  <a
                    className="bg-transparent border-none text-accent cursor-pointer text-sm p-0 hover:text-accent-hover"
                    href={`/chat/${encodeURIComponent(s.channel)}/${encodeURIComponent(s.chatId)}`}
                  >
                    Open
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
