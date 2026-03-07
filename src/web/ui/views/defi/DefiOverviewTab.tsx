import React, { useState, useEffect } from "react";
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

interface CategoryRow {
  readonly name: string;
  readonly tvl: number;
  readonly protocols_count: number;
}

interface ChainTvlRow {
  readonly id: string;
  readonly name: string;
  readonly tvl: number;
  readonly protocols_count: number;
}

interface OverviewData {
  readonly movers: ProtocolRow[];
  readonly categories: CategoryRow[];
  readonly chains: ChainTvlRow[];
}

export default function DefiOverviewTab() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    try {
      const [moversRes, categoriesRes, chainsRes] = await Promise.all([
        apiFetch<{ success: boolean; data: ProtocolRow[] }>(
          "/api/defi/movers?limit=10",
        ),
        apiFetch<{ success: boolean; data: CategoryRow[] }>(
          "/api/defi/categories",
        ),
        apiFetch<{ success: boolean; data: ChainTvlRow[] }>(
          "/api/defi/chains?limit=15",
        ),
      ]);
      setData({
        movers: moversRes.success ? moversRes.data : [],
        categories: categoriesRes.success ? categoriesRes.data : [],
        chains: chainsRes.success ? chainsRes.data : [],
      });
      setError("");
    } catch {
      setError("Failed to load overview data");
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <LoadingState message="Loading overview..." />;
  if (error)
    return (
      <div className="text-danger text-sm px-4 py-3 rounded-lg bg-danger/5 border border-danger/20">
        {error}
      </div>
    );
  if (!data) return <EmptyState description="No data available." />;

  const maxCategoryTvl = Number(data.categories[0]?.tvl) || 1;

  return (
    <div className="flex flex-col gap-6">
      {/* Top Movers — full width */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-widest text-faint mb-3">
          Top Movers
        </h3>
        {data.movers.length === 0 ? (
          <EmptyState description="No movers data." />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-border bg-bg-1/50">
                  <th className={cn(TH, "text-right w-10")}>#</th>
                  <th className={cn(TH, "text-left")}>Protocol</th>
                  <th className={cn(TH, "text-right")}>TVL</th>
                  <th className={cn(TH, "text-right")}>24h %</th>
                  <th className={cn(TH, "text-right")}>7d %</th>
                  <th className={cn(TH, "text-left max-md:hidden")}>
                    Category
                  </th>
                  <th className={cn(TH, "text-left max-md:hidden")}>Chain</th>
                </tr>
              </thead>
              <tbody>
                {data.movers.map((p, idx) => {
                  const pct1d = formatPct(p.change_1d);
                  const pct7d = formatPct(p.change_7d);
                  return (
                    <tr
                      key={p.id}
                      className="border-b border-border/50 hover:bg-bg-1 transition-colors cursor-pointer"
                      style={{
                        animationDelay: `${Math.min(idx * 20, 400)}ms`,
                      }}
                      onClick={() =>
                        p.url &&
                        window.open(p.url, "_blank", "noopener,noreferrer")
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
                        <span className="font-semibold text-strong text-[13px]">
                          {p.name}
                        </span>
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
                      <td className={cn(TD, "text-left max-md:hidden")}>
                        <span className="text-[11px] text-muted">
                          {p.category}
                        </span>
                      </td>
                      <td className={cn(TD, "text-left max-md:hidden")}>
                        <ChainBadge chain={p.chain} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Categories + Chains side-by-side */}
      <div className="grid grid-cols-2 max-lg:grid-cols-1 gap-6">
        {/* Categories */}
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-faint mb-3">
            Categories
          </h3>
          {data.categories.length === 0 ? (
            <EmptyState description="No category data." />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border bg-bg-1/50">
                    <th className={cn(TH, "text-left")}>Category</th>
                    <th className={cn(TH, "text-right")}>TVL</th>
                    <th className={cn(TH, "text-right")}>Protocols</th>
                  </tr>
                </thead>
                <tbody>
                  {data.categories.map((cat, idx) => {
                    const pct = maxCategoryTvl > 0 ? (Number(cat.tvl) / maxCategoryTvl) * 100 : 0;
                    return (
                      <tr
                        key={cat.name}
                        className="border-b border-border/50 hover:bg-bg-1 transition-colors"
                        style={{
                          animationDelay: `${Math.min(idx * 20, 400)}ms`,
                        }}
                      >
                        <td className={cn(TD, "text-left")}>
                          <div className="flex flex-col gap-1">
                            <span className="text-[13px] text-foreground font-medium">
                              {cat.name}
                            </span>
                            <div className="w-full h-0.5 rounded-full bg-bg-3 overflow-hidden">
                              <div
                                className="h-full bg-accent/50 rounded-full"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        </td>
                        <td
                          className={cn(
                            TD,
                            "text-right font-mono text-[13px] text-foreground tabular-nums",
                          )}
                        >
                          {formatTvl(cat.tvl)}
                        </td>
                        <td
                          className={cn(
                            TD,
                            "text-right font-mono text-[13px] text-muted tabular-nums",
                          )}
                        >
                          {cat.protocols_count}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Chain TVL */}
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-faint mb-3">
            Chain TVL
          </h3>
          {data.chains.length === 0 ? (
            <EmptyState description="No chain data." />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border bg-bg-1/50">
                    <th className={cn(TH, "text-right w-10")}>#</th>
                    <th className={cn(TH, "text-left")}>Chain</th>
                    <th className={cn(TH, "text-right")}>TVL</th>
                    <th className={cn(TH, "text-right")}>Protocols</th>
                  </tr>
                </thead>
                <tbody>
                  {data.chains.map((chain, idx) => (
                    <tr
                      key={chain.id}
                      className="border-b border-border/50 hover:bg-bg-1 transition-colors"
                      style={{
                        animationDelay: `${Math.min(idx * 20, 400)}ms`,
                      }}
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
                        <ChainBadge chain={chain.name} />
                      </td>
                      <td
                        className={cn(
                          TD,
                          "text-right font-mono text-[13px] text-foreground tabular-nums",
                        )}
                      >
                        {formatTvl(chain.tvl)}
                      </td>
                      <td
                        className={cn(
                          TD,
                          "text-right font-mono text-[13px] text-muted tabular-nums",
                        )}
                      >
                        {chain.protocols_count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
