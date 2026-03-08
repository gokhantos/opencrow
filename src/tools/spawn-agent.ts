import type { ToolDefinition, ToolCategory } from "./types";
import type { AgentRegistry } from "../agents/registry";
import type { ToolRegistry } from "./registry";
import type { SubAgentTracker } from "../agents/tracker";
import type { ResolvedAgent } from "../agents/types";
import type { ProgressEvent } from "../agent/types";
import { runAgentIsolated } from "../agents/runner";
import { createLogger } from "../logger";
import { routeTask } from "../agent/intelligent-router";
import { classifyTask } from "../agent/task-classifier";
import type { AgentRunResult } from "../agents/runner";

const log = createLogger("tool:spawn-agent");

/** Max retries before escalation */

export interface SpawnAgentToolConfig {
  readonly agentRegistry: AgentRegistry;
  readonly baseToolRegistry: ToolRegistry;
  readonly tracker: SubAgentTracker;
  readonly currentAgentId: string;
  readonly sessionId: string;
  readonly maxIterations: number;
  readonly buildRegistryForAgent?: (
    agent: ResolvedAgent,
  ) => ToolRegistry | null;
  readonly buildSystemPrompt?: (
    agent: ResolvedAgent,
    basePrompt: string,
  ) => Promise<string>;
  readonly onProgress?: (event: ProgressEvent) => void;
}

export function createSpawnAgentTool(
  config: SpawnAgentToolConfig,
): ToolDefinition {
  return {
    name: "spawn_agent",
    description:
      "Spawn a sub-agent to handle a specific task. The sub-agent runs to completion and returns its result. Use list_agents first to see available agents.",
    categories: ["system"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description:
            "The ID of the agent to spawn. Use list_agents to see options.",
        },
        task: {
          type: "string",
          description: "The task description for the sub-agent to execute.",
        },
        timeout_seconds: {
          type: "number",
          description: "Timeout in seconds (default: 120).",
        },
      },
      required: ["task"],
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const task = input.task as string;
      if (!task || task.length > 50_000) {
        return {
          output: task
            ? "Error: task too long (max 50,000 chars)"
            : "Error: task is required",
          isError: true,
        };
      }
      const requestedAgentId = (input.agent_id as string) ?? undefined;

      const currentAgent = config.agentRegistry.getById(config.currentAgentId);
      if (!currentAgent) {
        return { output: "Error: current agent not found", isError: true };
      }

      const allowedAgents = currentAgent.subagents.allowAgents;
      if (allowedAgents.length === 0) {
        return {
          output: "Error: no sub-agents allowed for this agent",
          isError: true,
        };
      }

      // Determine target agent: explicit request > intelligent routing > default
      let targetAgentId: string;
      let routingReason = "explicit selection";
      let confidence: "high" | "medium" | "low" = "high";
      let routedDomain = "unknown";
      let classification: Awaited<ReturnType<typeof classifyTask>> | null =
        null;

      if (requestedAgentId) {
        // User explicitly requested an agent - validate it's allowed
        const isAllowed =
          allowedAgents.includes("*") ||
          allowedAgents.includes(requestedAgentId);
        if (!isAllowed) {
          return {
            output: `Error: agent "${requestedAgentId}" is not in the allowed list: ${allowedAgents.join(", ")}`,
            isError: true,
          };
        }
        targetAgentId = requestedAgentId;
      } else if (allowedAgents.includes("*") || allowedAgents.length > 1) {
        // Multiple agents allowed - use intelligent routing
        try {
          // Classify the task to determine domain
          classification = await classifyTask(task);

          // Route to best agent for this domain
          const routing = await routeTask(classification!.domain, task);
          targetAgentId = routing.selectedAgentId;
          routingReason = routing.decisionReason;
          confidence = routing.confidence;

          routedDomain = classification.domain;

          log.info("Intelligent routing selected agent", {
            task: task.slice(0, 100),
            domain: routedDomain,
            selectedAgent: targetAgentId,
            reason: routingReason,
            confidence,
          });
        } catch (err) {
          log.warn("Intelligent routing failed, using fallback", {
            error: String(err),
          });
          // Fallback to first allowed agent (excluding wildcard) or first available agent
          const nonWildcardAgents = allowedAgents.filter((id) => id !== "*");
          targetAgentId =
            nonWildcardAgents[0] ||
            config.agentRegistry.getDefault()?.id ||
            "general-purpose";
          routingReason = "routing failed, using fallback";
          confidence = "low";
        }
      } else {
        // Only one agent allowed - use it
        targetAgentId = allowedAgents.filter((id) => id !== "*")[0] ?? "general-purpose";
        routingReason = "only one agent allowed";
        confidence = "high";
      }

      if (!targetAgentId) {
        return {
          output: "Error: no agent_id specified and no default agent available",
          isError: true,
        };
      }

      // Double-check: intelligent router might pick an agent not in allowed list
      const isAllowed =
        allowedAgents.includes("*") || allowedAgents.includes(targetAgentId);
      if (!isAllowed) {
        // Intelligent router picked an agent not in the allowed list - fall back
        log.warn("Router selected disallowed agent, falling back", {
          selectedAgent: targetAgentId,
          allowedAgents,
        });
        targetAgentId =
          allowedAgents.find((id) => id !== "*") || "general-purpose";
        routingReason = "router picked disallowed agent, using fallback";
        confidence = "low";
      }

      const targetAgent = config.agentRegistry.getById(targetAgentId);
      if (!targetAgent) {
        return {
          output: `Error: agent "${targetAgentId}" not found`,
          isError: true,
        };
      }

      const sessionKey = `${config.currentAgentId}`;

      const activeCount = config.tracker.countActiveForSession(sessionKey);
      if (activeCount >= currentAgent.subagents.maxChildren) {
        return {
          output: `Error: max children limit reached (${currentAgent.subagents.maxChildren})`,
          isError: true,
        };
      }

      // --- Single agent execution with context propagation + retry ---
      return executeSingleAgent(
        config,
        targetAgentId,
        task,
        sessionKey,
        routedDomain,
      );
    },
  };
}

