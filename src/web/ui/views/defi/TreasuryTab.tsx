import { useState, useEffect } from "react";
import { cn } from "../../lib/cn";
import { apiFetch } from "../../api";
import { LoadingState, EmptyState } from "../../components";
import { TH, TD, formatTvl } from "./shared";

interface TreasuryRow {
  readonly id: string;
  readonly name: string;
  readonly total: number | null;
  readonly stablecoins: number | null;
  readonly majors: number | null;
  readonly own_tokens: number | null;
  readonly others: number | null;
}

function CompositionBar({ row }: { readonly row: TreasuryRow }) {
  const total = Number(row.total) || 0;
  if (total === 0) return null;

  const stablePct = (Number(row.stablecoins ?? 0) / total) * 100;
  const majorsPct = (Number(row.majors ?? 0) / total) * 100;
  const ownPct = (Number(row.own_tokens ?? 0) / total) * 100;
  const othersPct = (Number(row.others ?? 0) / total) * 100;

  return (
    <div className="flex h-1 w-full rounded-full overflow-hidden gap-px mt-1">
      {stablePct > 0 && (
        <div
          className="h-full bg-cyan/60"
          style={{ width: `${stablePct}%` }}
          title={`Stablecoins: ${stablePct.toFixed(1)}%`}
        />
      )}
      {majorsPct > 0 && (
        <div
          className="h-full bg-accent/60"
          style={{ width: `${majorsPct}%` }}
          title={`Majors: ${majorsPct.toFixed(1)}%`}
        />
      )}
      {ownPct > 0 && (
        <div
          className="h-full bg-purple/60"
          style={{ width: `${ownPct}%` }}
          title={`Own tokens: ${ownPct.toFixed(1)}%`}
        />
      )}
      {othersPct > 0 && (
        <div
          className="h-full bg-muted/30"
          style={{ width: `${othersPct}%` }}
          title={`Others: ${othersPct.toFixed(1)}%`}
        />
      )}
    </div>
  );
}

export default function TreasuryTab() {
  const [treasuries, setTreasuries] = useState<TreasuryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    try {
      const res = await apiFetch<{ success: boolean; data: TreasuryRow[] }>(
        "/api/defi/treasury?limit=50",
      );
      if (res.success) setTreasuries(res.data);
      setError("");
    } catch {
      setError("Failed to load treasury data");
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <LoadingState message="Loading treasury..." />;
  if (error)
    return (
      <div className="text-danger text-sm px-4 py-3 rounded-lg bg-danger/5 border border-danger/20">
        {error}
      </div>
    );
  if (treasuries.length === 0) return <EmptyState description="No treasury data found." />;

  return (
    <div>
      {/* Legend */}
      <div className="flex items-center gap-4 mb-4 px-1">
        <div className="flex items-center gap-1.5 text-[11px] text-muted">
          <div className="w-3 h-1.5 rounded-full bg-cyan/60" />
          Stablecoins
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted">
          <div className="w-3 h-1.5 rounded-full bg-accent/60" />
          Majors
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted">
          <div className="w-3 h-1.5 rounded-full bg-purple/60" />
          Own Tokens
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted">
          <div className="w-3 h-1.5 rounded-full bg-muted/30" />
          Others
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-border bg-bg-1/50">
              <th className={cn(TH, "text-right w-10")}>#</th>
              <th className={cn(TH, "text-left")}>Protocol</th>
              <th className={cn(TH, "text-right")}>Total</th>
              <th className={cn(TH, "text-right")}>Stablecoins</th>
              <th className={cn(TH, "text-right")}>Majors</th>
              <th className={cn(TH, "text-right max-md:hidden")}>Own Tokens</th>
              <th className={cn(TH, "text-right max-md:hidden")}>Others</th>
            </tr>
          </thead>
          <tbody>
            {treasuries.map((t, idx) => (
              <tr
                key={t.id}
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
                  <div className="flex flex-col min-w-[120px]">
                    <span className="font-semibold text-strong text-[13px]">
                      {t.name}
                    </span>
                    <CompositionBar row={t} />
                  </div>
                </td>
                <td
                  className={cn(
                    TD,
                    "text-right font-mono text-[13px] text-foreground tabular-nums font-semibold",
                  )}
                >
                  {formatTvl(t.total)}
                </td>
                <td
                  className={cn(
                    TD,
                    "text-right font-mono text-[13px] text-muted tabular-nums",
                  )}
                >
                  {formatTvl(t.stablecoins)}
                </td>
                <td
                  className={cn(
                    TD,
                    "text-right font-mono text-[13px] text-muted tabular-nums",
                  )}
                >
                  {formatTvl(t.majors)}
                </td>
                <td
                  className={cn(
                    TD,
                    "text-right font-mono text-[13px] text-muted tabular-nums max-md:hidden",
                  )}
                >
                  {formatTvl(t.own_tokens)}
                </td>
                <td
                  className={cn(
                    TD,
                    "text-right font-mono text-[13px] text-muted tabular-nums max-md:hidden",
                  )}
                >
                  {formatTvl(t.others)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
