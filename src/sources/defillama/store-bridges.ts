import { getDb } from "../../store/db";
import type { BridgeRow } from "./types";

// =============================================================================
// Bridges CRUD
// =============================================================================

export async function upsertBridges(rows: readonly BridgeRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = getDb();
  let upserted = 0;
  for (const row of rows) {
    await db`
      INSERT INTO defi_bridges (
        id, name, display_name,
        volume_prev_day, volume_prev_2day, last_24h_volume,
        chain_breakdown_json, updated_at
      ) VALUES (
        ${row.id}, ${row.name}, ${row.display_name},
        ${row.volume_prev_day}, ${row.volume_prev_2day}, ${row.last_24h_volume},
        ${row.chain_breakdown_json}, ${row.updated_at}
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        display_name = EXCLUDED.display_name,
        volume_prev_day = EXCLUDED.volume_prev_day,
        volume_prev_2day = EXCLUDED.volume_prev_2day,
        last_24h_volume = EXCLUDED.last_24h_volume,
        chain_breakdown_json = EXCLUDED.chain_breakdown_json,
        updated_at = EXCLUDED.updated_at
    `;
    upserted++;
  }
  return upserted;
}

export async function getBridges(opts?: {
  readonly limit?: number;
}): Promise<BridgeRow[]> {
  const db = getDb();
  const limit = opts?.limit ?? 50;
  const rows = await db`
    SELECT * FROM defi_bridges
    ORDER BY last_24h_volume DESC NULLS LAST
    LIMIT ${limit}
  `;
  return rows as BridgeRow[];
}
