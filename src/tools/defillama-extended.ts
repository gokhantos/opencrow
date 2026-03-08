import type { ToolDefinition, ToolResult } from "./types";
import { getString, getNumber, getBoolean } from "./input-helpers";
import { createDigestTool } from "./digest-factory";
import { formatTvl } from "../sources/defillama/api";
import {
  getYieldPools,
  getTopYieldPools,
} from "../sources/defillama/store-yields";
import { getBridges } from "../sources/defillama/store-bridges";
import {
  getHacks,
  getEmissions,
  getStablecoins,
  getTreasury,
} from "../sources/defillama/store-misc";
import {
  getCategories,
  getLatestGlobalMetrics,
  getProtocolDetail,
} from "../sources/defillama/store-overviews";
import type {
  YieldPoolRow,
  BridgeRow,
  HackRow,
  EmissionRow,
  CategoryRow,
  StablecoinRow,
  TreasuryRow,
} from "../sources/defillama/types";
import { createLogger } from "../logger";

import { getErrorMessage } from "../lib/error-serialization";
const log = createLogger("tool:defillama-extended");


function formatApy(apy: number | null): string {
  if (apy === null || apy === undefined) return "N/A";
  return `${apy.toFixed(2)}%`;
}

function formatDate(timestamp: number | null): string {
  if (!timestamp) return "N/A";
  return new Date(timestamp * 1000).toISOString().split("T")[0]!;
}

function formatYieldPool(p: YieldPoolRow, i: number): string {
  const rewards = (() => {
    try {
      const tokens: string[] = JSON.parse(p.reward_tokens_json);
      return tokens.length > 0 ? tokens.join(", ") : "none";
    } catch {
      return "N/A";
    }
  })();
  return [
    `${i + 1}. ${p.symbol} on ${p.chain} (${p.project})`,
    `   APY: ${formatApy(p.apy)} | TVL: ${formatTvl(p.tvl_usd)} | Rewards: ${rewards}`,
  ].join("\n");
}

function formatBridge(b: BridgeRow, i: number): string {
  return [
    `${i + 1}. ${b.display_name || b.name}`,
    `   24h Vol: ${formatTvl(b.last_24h_volume)} | Prev Day: ${formatTvl(b.volume_prev_day)}`,
  ].join("\n");
}

function formatHack(h: HackRow, i: number): string {
  return [
    `${i + 1}. ${h.name} — ${formatTvl(h.amount)} on ${h.chain}`,
    `   Technique: ${h.technique || "N/A"} | Date: ${formatDate(h.date)}`,
  ].join("\n");
}

function formatEmission(e: EmissionRow, i: number): string {
  return [
    `${i + 1}. ${e.name} (${e.token})`,
    `   Next Unlock: ${formatDate(e.next_event_date)} | Unlock Amount: ${formatTvl(e.next_event_unlock)}`,
    `   Daily Unlocks: ${formatTvl(e.unlocks_per_day)} | MCap: ${formatTvl(e.mcap)}`,
  ].join("\n");
}

function formatCategory(c: CategoryRow, i: number): string {
  return `${i + 1}. ${c.name}: ${formatTvl(c.tvl)} (${c.percentage?.toFixed(1) ?? "N/A"}% | ${c.protocol_count} protocols)`;
}

function formatStablecoin(s: StablecoinRow, i: number): string {
  const price = s.price !== null ? `$${s.price.toFixed(4)}` : "N/A";
  return `${i + 1}. ${s.name} (${s.symbol}) | Circulating: ${formatTvl(s.circulating)} | Peg: ${s.peg_type} | Price: ${price}`;
}

function formatTreasury(t: TreasuryRow, i: number): string {
  return [
    `${i + 1}. ${t.name}: ${formatTvl(t.total_usd)}`,
    `   Own Tokens: ${formatTvl(t.own_tokens_usd)} | Stables: ${formatTvl(t.stablecoins_usd)} | Majors: ${formatTvl(t.majors_usd)} | Others: ${formatTvl(t.others_usd)}`,
  ].join("\n");
}

