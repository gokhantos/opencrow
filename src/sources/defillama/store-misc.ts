import { getDb } from "../../store/db";
import type { HackRow, EmissionRow, StablecoinRow, TreasuryRow } from "./types";

// =============================================================================
// Hacks CRUD
// =============================================================================

export async function upsertHacks(rows: readonly HackRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = getDb();
  let upserted = 0;
  for (const row of rows) {
    await db`
      INSERT INTO defi_hacks (
        id, name, protocol, amount, chain,
        classification, technique, date, description, updated_at
      ) VALUES (
        ${row.id}, ${row.name}, ${row.protocol}, ${row.amount}, ${row.chain},
        ${row.classification}, ${row.technique}, ${row.date}, ${row.description}, ${row.updated_at}
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        protocol = EXCLUDED.protocol,
        amount = EXCLUDED.amount,
        chain = EXCLUDED.chain,
        classification = EXCLUDED.classification,
        technique = EXCLUDED.technique,
        date = EXCLUDED.date,
        description = EXCLUDED.description,
        updated_at = EXCLUDED.updated_at
    `;
    upserted++;
  }
  return upserted;
}

export async function getHacks(opts?: {
  readonly chain?: string;
  readonly limit?: number;
  readonly minAmount?: number;
}): Promise<HackRow[]> {
  const db = getDb();
  const limit = opts?.limit ?? 50;
  const minAmount = opts?.minAmount ?? 0;
  const chain = opts?.chain ?? null;

  if (chain) {
    const rows = await db`
      SELECT * FROM defi_hacks
      WHERE chain = ${chain} AND amount >= ${minAmount}
      ORDER BY date DESC
      LIMIT ${limit}
    `;
    return rows as HackRow[];
  }

  const rows = await db`
    SELECT * FROM defi_hacks
    WHERE amount >= ${minAmount}
    ORDER BY date DESC
    LIMIT ${limit}
  `;
  return rows as HackRow[];
}

// =============================================================================
// Emissions CRUD
// =============================================================================

export async function upsertEmissions(rows: readonly EmissionRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = getDb();
  let upserted = 0;
  for (const row of rows) {
    await db`
      INSERT INTO defi_emissions (
        protocol_id, name, token,
        circ_supply, total_locked, max_supply,
        unlocks_per_day, mcap,
        next_event_date, next_event_unlock,
        events_json, updated_at
      ) VALUES (
        ${row.protocol_id}, ${row.name}, ${row.token},
        ${row.circ_supply}, ${row.total_locked}, ${row.max_supply},
        ${row.unlocks_per_day}, ${row.mcap},
        ${row.next_event_date}, ${row.next_event_unlock},
        ${row.events_json}, ${row.updated_at}
      )
      ON CONFLICT (protocol_id) DO UPDATE SET
        name = EXCLUDED.name,
        token = EXCLUDED.token,
        circ_supply = EXCLUDED.circ_supply,
        total_locked = EXCLUDED.total_locked,
        max_supply = EXCLUDED.max_supply,
        unlocks_per_day = EXCLUDED.unlocks_per_day,
        mcap = EXCLUDED.mcap,
        next_event_date = EXCLUDED.next_event_date,
        next_event_unlock = EXCLUDED.next_event_unlock,
        events_json = EXCLUDED.events_json,
        updated_at = EXCLUDED.updated_at
    `;
    upserted++;
  }
  return upserted;
}

export async function getEmissions(opts?: {
  readonly limit?: number;
  readonly hasUpcoming?: boolean;
}): Promise<EmissionRow[]> {
  const db = getDb();
  const limit = opts?.limit ?? 100;
  const nowSec = Math.floor(Date.now() / 1000);

  if (opts?.hasUpcoming) {
    const rows = await db`
      SELECT * FROM defi_emissions
      WHERE next_event_date > ${nowSec}
      ORDER BY next_event_date ASC
      LIMIT ${limit}
    `;
    return rows as EmissionRow[];
  }

  const rows = await db`
    SELECT * FROM defi_emissions
    ORDER BY next_event_date ASC NULLS LAST
    LIMIT ${limit}
  `;
  return rows as EmissionRow[];
}

// =============================================================================
// Stablecoins CRUD
// =============================================================================

export async function upsertStablecoins(rows: readonly StablecoinRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = getDb();
  let upserted = 0;
  for (const row of rows) {
    await db`
      INSERT INTO defi_stablecoins (
        id, name, symbol, peg_type,
        circulating, chains_json, price, updated_at
      ) VALUES (
        ${row.id}, ${row.name}, ${row.symbol}, ${row.peg_type},
        ${row.circulating}, ${row.chains_json}, ${row.price}, ${row.updated_at}
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        symbol = EXCLUDED.symbol,
        peg_type = EXCLUDED.peg_type,
        circulating = EXCLUDED.circulating,
        chains_json = EXCLUDED.chains_json,
        price = EXCLUDED.price,
        updated_at = EXCLUDED.updated_at
    `;
    upserted++;
  }
  return upserted;
}

export async function getStablecoins(opts?: {
  readonly limit?: number;
  readonly minCirculating?: number;
}): Promise<StablecoinRow[]> {
  const db = getDb();
  const limit = opts?.limit ?? 50;
  const minCirculating = opts?.minCirculating ?? 0;

  const rows = await db`
    SELECT * FROM defi_stablecoins
    WHERE circulating >= ${minCirculating}
    ORDER BY circulating DESC
    LIMIT ${limit}
  `;
  return rows as StablecoinRow[];
}

// =============================================================================
// Treasury CRUD
// =============================================================================

export async function upsertTreasury(rows: readonly TreasuryRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = getDb();
  let upserted = 0;
  for (const row of rows) {
    await db`
      INSERT INTO defi_treasury (
        protocol_id, name, total_usd,
        own_tokens_usd, stablecoins_usd, majors_usd, others_usd,
        updated_at
      ) VALUES (
        ${row.protocol_id}, ${row.name}, ${row.total_usd},
        ${row.own_tokens_usd}, ${row.stablecoins_usd}, ${row.majors_usd}, ${row.others_usd},
        ${row.updated_at}
      )
      ON CONFLICT (protocol_id) DO UPDATE SET
        name = EXCLUDED.name,
        total_usd = EXCLUDED.total_usd,
        own_tokens_usd = EXCLUDED.own_tokens_usd,
        stablecoins_usd = EXCLUDED.stablecoins_usd,
        majors_usd = EXCLUDED.majors_usd,
        others_usd = EXCLUDED.others_usd,
        updated_at = EXCLUDED.updated_at
    `;
    upserted++;
  }
  return upserted;
}

export async function getTreasury(opts?: {
  readonly limit?: number;
  readonly minTotal?: number;
}): Promise<TreasuryRow[]> {
  const db = getDb();
  const limit = opts?.limit ?? 50;
  const minTotal = opts?.minTotal ?? 0;

  const rows = await db`
    SELECT * FROM defi_treasury
    WHERE total_usd >= ${minTotal}
    ORDER BY total_usd DESC
    LIMIT ${limit}
  `;
  return rows as TreasuryRow[];
}
