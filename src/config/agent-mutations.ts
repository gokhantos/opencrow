import { agentDefinitionSchema } from "./schema";
import type { AgentDefinition } from "../agents/types";
import {
  getMergedAgentsWithSource,
  computeMergedAgentHash,
  loadConfig,
} from "./loader";
import {
  upsertAgentOverride,
  tombstoneAgentOverride,
  deleteAgentOverrideRow,
} from "../store/agent-overrides";

export class AgentConflictError extends Error {
  constructor() {
    super("Agent list changed since last read. Refresh and retry.");
    this.name = "AgentConflictError";
  }
}

function assertHashMatch(
  agents: readonly AgentDefinition[],
  baseHash: string,
): void {
  const current = computeMergedAgentHash(agents);
  if (current !== baseHash) {
    throw new AgentConflictError();
  }
}

export async function addAgentToDb(
  def: AgentDefinition,
  baseHash: string,
): Promise<string> {
  const merged = await getMergedAgentsWithSource();
  assertHashMatch(merged, baseHash);

  if (merged.some((a) => a.id === def.id)) {
    throw new Error(`Agent '${def.id}' already exists`);
  }

  const validated = agentDefinitionSchema.parse(def);
  await upsertAgentOverride(validated.id, validated);

  const updated = await getMergedAgentsWithSource();
  return computeMergedAgentHash(updated);
}

export async function updateAgentInDb(
  id: string,
  partial: Partial<AgentDefinition>,
  baseHash: string,
): Promise<string> {
  const merged = await getMergedAgentsWithSource();
  assertHashMatch(merged, baseHash);

  const existing = merged.find((a) => a.id === id);
  if (!existing) {
    throw new Error(`Agent '${id}' not found`);
  }

  const { _source, ...agentFields } = existing;
  const combined = { ...agentFields, ...partial, id };
  const validated = agentDefinitionSchema.parse(combined);

  // If setting this agent as default, unset default on all others
  if (validated.default) {
    for (const agent of merged) {
      if (agent.id !== id && agent.default) {
        const { _source: src, ...fields } = agent;
        await upsertAgentOverride(agent.id, { ...fields, default: false });
      }
    }
  }

  await upsertAgentOverride(id, validated);

  const updated = await getMergedAgentsWithSource();
  return computeMergedAgentHash(updated);
}

export async function removeAgentFromDb(
  id: string,
  baseHash: string,
): Promise<string> {
  const merged = await getMergedAgentsWithSource();
  assertHashMatch(merged, baseHash);

  const existing = merged.find((a) => a.id === id);
  if (!existing) {
    throw new Error(`Agent '${id}' not found`);
  }

  // Default agent is undeletable
  if (existing.default) {
    throw new Error("The default agent cannot be deleted");
  }

  // Must keep at least one agent
  const remaining = merged.filter((a) => a.id !== id);
  if (remaining.length === 0) {
    throw new Error("Cannot delete the last agent");
  }

  // File-defined agents get tombstoned; DB-only agents get deleted
  const fileAgentIds = new Set(loadConfig().agents.map((a) => a.id));
  if (fileAgentIds.has(id)) {
    await tombstoneAgentOverride(id);
  } else {
    await deleteAgentOverrideRow(id);
  }

  const updated = await getMergedAgentsWithSource();
  return computeMergedAgentHash(updated);
}
