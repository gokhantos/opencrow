import { useState, useEffect } from "react";
import { cn } from "../../lib/cn";
import { apiFetch } from "../../api";
import { LoadingState, EmptyState } from "../../components";
import { TH, TD, formatTvl, formatPct } from "./shared";

interface BridgeRow {
  readonly id: string;
  readonly display_name: string;
  readonly last_24h: number | null;
  readonly prev_day: number | null;
}

export default function BridgesTab() {
  const [bridges, setBridges] = useState<BridgeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    try {
      const res = await apiFetch<{ success: boolean; data: BridgeRow[] }>(
        "/api/defi/bridges?limit=50",
      );
      if (res.success) setBridges(res.data);
      setError("");
    } catch {
      setError("Failed to load bridge data");
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <LoadingState message="Loading bridges..." />;
  if (error)
    return (
      <div className="text-danger text-sm px-4 py-3 rounded-lg bg-danger/5 border border-danger/20">
        {error}
      </div>
    );
  if (bridges.length === 0) return <EmptyState description="No bridge data found." />;

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-border bg-bg-1/50">
            <th className={cn(TH, "text-right w-10")}>#</th>
            <th className={cn(TH, "text-left")}>Bridge</th>
            <th className={cn(TH, "text-right")}>24h Volume</th>
            <th className={cn(TH, "text-right")}>Previous Day</th>
            <th className={cn(TH, "text-right")}>Change</th>
          </tr>
        </thead>
        <tbody>
          {bridges.map((bridge, idx) => {
            const changeVal =
              bridge.prev_day && bridge.prev_day > 0 && bridge.last_24h != null
                ? ((bridge.last_24h - bridge.prev_day) / bridge.prev_day) * 100
                : null;
            const pct = formatPct(changeVal);
            return (
              <tr
                key={bridge.id}
                className="border-b border-border/50 hover:bg-bg-1 transition-colors"
                style={{ animationDelay: `${Math.min(idx * 20, 400)}ms` }}
              >
                <td
                  className={cn(
                    TD,
                    "text-right text-faint font-mono text-xs w-10",
                  )}
                >
                  {idx + 1}
                </td>
                <td className={cn(TD, "text-left")}>
                  <span className="font-semibold text-strong text-[13px]">
                    {bridge.display_name}
                  </span>
                </td>
                <td
                  className={cn(
                    TD,
                    "text-right font-mono text-[13px] text-foreground tabular-nums",
                  )}
                >
                  {formatTvl(bridge.last_24h)}
                </td>
                <td
                  className={cn(
                    TD,
                    "text-right font-mono text-[13px] text-muted tabular-nums",
                  )}
                >
                  {formatTvl(bridge.prev_day)}
                </td>
                <td className={cn(TD, "text-right")}>
                  <span
                    className={cn(
                      "font-mono text-[13px] font-semibold tabular-nums",
                      pct.className,
                    )}
                  >
                    {pct.text}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
