import { EmptyState, LoadingState } from "../../components";
import { usePolledFetch } from "../../hooks/usePolledFetch";
import { cn } from "../../lib/cn";
import { ChainBadge, ErrorState, formatPct, formatTvl, TD, TH } from "./shared";

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
  const { data, loading, error, refetch } = usePolledFetch<{
    success: boolean;
    data: ProtocolRow[];
  }>("/api/defi/protocols?limit=100", { intervalMs: 60_000 });

  const protocols = data?.success ? data.data : [];

  if (loading) return <LoadingState message="Loading protocols..." />;
  if (error) return <ErrorState message="Failed to load protocols" onRetry={refetch} />;
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
                className="border-b border-border/50 hover:bg-bg-1 transition-colors"
                style={{ animationDelay: `${Math.min(idx * 20, 400)}ms` }}
              >
                <td className={cn(TD, "text-right text-faint font-mono text-xs w-10")}>
                  {idx + 1}
                </td>
                <td className={cn(TD, "text-left")}>
                  <div className="flex flex-col gap-0.5">
                    {p.url ? (
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-strong text-[13px] hover:text-accent transition-colors"
                      >
                        {p.name}
                      </a>
                    ) : (
                      <span className="font-semibold text-strong text-[13px]">{p.name}</span>
                    )}
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
                  <span className={cn("font-mono text-[13px] tabular-nums", pct7d.className)}>
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
