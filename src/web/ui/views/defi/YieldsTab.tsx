import React, { useState, useEffect } from "react";
import { cn } from "../../lib/cn";
import { apiFetch } from "../../api";
import { LoadingState, EmptyState } from "../../components";
import { TH, TD, formatTvl, ChainBadge } from "./shared";

interface YieldPool {
  readonly pool_id: string;
  readonly chain: string;
  readonly project: string;
  readonly symbol: string;
  readonly tvl_usd: number;
  readonly apy: number | null;
  readonly apy_base: number | null;
  readonly apy_reward: number | null;
  readonly apy_base_7d: number | null;
  readonly volume_usd_1d: number | null;
  readonly volume_usd_7d: number | null;
  readonly pool_meta: string;
  readonly exposure: string;
  readonly reward_tokens_json: string;
  readonly updated_at: number;
}

function formatApy(value: number | null | undefined): {
  readonly text: string;
  readonly className: string;
} {
  const num = Number(value);
  if (value == null || !isFinite(num)) return { text: "—", className: "text-faint" };
  const text = `${num.toFixed(2)}%`;
  const className =
    num > 10 ? "text-success font-bold" : num > 0 ? "text-foreground" : "text-faint";
  return { text, className };
}

export default function YieldsTab() {
  const [pools, setPools] = useState<YieldPool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeChain, setActiveChain] = useState("All");

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    try {
      const res = await apiFetch<{ success: boolean; data: YieldPool[] }>(
        "/api/defi/yields?limit=100",
      );
      if (res.success) setPools(res.data);
      setError("");
    } catch {
      setError("Failed to load yield pools");
    } finally {
      setLoading(false);
    }
  }

  const chains = ["All", ...Array.from(new Set(pools.map((p) => p.chain))).sort()];
  const filtered =
    activeChain === "All" ? pools : pools.filter((p) => p.chain === activeChain);

  if (loading) return <LoadingState message="Loading yield pools..." />;
  if (error)
    return (
      <div className="text-danger text-sm px-4 py-3 rounded-lg bg-danger/5 border border-danger/20">
        {error}
      </div>
    );

  return (
    <div>
      {/* Chain filter */}
      {chains.length > 2 && (
        <div className="flex gap-1.5 flex-wrap mb-5">
          {chains.map((chain) => (
            <button
              key={chain}
              type="button"
              onClick={() => setActiveChain(chain)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors duration-150 border",
                activeChain === chain
                  ? "bg-bg-2 border-border-hover text-strong"
                  : "bg-transparent border-border text-muted hover:bg-bg-1 hover:text-foreground",
              )}
            >
              {chain}
            </button>
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState description="No yield pools found." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-border bg-bg-1/50">
                <th className={cn(TH, "text-right w-10")}>#</th>
                <th className={cn(TH, "text-left")}>Pool</th>
                <th className={cn(TH, "text-left")}>Chain</th>
                <th className={cn(TH, "text-right")}>APY</th>
                <th className={cn(TH, "text-right")}>Base APY</th>
                <th className={cn(TH, "text-right")}>Reward APY</th>
                <th className={cn(TH, "text-right")}>TVL</th>
                <th className={cn(TH, "text-right max-md:hidden")}>Vol 1d</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((pool, idx) => {
                const apy = formatApy(pool.apy);
                const apyBase = formatApy(pool.apy_base);
                const apyReward = formatApy(pool.apy_reward);
                return (
                  <tr
                    key={pool.pool_id}
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
                      <div className="flex flex-col gap-0.5">
                        <span className="font-semibold text-strong text-[13px]">
                          {pool.symbol}
                        </span>
                        <span className="text-[11px] text-muted">
                          {pool.project}
                          {pool.pool_meta ? ` · ${pool.pool_meta}` : ""}
                        </span>
                      </div>
                    </td>
                    <td className={cn(TD, "text-left")}>
                      <ChainBadge chain={pool.chain} />
                    </td>
                    <td className={cn(TD, "text-right")}>
                      <span
                        className={cn(
                          "font-mono text-[13px] tabular-nums",
                          apy.className,
                        )}
                      >
                        {apy.text}
                      </span>
                    </td>
                    <td
                      className={cn(
                        TD,
                        "text-right font-mono text-[13px] text-muted tabular-nums",
                      )}
                    >
                      {apyBase.text}
                    </td>
                    <td
                      className={cn(
                        TD,
                        "text-right font-mono text-[13px] text-muted tabular-nums",
                      )}
                    >
                      {apyReward.text}
                    </td>
                    <td
                      className={cn(
                        TD,
                        "text-right font-mono text-[13px] text-foreground tabular-nums",
                      )}
                    >
                      {formatTvl(pool.tvl_usd)}
                    </td>
                    <td
                      className={cn(
                        TD,
                        "text-right font-mono text-[13px] text-muted tabular-nums max-md:hidden",
                      )}
                    >
                      {formatTvl(pool.volume_usd_1d)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
