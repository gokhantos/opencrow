import type { Workflow } from "../store/workflows";
import type { EngineDeps } from "./types";
import type { WorkflowExecution as StoreExecution } from "../store/workflows";
import {
  createExecution,
  updateExecution,
  createStep,
  updateStep,
} from "../store/workflows";
import { validateWorkflowForExecution, topologicalSort } from "./validation";
import { interpolate, interpolateObject } from "./interpolation";
import { evaluateCondition } from "./expression";
import { runAgentIsolated } from "../agents/runner";
import { chat } from "../agent/chat";
import type { ConversationMessage } from "../agent/types";
import { readSkillContent } from "../skills/loader";
import { createLogger } from "../logger";
import { executionEvents } from "./events";

const log = createLogger("workflows:engine");

const MAX_STEPS = 100;
const TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — agentic tasks need subprocess boot + MCP init + tool calls
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;

/** MCP flag keys that can be overridden per workflow node. */
const MCP_FLAGS = [
  "browserEnabled",
  "githubEnabled",
  "context7Enabled",
  "sequentialThinkingEnabled",
  "dbhubEnabled",
  "filesystemEnabled",
  "gitEnabled",
  "qdrantEnabled",
  "braveSearchEnabled",
  "firecrawlEnabled",
  "webSearchEnabled",
  "serenaEnabled",
] as const;

function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("process exited") ||
    msg.includes("process aborted") ||
    msg.includes("ECONNRESET") ||
    msg.includes("overloaded")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type StoredWorkflow = Workflow;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Create an execution record and kick off the async run.
 * Returns the executionId immediately so callers can respond with 202.
 */
export async function startWorkflowExecution(
  workflow: StoredWorkflow,
  triggerInput: Record<string, unknown>,
  deps: EngineDeps,
): Promise<{ executionId: string }> {
  const validation = validateWorkflowForExecution(workflow.nodes, workflow.edges);
  if (!validation.valid) {
    throw new Error(
      `Workflow "${workflow.name}" is invalid: ${validation.errors.join("; ")}`,
    );
  }

  const execution = await createExecution({
    workflowId: workflow.id,
    triggerInput,
  });

  // Fire-and-forget — if runExecution itself throws (e.g. its own catch block
  // failed to persist the failure), attempt a best-effort status update here.
  runExecution(execution.id, workflow, triggerInput, deps).catch((err) => {
    log.error("Background workflow execution failed unexpectedly", {
      workflowId: workflow.id,
      executionId: execution.id,
      err,
    });
    updateExecution(execution.id, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      finishedAt: now(),
    }).catch((updateErr) => {
      log.error("Failed to mark execution as failed after background error", {
        executionId: execution.id,
        updateErr,
      });
    });
  });

  return { executionId: execution.id };
}

/**
 * Execute a workflow graph synchronously (awaitable).
 * Creates execution + step records in the DB, iterates nodes in
 * topological order, and updates the execution on completion or failure.
 */
export async function executeWorkflow(
  workflow: StoredWorkflow,
  triggerInput: Record<string, unknown>,
  deps: EngineDeps,
): Promise<StoreExecution> {
  const validation = validateWorkflowForExecution(workflow.nodes, workflow.edges);
  if (!validation.valid) {
    throw new Error(
      `Workflow "${workflow.name}" is invalid: ${validation.errors.join("; ")}`,
    );
  }

  const execution = await createExecution({
    workflowId: workflow.id,
    triggerInput,
  });

  return runExecution(execution.id, workflow, triggerInput, deps);
}

