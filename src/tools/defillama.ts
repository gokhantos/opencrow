import type { ToolDefinition } from "./types";
import type { MemoryManager } from "../memory/types";
import { getErrorMessage } from "../../lib/error-serialization";
import { createDefiLlamaExtendedTools } from "./defillama-extended";
import {
  getProtocols,
  getTopMovers,
  getChainTvls,
  getChainTvlHistory,
  getLatestChainMetrics,
  getAllTargetChainMetrics,
  chainToId,
  TARGET_CHAINS,
  type ProtocolRow,
  type ChainTvlRow,
  type ChainMetricsRow,
  type ChainTvlHistoryRow,
} from "../sources/defillama/store";
import { createSemanticSearchTool } from "./search-factory";
import { createDigestTool } from "./digest-factory";
import { getString, getNumber } from "./input-helpers";

function formatTvl(tvl: number | null): string {
  if (tvl === null || tvl === undefined) return "N/A";
  if (tvl >= 1_000_000_000) return `$${(tvl / 1_000_000_000).toFixed(2)}B`;
  if (tvl >= 1_000_000) return `$${(tvl / 1_000_000).toFixed(2)}M`;
  if (tvl >= 1_000) return `$${(tvl / 1_000).toFixed(1)}K`;
  return `$${tvl.toFixed(0)}`;
}

function formatChange(change: number | null): string {
  if (change == null) return "N/A";
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(2)}%`;
}

function formatProtocol(p: ProtocolRow, i: number): string {
  return [
    `${i + 1}. ${p.name} [${p.category}] on ${p.chain}`,
    `  TVL: ${formatTvl(p.tvl)} | 24h: ${formatChange(p.change_1d)} | 7d: ${formatChange(p.change_7d)}`,
    p.description ? `  ${p.description.slice(0, 150)}` : null,
    `  ${p.url}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatChain(c: ChainTvlRow, i: number): string {
  return `${i + 1}. ${c.name}: ${formatTvl(c.tvl)} (${c.protocols_count} protocols)`;
}

function formatChainMetrics(m: ChainMetricsRow, i: number): string {
  const lines = [`${i + 1}. ${m.chain_id.charAt(0).toUpperCase() + m.chain_id.slice(1)}`];

  if (m.fees_24h !== null) {
    lines.push(
      `  Fees: ${formatTvl(m.fees_24h)}/24h | ${formatTvl(m.fees_7d)}/7d | ${formatTvl(m.fees_30d)}/30d (${formatChange(m.fees_change_1d)})`,
    );
  }
  if (m.dex_volume_24h !== null) {
    lines.push(
      `  DEX Vol: ${formatTvl(m.dex_volume_24h)}/24h | ${formatTvl(m.dex_volume_7d)}/7d | ${formatTvl(m.dex_volume_30d)}/30d (${formatChange(m.dex_volume_change_1d)})`,
    );
  }
  if (m.stablecoin_mcap !== null) {
    lines.push(`  Stablecoin Supply: ${formatTvl(m.stablecoin_mcap)}`);
  }

  return lines.join("\n");
}

function formatTvlHistory(rows: ChainTvlHistoryRow[]): string {
  if (rows.length === 0) return "No historical TVL data available.";

  const chainId = rows[0]!.chain_id;
  const header = `Historical TVL for ${chainId} (${rows.length} data points):\n`;

  // Show sampled points (first, last, and evenly spaced between)
  const sorted = [...rows].sort((a, b) => a.date - b.date);
  const sampleSize = Math.min(30, sorted.length);
  const step = Math.max(1, Math.floor(sorted.length / sampleSize));

  const sampled: string[] = [];
  for (let i = 0; i < sorted.length; i += step) {
    const p = sorted[i]!;
    const d = new Date(p.date * 1000);
    sampled.push(`  ${d.toISOString().split("T")[0]}: ${formatTvl(p.tvl)}`);
  }

  // Always include the latest
  const last = sorted[sorted.length - 1]!;
  const lastDate = new Date(last.date * 1000).toISOString().split("T")[0];
  const lastLine = `  ${lastDate}: ${formatTvl(last.tvl)} (latest)`;
  if (!sampled[sampled.length - 1]?.includes(lastDate!)) {
    sampled.push(lastLine);
  }

  return header + sampled.join("\n");
}

