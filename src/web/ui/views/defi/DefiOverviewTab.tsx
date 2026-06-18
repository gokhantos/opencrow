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

export default function DefiOverviewTab() {
  const moversResult = usePolledFetch<{ success: boolean; data: ProtocolRow[] }>(
    "/api/defi/movers?limit=10",
    { intervalMs: 60_000 },
  );
  const categoriesResult = usePolledFetch<{ success: boolean; data: CategoryRow[] }>(
    "/api/defi/categories",
    { intervalMs: 60_000 },
  );
  const chainsResult = usePolledFetch<{ success: boolean; data: ChainTvlRow[] }>(
    "/api/defi/chains?limit=15",
    { intervalMs: 60_000 },
  );

  const loading = moversResult.loading || categoriesResult.loading || chainsResult.loading;
  const error = moversResult.error ?? categoriesResult.error ?? chainsResult.error;

  const movers = moversResult.data?.success ? moversResult.data.data : [];
  const categories = categoriesResult.data?.success ? categoriesResult.data.data : [];
  const chains = chainsResult.data?.success ? chainsResult.data.data : [];

  const handleRetry = () => {
    moversResult.refetch();
    categoriesResult.refetch();
    chainsResult.refetch();
  };

  if (loading) return <LoadingState message="Loading overview..." />;
  if (error) return <ErrorState message="Failed to load overview data" onRetry={handleRetry} />;
  if (movers.length === 0 && categories.length === 0 && chains.length === 0)
    return <EmptyState description="No data available." />;

  const maxCategoryTvl = Number(categories[0]?.tvl) || 1;

  return (
    <div className="flex flex-col gap-6">
      {/* Top Movers — full width */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-widest text-faint mb-3">
          Top Movers
        </h3>
        {movers.length === 0 ? (
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
                  <th className={cn(TH, "text-left max-md:hidden")}>Category</th>
                  <th className={cn(TH, "text-left max-md:hidden")}>Chain</th>
                </tr>
              </thead>
              <tbody>
                {movers.map((p, idx) => {
                  const pct1d = formatPct(p.change_1d);
                  const pct7d = formatPct(p.change_7d);
                  return (
                    <tr
                      key={p.id}
                      className="border-b border-border/50 hover:bg-bg-1 transition-colors"
                      style={{
                        animationDelay: `${Math.min(idx * 20, 400)}ms`,
                      }}
                    >
                      <td className={cn(TD, "text-right text-faint font-mono text-xs w-10")}>
                        {idx + 1}
                      </td>
                      <td className={cn(TD, "text-left")}>
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
                      <td className={cn(TD, "text-left max-md:hidden")}>
                        <span className="text-[11px] text-muted">{p.category}</span>
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
          {categories.length === 0 ? (
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
                  {categories.map((cat, idx) => {
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
          {chains.length === 0 ? (
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
                  {chains.map((chain, idx) => (
                    <tr
                      key={chain.id}
                      className="border-b border-border/50 hover:bg-bg-1 transition-colors"
                      style={{
                        animationDelay: `${Math.min(idx * 20, 400)}ms`,
                      }}
                    >
                      <td className={cn(TD, "text-right text-faint font-mono text-xs w-10")}>
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