async function runExecution(
  executionId: string,
  workflow: StoredWorkflow,
  triggerInput: Record<string, unknown>,
  deps: EngineDeps,
): Promise<StoreExecution> {
  const trigger = workflow.nodes.find((n) => n.type === "trigger")!;

  // Mark as running
  let execution = (await updateExecution(executionId, {
    status: "running",
    startedAt: now(),
  }))!;
  executionEvents.emit(executionId, { type: "execution", status: "running" });

  // AbortController for timeout
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const sortedNodes = topologicalSort(workflow.nodes, workflow.edges, trigger.id);
    const outputs = new Map<string, unknown>();

    // Seed trigger output with triggerInput.
    // Store under both the real node ID and "trigger" so templates like
    // {{trigger.output}} resolve correctly.
    outputs.set(trigger.id, triggerInput);
    outputs.set("trigger", triggerInput);

    // Track which nodes are reachable (condition branching)
    const reachable = new Set<string>(sortedNodes.map((n) => n.id));

    // Build edge lookup for condition branching
    const edgesBySource = new Map<string, typeof workflow.edges[number][]>();
    for (const edge of workflow.edges) {
      const list = edgesBySource.get(edge.source) ?? [];
      edgesBySource.set(edge.source, [...list, edge]);
    }

    let stepCount = 0;

    for (const node of sortedNodes) {
      if (node.type === "trigger") continue; // trigger already seeded

      if (!reachable.has(node.id)) {
        const step = await createStep({
          executionId,
          nodeId: node.id,
          nodeType: node.type,
        });
        await updateStep(step.id, { status: "skipped" });
        executionEvents.emit(executionId, { type: "step", nodeId: node.id, status: "skipped" });
        continue;
      }

      if (stepCount >= MAX_STEPS) {
        throw new Error(`Workflow exceeded maximum step limit of ${MAX_STEPS}`);
      }

      if (controller.signal.aborted) {
        throw new Error("Workflow execution timed out");
      }

      stepCount++;

      const step = await createStep({
        executionId,
        nodeId: node.id,
        nodeType: node.type,
      });

      await updateStep(step.id, { status: "running", startedAt: now() });
      executionEvents.emit(executionId, { type: "step", nodeId: node.id, status: "running" });

      try {
        const nodeOutput = await executeNode(
          node,
          outputs,
          deps,
          controller.signal,
          executionId,
        );

        outputs.set(node.id, nodeOutput);

        await updateStep(step.id, {
          status: "completed",
          output: nodeOutput,
          finishedAt: now(),
        });
        executionEvents.emit(executionId, {
          type: "step",
          nodeId: node.id,
          status: "completed",
          output: nodeOutput,
        });

        // Handle condition branching
        if (node.type === "condition") {
          const conditionResult = nodeOutput as boolean;
          const outEdges = edgesBySource.get(node.id) ?? [];
          for (const edge of outEdges) {
            const handle = edge.sourceHandle ?? null;
            const isTrue = handle === "true" || handle === null;
            const shouldFollow = conditionResult ? isTrue : !isTrue;
            if (!shouldFollow) {
              markSubtreeUnreachable(edge.target, edgesBySource, reachable);
            }
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error("Step failed", { nodeId: node.id, nodeType: node.type, err });
        await updateStep(step.id, {
          status: "failed",
          error: errMsg,
          finishedAt: now(),
        });
        executionEvents.emit(executionId, {
          type: "step",
          nodeId: node.id,
          status: "failed",
          error: errMsg,
        });
        throw err;
      }
    }

    // Determine final result — last "output" node, or last non-trigger outputs entry
    const outputNode = [...sortedNodes].reverse().find((n) => n.type === "output");
    const lastNodeId = sortedNodes[sortedNodes.length - 1]?.id ?? "";
    const finalResult = outputNode
      ? outputs.get(outputNode.id)
      : outputs.get(lastNodeId);

    execution = (await updateExecution(executionId, {
      status: "completed",
      result: finalResult ?? null,
      finishedAt: now(),
    }))!;
    executionEvents.emit(executionId, {
      type: "execution",
      status: "completed",
      result: finalResult ?? null,
    });

    log.info("Workflow completed", {
      workflowId: workflow.id,
      executionId,
      steps: stepCount,
    });

    return execution;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    execution = (await updateExecution(executionId, {
      status: "failed",
      error: errMsg,
      finishedAt: now(),
    }))!;
    executionEvents.emit(executionId, {
      type: "execution",
      status: "failed",
      error: errMsg,
    });

    log.error("Workflow failed", {
      workflowId: workflow.id,
      executionId,
      err,
    });

    return execution;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ---------------------------------------------------------------------------
// Node execution
// ---------------------------------------------------------------------------

async function executeNode(
  node: StoredWorkflow["nodes"][number],
  outputs: ReadonlyMap<string, unknown>,
  deps: EngineDeps,
  abortSignal: AbortSignal,
  executionId: string,
): Promise<unknown> {
  const data = node.data;

  switch (node.type) {
    case "agent":
      return executeAgentNode(node.id, data, outputs, deps, abortSignal, executionId);

    case "tool":
      return executeToolNode(node.id, data, outputs, deps);

    case "skill":
      return executeSkillNode(data);

    case "condition":
      return executeConditionNode(node.id, data, outputs);

    case "transform":
      return executeTransformNode(node.id, data, outputs);

    case "output":
      return executeOutputNode(data, outputs);

    default:
      log.warn("Unknown node type — skipping", { nodeId: node.id, type: node.type });
      return null;
  }
}

async function executeAgentNode(
  nodeId: string,
  data: Record<string, unknown>,
  outputs: ReadonlyMap<string, unknown>,
  deps: EngineDeps,
  abortSignal: AbortSignal,
  executionId: string,
): Promise<unknown> {
  const agentId = data.agentId as string | undefined;
  if (!agentId) {
    throw new Error(`Agent node "${nodeId}" is missing agentId`);
  }

  const promptTemplate = (data.prompt as string | undefined) ?? "{{trigger.output}}";
  let task = interpolate(promptTemplate, outputs);

  // Guard against empty prompts — the Anthropic API rejects empty text blocks
  // with "cache_control cannot be set for empty text blocks" (400).
  if (!task.trim()) {
    task = "Execute the task described in your system prompt.";
  }

  // Prefer buildAgentOptions (from bootstrap) which includes sdkHooks, enriched
  // system prompt, observation blocks, etc.  This matches the working Telegram /
  // web-chat code path.  Fall back to runAgentIsolated for simpler setups.
  if (deps.buildAgentOptions) {
    const agent = deps.agentRegistry.getById(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // Progress callback that forwards agent events to the SSE stream
    const onProgress = (event: ProgressEvent): void => {
      const summary =
        event.type === "tool_start" ? event.tool :
        event.type === "tool_done" ? event.tool :
        event.type === "thinking" ? event.summary :
        event.type === "text_output" ? event.preview :
        event.type === "complete" ? "complete" :
        undefined;
      executionEvents.emit(executionId, {
        type: "agent_progress",
        nodeId,
        agentId,
        progressType: event.type,
        detail: summary,
      });
    };

    const options = await deps.buildAgentOptions(agent, onProgress);

    // Strip heavyweight MCP servers AND built-in web tools for workflow execution
    // unless explicitly enabled in the workflow node data.  This avoids spawning
    // npx subprocesses (playwright, context7, github, etc.) that may crash the
    // Claude Code subprocess, and disables WebSearch/WebFetch by default.
    const mcpOverrides: Record<string, boolean> = {};
    for (const flag of MCP_FLAGS) {
      mcpOverrides[flag] = (data[flag] as boolean) ?? false;
    }

    const messages: readonly ConversationMessage[] = [
      { role: "user", content: task, timestamp: Math.floor(Date.now() / 1000) },
    ];

    log.info("Running workflow agent via buildAgentOptions", {
      agentId,
      provider: agent.provider,
      model: options.model,
      nodeId,
      toolsEnabled: options.toolsEnabled,
      mcpOverrides,
      hasSdkHooks: Boolean(options.sdkHooks),
    });

    const workflowOptions = {
      ...options,
      ...mcpOverrides,
      abortSignal,
      usageContext: { channel: "workflow" as const, chatId: nodeId, source: "workflow" as const },
    };

    // Retry with exponential backoff for transient errors.
    // NOTE: Retrying agent calls is not strictly safe for non-idempotent operations
    // (e.g. the agent wrote a file before the subprocess crashed).  We accept this
    // risk because "process exited" failures typically happen during startup, before
    // any tool use.
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (abortSignal.aborted) {
        throw new Error("Workflow execution aborted");
      }
      try {
        const response = await chat(messages, workflowOptions);

        log.info("Workflow agent completed", {
          agentId,
          nodeId,
          toolUseCount: response.toolUseCount,
          attempt,
        });

        return response.text;
      } catch (err) {
        if (!isRetryableError(err) || attempt === MAX_RETRIES) {
          throw err;
        }
        const delayMs = BASE_DELAY_MS * 2 ** attempt;
        log.warn("Workflow agent transient error, retrying", {
          agentId,
          nodeId,
          attempt,
          delayMs,
          error: err instanceof Error ? err.message : String(err),
        });
        await delay(delayMs);
      }
    }

    // Unreachable — the loop always returns or throws
    throw new Error("Unexpected: retry loop exited without result");
  }

  // Prefer buildAgentOptions (from bootstrap) which includes sdkHooks, enriched
  // system prompt, observation blocks, etc.  This matches the working Telegram /
  // web-chat code path.  Fall back to runAgentIsolated for simpler setups.
  if (deps.buildAgentOptions) {
    const agent = deps.agentRegistry.getById(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const options = await deps.buildAgentOptions(agent);

    const messages: readonly ConversationMessage[] = [
      { role: "user", content: task, timestamp: Math.floor(Date.now() / 1000) },
    ];

    log.info("Running workflow agent via buildAgentOptions", {
      agentId,
      provider: agent.provider,
      nodeId,
    });

    const response = await chat(messages, {
      ...options,
      abortSignal,
      usageContext: { channel: "workflow" as const, chatId: nodeId, source: "workflow" as const },
    });

    log.info("Workflow agent completed", {
      agentId,
      nodeId,
      toolUseCount: response.toolUseCount,
    });

    return response.text;
  }

  const result = await runAgentIsolated({
    agentRegistry: deps.agentRegistry,
    baseToolRegistry: deps.toolRegistry,
    agentId,
    task,
    abortSignal,
  });

  return result.text;
}

async function executeToolNode(
  nodeId: string,
  data: Record<string, unknown>,
  outputs: ReadonlyMap<string, unknown>,
  deps: EngineDeps,
): Promise<unknown> {
  if (!deps.toolRegistry) {
    throw new Error(
      `Tool node "${nodeId}" requires a tool registry but none was provided`,
    );
  }

  const toolName = data.toolName as string | undefined;
  if (!toolName) {
    throw new Error(`Tool node "${nodeId}" is missing toolName`);
  }

  const rawInput = (data.input as Record<string, unknown> | undefined) ?? {};
  const interpolatedInput = interpolateObject(rawInput, outputs) as Record<
    string,
    unknown
  >;

  const result = await deps.toolRegistry.executeTool(toolName, interpolatedInput);
  if (result.isError) {
    throw new Error(`Tool "${toolName}" failed: ${result.output}`);
  }
  return result.output;
}

async function executeSkillNode(data: Record<string, unknown>): Promise<unknown> {
  const skillId = data.skillId as string | undefined;
  if (!skillId) {
    throw new Error("Skill node is missing skillId");
  }

  const content = await readSkillContent(skillId);
  if (!content) {
    throw new Error(`Skill "${skillId}" not found`);
  }
  return content;
}

function executeConditionNode(
  nodeId: string,
  data: Record<string, unknown>,
  outputs: ReadonlyMap<string, unknown>,
): unknown {
  const expression = data.expression as string | undefined;
  if (!expression) {
    throw new Error(`Condition node "${nodeId}" is missing expression`);
  }

  const context: Record<string, unknown> = {};
  for (const [key, value] of outputs) {
    context[key] = value;
  }

  return evaluateCondition(expression, context);
}

function executeTransformNode(
  nodeId: string,
  data: Record<string, unknown>,
  outputs: ReadonlyMap<string, unknown>,
): unknown {
  const template = data.template as string | undefined;
  if (!template) {
    throw new Error(`Transform node "${nodeId}" is missing template`);
  }
  return interpolate(template, outputs);
}

function executeOutputNode(
  data: Record<string, unknown>,
  outputs: ReadonlyMap<string, unknown>,
): unknown {
  const template = data.template as string | undefined;
  if (template) {
    return interpolate(template, outputs);
  }

  // Default: return the last stored output value
  const lastOutput = [...outputs.values()].at(-1);
  return lastOutput ?? null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function markSubtreeUnreachable(
  nodeId: string,
  edgesBySource: ReadonlyMap<string, readonly { readonly target: string }[]>,
  reachable: Set<string>,
  visited: Set<string> = new Set(),
): void {
  if (!reachable.has(nodeId) || visited.has(nodeId)) return;
  visited.add(nodeId);
  reachable.delete(nodeId);
  for (const edge of edgesBySource.get(nodeId) ?? []) {
    markSubtreeUnreachable(edge.target, edgesBySource, reachable, visited);
  }
}
