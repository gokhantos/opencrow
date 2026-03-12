import { useState, useEffect } from "react";
import { cn } from "../../lib/cn";
import { apiFetch } from "../../api";
import { LoadingState, EmptyState } from "../../components";
import { TH, TD, formatTvl, formatDate } from "./shared";

interface EmissionRow {
  readonly id: string;
  readonly name: string;
  readonly token: string | null;
  readonly next_event: number | null;
  readonly next_event_amount: number | null;
  readonly daily_unlocks: number | null;
  readonly circulating_supply: number | null;
  readonly market_cap: number | null;
}

function NextUnlockCell({ epoch }: { readonly epoch: number | null }) {
  if (epoch == null) return <span className="text-faint font-mono text-[12px]">—</span>;

  const now = Date.now() / 1000;
  const sevenDays = 7 * 24 * 60 * 60;
  const isImminent = epoch - now < sevenDays && epoch > now;

  return (
    <span
      className={cn(
        "font-mono text-[12px] tabular-nums",
        isImminent ? "text-warning font-semibold" : "text-muted",
      )}
    >
      {formatDate(epoch)}
    </span>
  );
}

export default function EmissionsTab() {
  const [emissions, setEmissions] = useState<EmissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    try {
      const res = await apiFetch<{ success: boolean; data: EmissionRow[] }>(
        "/api/defi/emissions?limit=50&hasUpcoming=true",
      );
      if (res.success) setEmissions(res.data);
      setError("");
    } catch {
      setError("Failed to load emissions data");
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <LoadingState message="Loading emissions..." />;
  if (error)
    return (
      <div className="text-danger text-sm px-4 py-3 rounded-lg bg-danger/5 border border-danger/20">
        {error}
      </div>
    );
  if (emissions.length === 0)
    return <EmptyState description="No upcoming token unlocks found." />;

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-border bg-bg-1/50">
            <th className={cn(TH, "text-left")}>Protocol</th>
            <th className={cn(TH, "text-left")}>Token</th>
            <th className={cn(TH, "text-left")}>Next Unlock</th>
            <th className={cn(TH, "text-right")}>Unlock Amount</th>
            <th className={cn(TH, "text-right max-md:hidden")}>Daily</th>
            <th className={cn(TH, "text-right max-md:hidden")}>Circulating</th>
            <th className={cn(TH, "text-right max-md:hidden")}>Market Cap</th>
          </tr>
        </thead>
        <tbody>
          {emissions.map((em, idx) => (
            <tr
              key={em.id}
              className="border-b border-border/50 hover:bg-bg-1 transition-colors"
              style={{ animationDelay: `${Math.min(idx * 20, 400)}ms` }}
            >
              <td className={cn(TD, "text-left")}>
                <span className="font-semibold text-strong text-[13px]">
                  {em.name}
                </span>
              </td>
              <td className={cn(TD, "text-left")}>
                {em.token ? (
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider leading-none bg-accent/10 text-accent">
                    {em.token}
                  </span>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </td>
              <td className={cn(TD, "text-left")}>
                <NextUnlockCell epoch={em.next_event} />
              </td>
              <td
                className={cn(
                  TD,
                  "text-right font-mono text-[13px] text-foreground tabular-nums",
                )}
              >
                {formatTvl(em.next_event_amount)}
              </td>
              <td
                className={cn(
                  TD,
                  "text-right font-mono text-[13px] text-muted tabular-nums max-md:hidden",
                )}
              >
                {formatTvl(em.daily_unlocks)}
              </td>
              <td
                className={cn(
                  TD,
                  "text-right font-mono text-[13px] text-muted tabular-nums max-md:hidden",
                )}
              >
                {formatTvl(em.circulating_supply)}
              </td>
              <td
                className={cn(
                  TD,
                  "text-right font-mono text-[13px] text-muted tabular-nums max-md:hidden",
                )}
              >
                {formatTvl(em.market_cap)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