/** Execute a single agent with context propagation and retry/escalation */
async function executeSingleAgent(
  config: SpawnAgentToolConfig,
  targetAgentId: string,
  task: string,
  sessionKey: string,
  routedDomain: string,
): Promise<{ output: string; isError: boolean }> {
  const targetAgent = config.agentRegistry.getById(targetAgentId);
  if (!targetAgent) {
    return { output: `Error: agent "${targetAgentId}" not found`, isError: true };
  }

  const agentMaxIterations = targetAgent.maxIterations ?? config.maxIterations;

  // --- Improvement #1: Context propagation ---
  const previousResults = await config.tracker.getCompletedForSession(sessionKey);

  const runId = crypto.randomUUID();
  const abortController = new AbortController();
  await config.tracker.register({
    id: runId,
    parentAgentId: config.currentAgentId,
    parentSessionKey: sessionKey,
    childAgentId: targetAgentId,
    childSessionKey: `subagent:${runId}`,
    task,
    abortController,
  });

  // Log agent's current performance score for observability
  try {
    const { getAgentScore } = await import("../agent/scoring-engine");
    const score = await getAgentScore(targetAgentId, routedDomain || null);
    if (score) {
      log.info("Agent score at spawn time", {
        agentId: targetAgentId,
        domain: routedDomain,
        score: score.score.toFixed(3),
        successRate: (score.successRate * 100).toFixed(0) + "%",
        totalTasks: score.totalTasks,
      });
    }
  } catch {
    // score lookup is non-fatal
  }

  log.info("Spawning sub-agent", {
    runId,
    parentAgent: config.currentAgentId,
    childAgent: targetAgentId,
    priorResults: previousResults.length,
  });

  config.onProgress?.({
    type: "subagent_start",
    agentId: config.currentAgentId,
    childAgent: targetAgentId,
    task,
  });

  // --- Attempt execution with retry and escalation (Improvement #5) ---
  try {
    const result = await runWithRetryAndEscalation(
      config,
      targetAgentId,
      task,
      agentMaxIterations,
      previousResults,
      abortController.signal,
    );

    config.onProgress?.({
      type: "subagent_done",
      agentId: config.currentAgentId,
      childAgent: targetAgentId,
    });

    await config.tracker.complete(runId, result.text);

    const meta = [
      "\n---",
      `[Worker: ${result.toolUseCount ?? 0} tool calls, ${result.usage?.inputTokens ?? 0} input / ${result.usage?.outputTokens ?? 0} output tokens]`,
    ].join("\n");

    return { output: result.text + meta, isError: false };
  } catch (error) {
    config.onProgress?.({
      type: "subagent_done",
      agentId: config.currentAgentId,
      childAgent: targetAgentId,
    });

    const message = error instanceof Error ? error.message : String(error);
    await config.tracker.fail(runId, message);

    log.error("Sub-agent failed after retries", { runId, error: message });
    return { output: `Sub-agent error: ${message}`, isError: true };
  }
}

