/**
 * READ-ONLY store query backing the competability calibration / backtest tool.
 *
 * Kept in a SIBLING file (not bolted onto the large `store.ts`) so the read-only
 * calibration concern stays focused and small. It reuses the tolerant
 * `parseCompetabilityJson` mapper exported by `store.ts` rather than duplicating
 * the object|string|null JSONB parse.
 *
 * Pulls every idea that carries a persisted overall competability score, mapping
 * each row TOLERANTLY into a {@link CalibrationRecord}: the overall comes from the
 * REAL `competability_overall` column; `gated` and `dimensions` come from the
 * JSONB scorecard when well-formed. A NULL / malformed scorecard still yields a
 * usable record (`gated:false`, `dimensions:undefined`) rather than crashing.
 */

import {
  COMPETABILITY_DIMENSIONS,
  type CompetabilityDimension,
} from "../../pipelines/ideas/competability";
import type { CalibrationRecord } from "../../pipelines/ideas/competability-calibration";
import { createLogger } from "../../logger";
import { getDb } from "../../store/db";
import { type CompetabilityPersistedJson, parseCompetabilityJson } from "./store";

const log = createLogger("ideas:competability-calibration-query");

/**
 * Defense-in-depth cap on the backtest read. Far above any realistic volume of
 * scored ideas, so it never biases the calibration in practice; it only bounds
 * the worst-case memory footprint of this authed read-only endpoint.
 */
const MAX_CALIBRATION_ROWS = 100_000;

interface CompetabilityScoredRow {
  readonly competability_overall: number | null;
  readonly competability_json: CompetabilityPersistedJson | string | null;
}

/**
 * Extract a well-formed `dimensions` record from the parsed scorecard, or
 * undefined when absent / malformed. Every dimension must be a finite number.
 */
function extractDimensions(
  json: CompetabilityPersistedJson | null,
): Readonly<Record<CompetabilityDimension, number>> | undefined {
  const dims = json?.dimensions;
  if (!dims || typeof dims !== "object") return undefined;
  const out = {} as Record<CompetabilityDimension, number>;
  for (const key of COMPETABILITY_DIMENSIONS) {
    const value = (dims as Record<string, unknown>)[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    out[key] = value;
  }
  return out;
}

/**
 * Read every scored idea (`competability_overall IS NOT NULL`) and map it to a
 * backtest {@link CalibrationRecord}. Parameterized via `getDb()` tagged template —
 * no string interpolation. Tolerates NULL / malformed `competability_json`.
 */
export async function getCompetabilityScoredIdeas(): Promise<readonly CalibrationRecord[]> {
  const db = getDb();
  const rows = (await db`
    SELECT competability_overall, competability_json
    FROM generated_ideas
    WHERE competability_overall IS NOT NULL
    LIMIT ${MAX_CALIBRATION_ROWS}
  `) as readonly CompetabilityScoredRow[];

  const records: CalibrationRecord[] = [];
  for (const row of rows) {
    if (row.competability_overall === null) continue; // defensive; WHERE already filters
    let json: CompetabilityPersistedJson | null = null;
    try {
      json = parseCompetabilityJson(row.competability_json);
    } catch (err) {
      // parseCompetabilityJson already swallows JSON errors; this is belt-and-braces.
      log.warn("Failed to parse competability_json; treating as un-gated", { err });
      json = null;
    }
    const dimensions = extractDimensions(json);
    records.push({
      overall: row.competability_overall,
      gated: json?.gated === true,
      ...(dimensions ? { dimensions } : {}),
    });
  }
  return records;
}
