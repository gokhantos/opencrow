import { agentDefinitionSchema } from "./schema";
import type { AgentDefinition, ToolFilter } from "../agents/types";
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
import { grantedHighImpactTools } from "../tools/privilege";

export class AgentConflictError extends Error {
  constructor() {
    super("Agent list changed since last read. Refresh and retry.");
    this.name = "AgentConflictError";
  }
}

/**
 * Raised when an agent caller attempts a privilege-escalating mutation
 * (granting tools it does not hold, editing its own privileged fields, etc.).
 */
export class PrivilegeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivilegeError";
  }
}

/**
 * Identity of the caller invoking a mutation.
 *
 * Operator/web callers omit this entirely (or pass `kind: "operator"`) and keep
 * full power. Agent callers (the manage_agent tool) pass `kind: "agent"` with
 * their own id and resolved tool filter so mutations can be made
 * privilege-monotonic: an agent can never grant more than it itself holds, and
 * can never modify its own privileged fields.
 */
export type CallerContext =
  | { readonly kind: "operator" }
  | {
      readonly kind: "agent";
      readonly agentId: string;
      readonly toolFilter: ToolFilter;
    };

/** Fields an agent caller may NEVER modify (on any agent, including itself). */
const SELF_PROTECTED_FIELDS: readonly (keyof AgentDefinition)[] = [
  "toolFilter",
  "systemPrompt",
  "model",
  "provider",
  "subagents",
  "modelParams",
];

/**
 * Enforce privilege-monotonicity for an agent caller mutating `targetId`.
 *
 * - An agent may not modify its OWN toolFilter / systemPrompt / model / provider
 *   / subagents / modelParams (self-escalation guard).
 * - An agent may not grant another agent any high-impact tool it does not itself
 *   hold (widening guard) — neither via an allowlist nor by switching another
 *   agent to mode "all"/"blocklist" (which would implicitly widen it).
 *
 * No-op for operator callers.
 */
function enforceMonotonicity(
  caller: CallerContext,
  targetId: string,
  incoming: Partial<AgentDefinition>,
): void {
  if (caller.kind !== "agent") return;

  const isSelf = caller.agentId === targetId;

  if (isSelf) {
    for (const field of SELF_PROTECTED_FIELDS) {
      if (incoming[field] !== undefined) {
        throw new PrivilegeError(
          `Agents may not modify their own '${String(field)}'. This change requires an operator.`,
        );
      }
    }
  }

  const nextFilter = incoming.toolFilter;
  if (nextFilter !== undefined) {
    const callerHighImpact = grantedHighImpactTools(caller.toolFilter);

    // Switching a target to mode "all" or "blocklist" is an implicit widening:
    // those modes can only ever grant non-high-impact tools (high-impact tools
    // require explicit allowlist membership), but they still grant the full
    // non-high-impact surface. An agent caller must use an explicit allowlist
    // so the granted set is auditable and bounded.
    if (nextFilter.mode !== "allowlist") {
      throw new PrivilegeError(
        "Agents may only assign an allowlist tool filter to other agents (mode 'all'/'blocklist' is operator-only).",
      );
    }

    const requestedHighImpact = grantedHighImpactTools(nextFilter);
    for (const tool of requestedHighImpact) {
      if (!callerHighImpact.has(tool)) {
        throw new PrivilegeError(
          `Cannot grant '${tool}': the calling agent does not hold it. Agents cannot widen others beyond their own tool set.`,
        );
      }
    }
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
  caller: CallerContext = { kind: "operator" },
): Promise<string> {
  const merged = await getMergedAgentsWithSource();
  assertHashMatch(merged, baseHash);

  if (merged.some((a) => a.id === def.id)) {
    throw new Error(`Agent '${def.id}' already exists`);
  }

  enforceMonotonicity(caller, def.id, def);

  const validated = agentDefinitionSchema.parse(def);
  await upsertAgentOverride(validated.id, validated);

  const updated = await getMergedAgentsWithSource();
  return computeMergedAgentHash(updated);
}

export async function updateAgentInDb(
  id: string,
  partial: Partial<AgentDefinition>,
  baseHash: string,
  caller: CallerContext = { kind: "operator" },
): Promise<string> {
  const merged = await getMergedAgentsWithSource();
  assertHashMatch(merged, baseHash);

  const existing = merged.find((a) => a.id === id);
  if (!existing) {
    throw new Error(`Agent '${id}' not found`);
  }

  enforceMonotonicity(caller, id, partial);

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
  caller: CallerContext = { kind: "operator" },
): Promise<string> {
  if (caller.kind === "agent") {
    throw new PrivilegeError(
      "Deleting agents is operator-only. The calling agent cannot delete agents.",
    );
  }

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
