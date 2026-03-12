import { useState, useEffect } from "react";
import { cn } from "../../lib/cn";
import { apiFetch } from "../../api";
import { LoadingState, EmptyState } from "../../components";
import { TH, TD, formatTvl, formatPct, ChainBadge } from "./shared";

interface ProtocolRow {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly chain: string;
  readonly tvl: number;
  readonly change_1d: number | null;
  readonly change_7d: number | null;
  readonly url: string;
}

export default function ProtocolsTab() {
  const [protocols, setProtocols] = useState<ProtocolRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    try {
      const res = await apiFetch<{ success: boolean; data: ProtocolRow[] }>(
        "/api/defi/protocols?limit=100",
      );
      if (res.success) setProtocols(res.data);
      setError("");
    } catch {
      setError("Failed to load protocols");
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <LoadingState message="Loading protocols..." />;
  if (error)
    return (
      <div className="text-danger text-sm px-4 py-3 rounded-lg bg-danger/5 border border-danger/20">
        {error}
      </div>
    );
  if (protocols.length === 0) return <EmptyState description="No protocols found." />;

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-border bg-bg-1/50">
            <th className={cn(TH, "text-right w-10")}>#</th>
            <th className={cn(TH, "text-left")}>Protocol</th>
            <th className={cn(TH, "text-left max-md:hidden")}>Chain</th>
            <th className={cn(TH, "text-right")}>TVL</th>
            <th className={cn(TH, "text-right")}>24h %</th>
            <th className={cn(TH, "text-right")}>7d %</th>
          </tr>
        </thead>
        <tbody>
          {protocols.map((p, idx) => {
            const pct1d = formatPct(p.change_1d);
            const pct7d = formatPct(p.change_7d);
            return (
              <tr
                key={p.id}
                className="border-b border-border/50 hover:bg-bg-1 transition-colors cursor-pointer group"
                style={{ animationDelay: `${Math.min(idx * 20, 400)}ms` }}
                onClick={() =>
                  p.url && window.open(p.url, "_blank", "noopener,noreferrer")
                }
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
                  <div className="flex flex-col gap-0.5">
                    <span className="font-semibold text-strong text-[13px] group-hover:text-accent transition-colors">
                      {p.name}
                    </span>
                    <span className="text-[11px] text-muted">{p.category}</span>
                  </div>
                </td>
                <td className={cn(TD, "text-left max-md:hidden")}>
                  <ChainBadge chain={p.chain} />
                </td>
                <td
                  className={cn(
                    TD,
                    "text-right font-mono text-[13px] text-foreground tabular-nums",
                  )}
                >
                  {formatTvl(p.tvl)}
                </td>
                <td className={cn(TD, "text-right")}>
                  <span
                    className={cn(
                      "font-mono text-[13px] font-semibold tabular-nums",
                      pct1d.className,
                    )}
                  >
                    {pct1d.text}
                  </span>
                </td>
                <td className={cn(TD, "text-right")}>
                  <span
                    className={cn(
                      "font-mono text-[13px] tabular-nums",
                      pct7d.className,
                    )}
                  >
                    {pct7d.text}
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