export function createDefiLlamaTools(
  memoryManager: MemoryManager | null,
): readonly ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createDigestTool<ProtocolRow>({
      name: "get_defi_protocols",
      description:
        "Get top DeFi protocols by TVL from DeFi Llama. Filter by category (DEX, Lending, Bridge, etc.) or chain (Ethereum, Solana, Base). Use to understand DeFi landscape and spot TVL movements.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of protocols (default 30, max 50).",
          },
          category: {
            type: "string",
            description:
              "Filter by category (e.g. 'Dexes', 'Lending', 'Bridge', 'Yield').",
          },
          chain: {
            type: "string",
            description:
              "Filter by chain (e.g. 'Ethereum', 'Solana', 'Base').",
          },
        },
        required: [],
      },
      fetchFn: async (input, limit) => {
        const category = getString(input, "category");
        const chain = getString(input, "chain");
        return getProtocols({ category, chain, limit });
      },
      formatFn: formatProtocol,
      headerFn: (results) =>
        `DeFi Protocols by TVL (${results.length} protocols):\n`,
      emptyMessage: "No DeFi protocol data available yet.",
      errorPrefix: "Error retrieving DeFi protocols",
    }),
    createDigestTool<ProtocolRow>({
      name: "get_defi_movers",
      description:
        "Get DeFi protocols with the biggest TVL changes in the last 24h. Shows both gainers and losers.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of movers (default 20, max 50).",
          },
        },
        required: [],
      },
      fetchFn: async (_input, limit) => getTopMovers(limit),
      formatFn: formatProtocol,
      defaultLimit: 20,
      headerFn: (results) =>
        `DeFi Top Movers (${results.length} protocols):\n`,
      emptyMessage: "No DeFi mover data available yet.",
      errorPrefix: "Error retrieving DeFi movers",
    }),
    createDigestTool<ChainTvlRow>({
      name: "get_chain_tvls",
      description:
        "Get total TVL and protocol count per blockchain. Shows which chains are attracting the most capital.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of chains (default 30, max 50).",
          },
        },
        required: [],
      },
      fetchFn: async (_input, limit) => getChainTvls(limit),
      formatFn: formatChain,
      headerFn: (results) =>
        `Chain TVL Rankings (${results.length} chains):\n`,
      emptyMessage: "No chain TVL data available yet.",
      errorPrefix: "Error retrieving chain TVLs",
    }),

    // --- New tools for enhanced data ---

    createDigestTool<ChainMetricsRow>({
      name: "get_chain_metrics",
      description:
        "Get detailed metrics for all tracked major chains: fees, DEX volume, and stablecoin supply. Shows 24h/7d/30d breakdowns with daily changes.",
      inputSchema: {
        type: "object",
        properties: {
          chain: {
            type: "string",
            description:
              "Specific chain to query (Ethereum, Solana, or Base). Omit for all three.",
          },
        },
        required: [],
      },
      fetchFn: async (input) => {
        const chain = getString(input, "chain");
        if (chain) {
          const metrics = await getLatestChainMetrics(chainToId(chain));
          return metrics ? [metrics] : [];
        }
        return getAllTargetChainMetrics();
      },
      formatFn: formatChainMetrics,
      headerFn: (results) =>
        `Chain Metrics (${results.length} chains - fees, DEX volume, stablecoins):\n`,
      emptyMessage:
        "No chain metrics data available yet. The scraper may not have run.",
      errorPrefix: "Error retrieving chain metrics",
    }),

    {
      name: "get_chain_tvl_history",
      categories: ["research"],
      description:
        "Get historical daily TVL for any tracked major chain. Returns time series data useful for trend analysis. Specify daysBack for recent history or get up to a year.",
      inputSchema: {
        type: "object",
        properties: {
          chain: {
            type: "string",
            description:
              "Chain name: 'Ethereum', 'Solana', or 'Base' (required).",
          },
          days_back: {
            type: "number",
            description:
              "Number of days of history (default 90, max 365).",
          },
        },
        required: ["chain"],
      },
      execute: async (input: Record<string, unknown>) => {
        try {
          const chain = getString(input, "chain");
          if (!chain) {
            return {
              output: "Error: chain parameter is required (Ethereum, Solana, or Base).",
              isError: true,
            };
          }

          const daysBack = Math.min(
            Math.max(getNumber(input, "days_back") ?? 90, 1),
            365,
          );

          const rows = await getChainTvlHistory(chainToId(chain), {
            daysBack,
          });

          return { output: formatTvlHistory(rows), isError: false };
        } catch (err) {
          const msg = getErrorMessage(err);
          return {
            output: `Error retrieving TVL history: ${msg}`,
            isError: true,
          };
        }
      },
    },
  ];

  if (memoryManager) {
    tools.unshift(
      createSemanticSearchTool({
        name: "search_defi",
        description:
          "Semantic search over indexed DeFi protocol data. Find protocols related to a concept. Query like 'liquid staking Solana' or 'perpetual DEX'.",
        agentId: "defillama",
        kinds: ["article"],
        memoryManager,
        emptyMessage: "No matching DeFi protocols found.",
        errorPrefix: "Error searching DeFi data",
      }),
    );
  }

  // Merge extended tools
  tools.push(...createDefiLlamaExtendedTools());

  return tools;
}
