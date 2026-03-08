import { getDb } from "../store/db";
import { createLogger } from "../logger";
import { computeAgentScores, computeToolScores, computeMcpScores } from "../agent/scoring-engine";

import { getErrorMessage } from "../../lib/error-serialization";
const log = createLogger("scoring-cron");

/**
 * Cron job to compute performance scores every 5 minutes
 */
export async function runScoringEngine(): Promise<void> {
  log.info("Starting scoring engine cron job");

  const startMs = Date.now();

  try {
    // Compute agent scores
    await computeAgentScores();

    // Compute tool scores
    await computeToolScores();

    // Compute MCP server scores
    await computeMcpScores();

    const durationMs = Date.now() - startMs;
    log.info("Scoring engine completed", { durationMs });
  } catch (err) {
    const msg = getErrorMessage(err);
    log.error("Scoring engine failed", { error: msg });
    throw err;
  }
}

/**
 * Register the scoring engine cron job
 */
export async function registerScoringCronJob(): Promise<void> {
  const db = getDb();

  try {
    // Check if job already exists
    const existing = await db<Array<{ id: string }>>`
      SELECT id FROM cron_jobs WHERE name = 'performance-scorer'
    `;

    if (existing && existing.length > 0) {
      log.debug("Scoring cron job already registered");
      return;
    }

    // Register cron job to run every 5 minutes
    await db`
      INSERT INTO cron_jobs (id, name, enabled, schedule_json, payload_json, delivery_json, created_at, updated_at)
      VALUES (
        ${`scoring-engine-${Date.now()}`},
        ${"performance-scorer"},
        ${false},
        ${JSON.stringify({ kind: "every", everyMs: 300000 })},
        ${JSON.stringify({ kind: "internal", handler: "scoring-engine" })},
        ${JSON.stringify({ mode: "none" })},
        EXTRACT(EPOCH FROM NOW())::INTEGER,
        EXTRACT(EPOCH FROM NOW())::INTEGER
      )
    `;

    log.info("Registered scoring engine cron job (every 5 minutes)");
  } catch (err) {
    log.warn("Failed to register scoring cron job", { error: String(err) });
  }
}