export function createDefiLlamaExtendedTools(): readonly ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createDigestTool<YieldPoolRow>({
      name: "get_yield_pools",
      description:
        "Get top DeFi yield pools by APY or TVL. Filter by chain or project. Useful for finding the best yield opportunities across DeFi.",
      inputSchema: {
        type: "object",
        properties: {
          chain: { type: "string", description: "Filter by chain (e.g. 'Ethereum', 'Arbitrum')." },
          project: { type: "string", description: "Filter by protocol/project name." },
          minApy: { type: "number", description: "Minimum APY percentage (default 0)." },
          limit: { type: "number", description: "Number of pools (default 30, max 100)." },
        },
        required: [],
      },
      fetchFn: async (input, limit) => {
        const chain = getString(input, "chain") ?? undefined;
        const project = getString(input, "project") ?? undefined;
        const minApy = getNumber(input, "minApy") ?? 0;
        return getYieldPools({ chain, project, minApy, limit });
      },
      formatFn: formatYieldPool,
      headerFn: (results) => `Yield Pools (${results.length} pools):\n`,
      emptyMessage: "No yield pool data available yet.",
      errorPrefix: "Error retrieving yield pools",
    }),

    createDigestTool<BridgeRow>({
      name: "get_bridges",
      description:
        "Get bridge volumes ranked by 24h volume. Shows how much value is being transferred cross-chain.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of bridges (default 20, max 100)." },
        },
        required: [],
      },
      fetchFn: async (_input, limit) => getBridges({ limit }),
      formatFn: formatBridge,
      defaultLimit: 20,
      headerFn: (results) => `Bridge Volumes (${results.length} bridges):\n`,
      emptyMessage: "No bridge data available yet.",
      errorPrefix: "Error retrieving bridge volumes",
    }),

    createDigestTool<HackRow>({
      name: "get_defi_hacks",
      description:
        "Get historical DeFi exploits and hacks. Filter by chain or minimum amount. Useful for security research and risk analysis.",
      inputSchema: {
        type: "object",
        properties: {
          chain: { type: "string", description: "Filter by chain (e.g. 'Ethereum', 'BSC')." },
          limit: { type: "number", description: "Number of hacks (default 30, max 100)." },
          minAmount: { type: "number", description: "Minimum hack amount in USD." },
        },
        required: [],
      },
      fetchFn: async (input, limit) => {
        const chain = getString(input, "chain") ?? undefined;
        const minAmount = getNumber(input, "minAmount") ?? 0;
        return getHacks({ chain, limit, minAmount });
      },
      formatFn: formatHack,
      headerFn: (results) => `DeFi Hacks (${results.length} incidents):\n`,
      emptyMessage: "No hack data available yet.",
      errorPrefix: "Error retrieving DeFi hacks",
    }),

    createDigestTool<EmissionRow>({
      name: "get_emissions",
      description:
        "Get upcoming token unlock schedules. Shows which protocols have large unlocks coming, which may affect token prices.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of protocols (default 30, max 100)." },
          hasUpcoming: { type: "boolean", description: "Only show protocols with upcoming unlock events." },
        },
        required: [],
      },
      fetchFn: async (input, limit) => {
        const hasUpcoming = getBoolean(input, "hasUpcoming") ?? false;
        return getEmissions({ limit, hasUpcoming });
      },
      formatFn: formatEmission,
      headerFn: (results) => `Token Emissions/Unlocks (${results.length} protocols):\n`,
      emptyMessage: "No emissions data available yet.",
      errorPrefix: "Error retrieving emissions data",
    }),

    createDigestTool<CategoryRow>({
      name: "get_defi_categories",
      description:
        "Get DeFi TVL breakdown by category (DEXes, Lending, Bridges, etc.). Shows the relative size of each DeFi sector.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      fetchFn: async () => getCategories(),
      formatFn: formatCategory,
      headerFn: (results) => `DeFi Categories by TVL (${results.length} categories):\n`,
      emptyMessage: "No category data available yet.",
      errorPrefix: "Error retrieving DeFi categories",
    }),

    createDigestTool<StablecoinRow>({
      name: "get_stablecoins",
      description:
        "Get stablecoin data ranked by circulating supply. Includes circulating amount, peg type, and current price.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of stablecoins (default 20, max 100)." },
        },
        required: [],
      },
      fetchFn: async (_input, limit) => getStablecoins({ limit }),
      formatFn: formatStablecoin,
      defaultLimit: 20,
      headerFn: (results) => `Stablecoins (${results.length}):\n`,
      emptyMessage: "No stablecoin data available yet.",
      errorPrefix: "Error retrieving stablecoin data",
    }),

    createDigestTool<TreasuryRow>({
      name: "get_treasury",
      description:
        "Get protocol treasury balances ranked by total USD value. Shows breakdown into own tokens, stablecoins, majors, and others.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of protocols (default 20, max 100)." },
        },
        required: [],
      },
      fetchFn: async (_input, limit) => getTreasury({ limit }),
      formatFn: formatTreasury,
      defaultLimit: 20,
      headerFn: (results) => `Protocol Treasuries (${results.length}):\n`,
      emptyMessage: "No treasury data available yet.",
      errorPrefix: "Error retrieving treasury data",
    }),

    {
      name: "get_protocol_detail",
      categories: ["research"],
      description:
        "Get detailed information about a specific DeFi protocol: symbol, market cap, TVL per chain, fees, revenue, fundraising rounds, and Twitter.",
      inputSchema: {
        type: "object",
        properties: {
          protocol: {
            type: "string",
            description: "Protocol slug/ID (e.g. 'uniswap', 'aave', 'lido').",
          },
        },
        required: ["protocol"],
      },
      execute: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const protocol = getString(input, "protocol");
          if (!protocol) {
            return { output: "Error: protocol parameter is required.", isError: true };
          }

          const detail = await getProtocolDetail(protocol);
          if (!detail) {
            return { output: `No detail found for protocol: ${protocol}`, isError: false };
          }

          const chains: string[] = (() => {
            try { return JSON.parse(detail.chains_json); } catch { return []; }
          })();

          const raises: Array<{ amount?: number; round?: string; date?: string }> = (() => {
            try { return JSON.parse(detail.raises_json); } catch { return []; }
          })();

          const lines = [
            `Protocol: ${detail.id}`,
            `Symbol: ${detail.symbol || "N/A"}`,
            `MCap: ${formatTvl(detail.mcap)}`,
            `Chains: ${chains.join(", ") || "N/A"}`,
            `Fees 24h: ${formatTvl(detail.fees_24h)} | 7d: ${formatTvl(detail.fees_7d)}`,
            `Revenue 24h: ${formatTvl(detail.revenue_24h)} | 7d: ${formatTvl(detail.revenue_7d)}`,
            detail.twitter ? `Twitter: ${detail.twitter}` : null,
          ];

          if (raises.length > 0) {
            lines.push(`Raises (${raises.length}):`);
            for (const r of raises.slice(0, 5)) {
              lines.push(`  ${r.date ?? "?"} — ${r.round ?? "?"}: ${formatTvl(r.amount ? r.amount * 1_000_000 : null)}`);
            }
          }

          return { output: lines.filter(Boolean).join("\n"), isError: false };
        } catch (err) {
          const msg = getErrorMessage(err);
          log.error("get_protocol_detail failed", { error: msg });
          return { output: `Error retrieving protocol detail: ${msg}`, isError: true };
        }
      },
    },

    {
      name: "get_global_defi_metrics",
      categories: ["research"],
      description:
        "Get a global DeFi overview: total fees, revenue, DEX volume, options, and derivatives — aggregated across all protocols.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      execute: async (): Promise<ToolResult> => {
        try {
          const rows = await getLatestGlobalMetrics();
          if (rows.length === 0) {
            return { output: "No global metrics data available yet.", isError: false };
          }

          const byType = new Map(rows.map((r) => [r.metric_type, r]));

          function metricLine(type: string, label: string): string {
            const r = byType.get(type);
            if (!r) return `${label}: N/A`;
            const change = r.change_1d != null
              ? ` (${r.change_1d >= 0 ? "+" : ""}${r.change_1d.toFixed(2)}%)`
              : "";
            return `${label}: ${formatTvl(r.total_24h)}/24h | ${formatTvl(r.total_7d)}/7d${change}`;
          }

          const optionsPremium = byType.get("options_premium");
          const optionsNotional = byType.get("options_notional");
          const derivativesVol = byType.get("derivatives_volume");
          const derivativesOi = byType.get("derivatives_oi");

          function optionsLine(): string {
            const premium = optionsPremium ? formatTvl(optionsPremium.total_24h) : "N/A";
            const notional = optionsNotional ? formatTvl(optionsNotional.total_24h) : "N/A";
            return `Options: Premium ${premium}/24h | Notional ${notional}/24h`;
          }

          function derivativesLine(): string {
            const vol = derivativesVol ? formatTvl(derivativesVol.total_24h) : "N/A";
            const oi = derivativesOi ? formatTvl(derivativesOi.total_24h) : "N/A";
            return `Derivatives: Volume ${vol}/24h | OI ${oi}/24h`;
          }

          const lines = [
            "Global DeFi Metrics:",
            metricLine("fees", "Total Fees"),
            metricLine("dex_volume", "DEX Volume"),
            optionsLine(),
            derivativesLine(),
          ];

          return { output: lines.join("\n"), isError: false };
        } catch (err) {
          const msg = getErrorMessage(err);
          log.error("get_global_defi_metrics failed", { error: msg });
          return { output: `Error retrieving global metrics: ${msg}`, isError: true };
        }
      },
    },
  ];

  return tools;
}
