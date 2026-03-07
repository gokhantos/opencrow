import { createLogger } from "../../logger";
import { fetchJson, delay, HACKS_URL, STABLECOINS_URL, EMISSIONS_URL, TREASURY_URL, REQUEST_DELAY_MS } from "./api";
import { upsertHacks, upsertStablecoins, upsertEmissions, upsertTreasury } from "./store-misc";
import type {
  RawHack, RawStablecoin, RawEmission, RawTreasury,
  HackRow, StablecoinRow, EmissionRow, TreasuryRow,
} from "./types";

const log = createLogger("defillama:misc");

// =============================================================================
// Helpers
// =============================================================================

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

// =============================================================================
// Hacks
// =============================================================================

function toHackRow(raw: RawHack): HackRow {
  const name = raw.name ?? "";
  const date = raw.date ?? 0;
  const id = slugify(`${name}-${date}`);
  return {
    id,
    name,
    protocol: raw.protocol ?? "",
    amount: raw.amount ?? 0,
    chain: raw.chain ?? "",
    classification: raw.classification ?? "",
    technique: raw.technique ?? "",
    date,
    description: raw.description ?? "",
    updated_at: Math.floor(Date.now() / 1000),
  };
}

export async function scrapeHacks(): Promise<number> {
  log.info("Fetching hacks");
  const raw = await fetchJson<RawHack[]>(HACKS_URL);
  const rows = raw.map(toHackRow).filter((r) => r.id !== "" && r.id !== "-");
  const count = await upsertHacks(rows);
  log.info("Hacks scraped", { total: raw.length, upserted: count });
  return count;
}

// =============================================================================
// Stablecoins
// =============================================================================

function toStablecoinRow(raw: RawStablecoin): StablecoinRow {
  return {
    id: raw.id ?? "",
    name: raw.name ?? "",
    symbol: raw.symbol ?? "",
    peg_type: raw.pegType ?? "",
    circulating: raw.circulating?.peggedUSD ?? 0,
    chains_json: JSON.stringify(raw.chains ?? []),
    price: raw.price ?? null,
    updated_at: Math.floor(Date.now() / 1000),
  };
}

export async function scrapeStablecoins(): Promise<number> {
  log.info("Fetching stablecoins");
  const response = await fetchJson<{ peggedAssets: RawStablecoin[] }>(
    `${STABLECOINS_URL}?includePrices=true`,
  );
  const raw = response.peggedAssets ?? [];
  const filtered = raw.filter((s) => (s.circulating?.peggedUSD ?? 0) >= 1_000_000);
  const rows = filtered.map(toStablecoinRow).filter((r) => r.id !== "");
  const count = await upsertStablecoins(rows);
  log.info("Stablecoins scraped", { total: raw.length, filtered: filtered.length, upserted: count });
  return count;
}

// =============================================================================
// Emissions
// =============================================================================

function toEmissionRow(raw: RawEmission): EmissionRow {
  const recentEvents = (raw.events ?? []).slice(-10);
  return {
    protocol_id: raw.protocolId ?? "",
    name: raw.name ?? "",
    token: raw.token ?? "",
    circ_supply: raw.circSupply ?? null,
    total_locked: raw.totalLocked ?? null,
    max_supply: raw.maxSupply ?? null,
    unlocks_per_day: raw.unlocksPerDay ?? null,
    mcap: raw.mcap ?? null,
    next_event_date: raw.nextEvent?.date ?? null,
    next_event_unlock: raw.nextEvent?.toUnlock ?? null,
    events_json: JSON.stringify(recentEvents),
    updated_at: Math.floor(Date.now() / 1000),
  };
}

export async function scrapeEmissions(): Promise<number> {
  log.info("Fetching emissions");
  const raw = await fetchJson<RawEmission[]>(EMISSIONS_URL);
  const nowSec = Math.floor(Date.now() / 1000);
  const filtered = raw.filter(
    (e) => e.nextEvent?.date !== undefined && (e.nextEvent.date ?? 0) > nowSec,
  );
  const rows = filtered.map(toEmissionRow).filter((r) => r.protocol_id !== "");
  const count = await upsertEmissions(rows);
  log.info("Emissions scraped", { total: raw.length, filtered: filtered.length, upserted: count });
  return count;
}

// =============================================================================
// Treasury
// =============================================================================

function toTreasuryRow(raw: RawTreasury): TreasuryRow {
  const breakdowns = raw.tokenBreakdowns ?? {};
  return {
    protocol_id: raw.id ?? raw.slug ?? "",
    name: raw.name ?? "",
    total_usd: raw.tvl ?? 0,
    own_tokens_usd: breakdowns.ownTokens ?? 0,
    stablecoins_usd: breakdowns.stablecoins ?? 0,
    majors_usd: breakdowns.majors ?? 0,
    others_usd: breakdowns.others ?? 0,
    updated_at: Math.floor(Date.now() / 1000),
  };
}

export async function scrapeTreasury(): Promise<number> {
  log.info("Fetching treasury");
  const raw = await fetchJson<RawTreasury[]>(TREASURY_URL);
  const rows = raw.map(toTreasuryRow).filter((r) => r.protocol_id !== "");
  const count = await upsertTreasury(rows);
  log.info("Treasury scraped", { total: raw.length, upserted: count });
  return count;
}

// =============================================================================
// Orchestrator
// =============================================================================

export async function scrapeMiscData(): Promise<{
  hacks: number;
  stablecoins: number;
  emissions: number;
  treasury: number;
}> {
  let hacks = 0;
  let stablecoins = 0;
  let emissions = 0;
  let treasury = 0;

  try {
    hacks = await scrapeHacks();
  } catch (err) {
    log.error("Failed to scrape hacks", { error: err instanceof Error ? err.message : String(err) });
  }
  await delay(REQUEST_DELAY_MS);

  try {
    stablecoins = await scrapeStablecoins();
  } catch (err) {
    log.error("Failed to scrape stablecoins", { error: err instanceof Error ? err.message : String(err) });
  }
  await delay(REQUEST_DELAY_MS);

  try {
    emissions = await scrapeEmissions();
  } catch (err) {
    log.error("Failed to scrape emissions", { error: err instanceof Error ? err.message : String(err) });
  }
  await delay(REQUEST_DELAY_MS);

  try {
    treasury = await scrapeTreasury();
  } catch (err) {
    log.error("Failed to scrape treasury", { error: err instanceof Error ? err.message : String(err) });
  }

  return { hacks, stablecoins, emissions, treasury };
}
