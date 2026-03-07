import { createLogger } from "../../logger";
import { fetchJson, delay, BRIDGES_URL, BRIDGE_DETAIL_URL, REQUEST_DELAY_MS } from "./api";
import { upsertBridges } from "./store-bridges";
import type { RawBridge, RawBridgeDetail, BridgeRow } from "./types";

const log = createLogger("defillama:bridges");

const TOP_BRIDGE_DETAIL_COUNT = 20;

function toRow(raw: RawBridge, chainBreakdownJson = "{}"): BridgeRow {
  return {
    id: raw.id ?? 0,
    name: raw.name ?? "",
    display_name: raw.displayName ?? "",
    volume_prev_day: raw.volumePrevDay ?? null,
    volume_prev_2day: raw.volumePrev2Day ?? null,
    last_24h_volume: raw.last24hVolume ?? null,
    chain_breakdown_json: chainBreakdownJson,
    updated_at: Math.floor(Date.now() / 1000),
  };
}

export async function scrapeBridges(): Promise<number> {
  log.info("Fetching bridges");

  const response = await fetchJson<{ bridges: RawBridge[] }>(BRIDGES_URL);
  const rawBridges = response.bridges ?? [];

  // Build initial rows map keyed by id
  const rowsMap = new Map<number, BridgeRow>(
    rawBridges
      .filter((b) => b.id !== undefined)
      .map((b) => [b.id as number, toRow(b)]),
  );

  // Fetch detail for top 20 by last24hVolume
  const top20 = [...rawBridges]
    .filter((b) => b.id !== undefined)
    .sort((a, b) => (b.last24hVolume ?? 0) - (a.last24hVolume ?? 0))
    .slice(0, TOP_BRIDGE_DETAIL_COUNT);

  for (const bridge of top20) {
    const id = bridge.id as number;
    try {
      const detail = await fetchJson<RawBridgeDetail>(`${BRIDGE_DETAIL_URL}/${id}`);
      const chainBreakdownJson = JSON.stringify(detail.chainBreakdown ?? {});
      const existing = rowsMap.get(id);
      if (existing) {
        rowsMap.set(id, { ...existing, chain_breakdown_json: chainBreakdownJson });
      }
    } catch (err) {
      log.warn("Failed to fetch bridge detail", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await delay(REQUEST_DELAY_MS);
  }

  const rows = [...rowsMap.values()].filter((r) => r.id !== 0);
  const count = await upsertBridges(rows);

  log.info("Bridges scraped", { total: rawBridges.length, upserted: count });
  return count;
}