/** Run agent with automatic retry and escalation on failure */
async function runWithRetryAndEscalation(
  config: SpawnAgentToolConfig,
  agentId: string,
  task: string,
  maxIterations: number,
  previousResults: ReadonlyArray<{ agentId: string; result: string }>,
  abortSignal?: AbortSignal,
): Promise<AgentRunResult> {
  // First attempt
  try {
    return await runAgentIsolated({
      agentRegistry: config.agentRegistry,
      baseToolRegistry: config.baseToolRegistry,
      agentId,
      task,
      maxIterations,
      buildRegistryForAgent: config.buildRegistryForAgent,
      buildSystemPrompt: config.buildSystemPrompt,
      onProgress: config.onProgress,
      previousResults,
      abortSignal,
    });
  } catch (firstError) {
    const firstMessage =
      firstError instanceof Error ? firstError.message : String(firstError);
    log.warn("First attempt failed, retrying with error context", {
      agentId,
      error: firstMessage,
    });

    // Retry with error context appended
    try {
      if (abortSignal?.aborted) throw new Error("Cancelled by user");
      const enrichedTask = `${task}\n\n---\n## Previous Attempt Failed\nError: ${firstMessage}\nPlease try a different approach to avoid the same error.`;
      return await runAgentIsolated({
        agentRegistry: config.agentRegistry,
        baseToolRegistry: config.baseToolRegistry,
        agentId,
        task: enrichedTask,
        maxIterations,
        buildRegistryForAgent: config.buildRegistryForAgent,
        buildSystemPrompt: config.buildSystemPrompt,
        onProgress: config.onProgress,
        previousResults,
        abortSignal,
      });
    } catch (retryError) {
      const retryMessage =
        retryError instanceof Error ? retryError.message : String(retryError);
      log.warn("Retry failed, attempting escalation", {
        agentId,
        error: retryMessage,
      });

      // Escalate to a different agent
      try {
        // Simple escalation logic: backend → architect, otherwise → backend
        const escalationTarget =
          agentId === "backend" ? "architect" : "backend";

        if (
          escalationTarget &&
          escalationTarget !== agentId &&
          config.agentRegistry.getById(escalationTarget)
        ) {
          log.info("Escalating to different agent", {
            from: agentId,
            to: escalationTarget,
          });

          const escalatedAgent =
            config.agentRegistry.getById(escalationTarget);
          return await runAgentIsolated({
            agentRegistry: config.agentRegistry,
            baseToolRegistry: config.baseToolRegistry,
            agentId: escalationTarget,
            task: `${task}\n\n---\n## Escalated from ${agentId}\nPrevious agent failed twice. Errors:\n1. ${firstMessage}\n2. ${retryMessage}`,
            maxIterations:
              escalatedAgent?.maxIterations ?? config.maxIterations,
            buildRegistryForAgent: config.buildRegistryForAgent,
            buildSystemPrompt: config.buildSystemPrompt,
            onProgress: config.onProgress,
            previousResults,
            abortSignal,
          });
        }
      } catch (escalationError) {
        log.warn("Escalation failed", {
          error: String(escalationError),
        });
      }

      // All attempts exhausted
      throw retryError;
    }
  }
}
