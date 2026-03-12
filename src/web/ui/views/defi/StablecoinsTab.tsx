import { useState, useEffect } from "react";
import { cn } from "../../lib/cn";
import { apiFetch } from "../../api";
import { LoadingState, EmptyState } from "../../components";
import { TH, TD, formatTvl } from "./shared";

interface StablecoinRow {
  readonly id: string;
  readonly name: string;
  readonly symbol: string;
  readonly peg_type: string;
  readonly circulating: number | null;
  readonly price: number | null;
}

function PriceCell({ price }: { readonly price: number | string | null }) {
  const num = Number(price);
  if (price == null || !isFinite(num)) return <span className="text-faint font-mono text-[13px]">—</span>;

  const deviation = Math.abs(num - 1.0);
  const className =
    deviation <= 0.005
      ? "text-success"
      : deviation <= 0.02
        ? "text-warning"
        : "text-danger";

  return (
    <span className={cn("font-mono text-[13px] font-semibold tabular-nums", className)}>
      ${num.toFixed(4)}
    </span>
  );
}

function PegBadge({ pegType }: { readonly pegType: string }) {
  const label = pegType.replace("peggedUSD", "USD").replace("peggedEUR", "EUR");
  return (
    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider leading-none bg-bg-3 text-muted">
      {label}
    </span>
  );
}

export default function StablecoinsTab() {
  const [stablecoins, setStablecoins] = useState<StablecoinRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    try {
      const res = await apiFetch<{ success: boolean; data: StablecoinRow[] }>(
        "/api/defi/stablecoins?limit=50",
      );
      if (res.success) setStablecoins(res.data);
      setError("");
    } catch {
      setError("Failed to load stablecoin data");
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <LoadingState message="Loading stablecoins..." />;
  if (error)
    return (
      <div className="text-danger text-sm px-4 py-3 rounded-lg bg-danger/5 border border-danger/20">
        {error}
      </div>
    );
  if (stablecoins.length === 0) return <EmptyState description="No stablecoin data found." />;

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-border bg-bg-1/50">
            <th className={cn(TH, "text-right w-10")}>#</th>
            <th className={cn(TH, "text-left")}>Stablecoin</th>
            <th className={cn(TH, "text-left")}>Peg Type</th>
            <th className={cn(TH, "text-right")}>Circulating</th>
            <th className={cn(TH, "text-right")}>Price</th>
          </tr>
        </thead>
        <tbody>
          {stablecoins.map((coin, idx) => (
            <tr
              key={coin.id}
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
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-strong text-[13px]">
                    {coin.name}
                  </span>
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider leading-none bg-accent/10 text-accent">
                    {coin.symbol}
                  </span>
                </div>
              </td>
              <td className={cn(TD, "text-left")}>
                <PegBadge pegType={coin.peg_type} />
              </td>
              <td
                className={cn(
                  TD,
                  "text-right font-mono text-[13px] text-foreground tabular-nums",
                )}
              >
                {formatTvl(coin.circulating)}
              </td>
              <td className={cn(TD, "text-right")}>
                <PriceCell price={coin.price} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
