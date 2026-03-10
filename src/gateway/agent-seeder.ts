/**
 * Seeds default agent definitions into the DB on startup.
 *
 * Idempotent: agents that already have a DB record are skipped.
 * DB is the source of truth once a record exists — this seeder never overwrites.
 */
import { AGENT_SEEDS } from "../config/agent-seeds";
import {
  getAgentOverrides,
  upsertAgentOverride,
} from "../store/agent-overrides";
import { createLogger } from "../logger";

const log = createLogger("gateway:agent-seeder");

export async function seedDefaultAgents(): Promise<void> {
  const existing = await getAgentOverrides();
  const existingIds = new Set(existing.map((o) => o.id));

  let seeded = 0;

  for (const agent of AGENT_SEEDS) {
    if (existingIds.has(agent.id)) {
      log.debug("Agent already in DB, skipping seed", { id: agent.id });
      continue;
    }

    await upsertAgentOverride(agent.id, agent);
    log.info("Seeded agent", { id: agent.id, name: agent.name });
    seeded++;
  }

  if (seeded > 0) {
    log.info(`Agent seeder complete`, { seeded, total: AGENT_SEEDS.length });
  } else {
    log.debug("Agent seeder: all agents already present, nothing to seed", {
      total: AGENT_SEEDS.length,
    });
  }
}
