import React from "react";
import { cn } from "../../lib/cn";

export const TH =
  "text-[10px] font-semibold text-faint uppercase tracking-[0.1em] px-4 py-2.5 whitespace-nowrap";
export const TD = "px-4 py-3 whitespace-nowrap";

export function formatTvl(raw: number | string | null | undefined): string {
  const value = Number(raw);
  if (raw == null || !isFinite(value) || value === 0) return "—";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

export function formatPct(raw: number | string | null | undefined): {
  readonly text: string;
  readonly className: string;
} {
  const value = Number(raw);
  if (raw == null || !isFinite(value)) return { text: "—", className: "text-faint" };
  const sign = value >= 0 ? "+" : "";
  return {
    text: `${sign}${value.toFixed(2)}%`,
    className: value >= 0 ? "text-success" : "text-danger",
  };
}

export function formatDate(epoch: number): string {
  return new Date(epoch * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const CHAIN_COLORS: Readonly<Record<string, string>> = {
  Ethereum: "bg-[#627eea]/15 text-[#627eea]",
  Solana: "bg-purple/15 text-purple",
  Base: "bg-cyan/15 text-cyan",
  Arbitrum: "bg-[#28a0f0]/15 text-[#28a0f0]",
  BSC: "bg-warning/15 text-warning",
  Polygon: "bg-[#8247e5]/15 text-[#8247e5]",
  Optimism: "bg-danger/15 text-danger",
  Avalanche: "bg-danger/15 text-danger",
  multi: "bg-bg-3 text-muted",
};

export function ChainBadge({ chain }: { readonly chain: string }) {
  const colors = CHAIN_COLORS[chain] ?? "bg-bg-3 text-muted";
  return React.createElement(
    "span",
    {
      className: cn(
        "px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider leading-none",
        colors,
      ),
    },
    chain,
  );
}
