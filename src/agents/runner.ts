import type {
  AgentResponse,
  AiProvider,
  ConversationMessage,
  ProgressEvent,
  UsageContext,
} from "../agent/types";
import type { AgentRegistry } from "./registry";
import type { ResolvedAgent } from "./types";
import type { ToolRegistry } from "../tools/registry";
import { chat } from "../agent/chat";
import { getAgentMemories, formatMemoryBlock } from "../store/memory";
import { createLogger } from "../logger";

const log = createLogger("agents:runner");

/** Only inject memories for non-trivial tasks (> 50 chars) */
const MIN_TASK_LENGTH_FOR_MEMORY = 50;

export interface AgentRunInput {
  readonly agentRegistry: AgentRegistry;
  readonly baseToolRegistry: ToolRegistry | null;
  readonly agentId: string;
  readonly task: string;
  readonly maxIterations?: number;
  readonly buildRegistryForAgent?: (
    agent: ResolvedAgent,
  ) => ToolRegistry | null;
  readonly buildSystemPrompt?: (
    agent: ResolvedAgent,
    basePrompt: string,
  ) => Promise<string>;
  readonly onProgress?: (event: ProgressEvent) => void;
  readonly usageContext?: UsageContext;
  /** Results from prior sub-agent runs in the same chain (for context propagation) */
  readonly previousResults?: ReadonlyArray<{
    readonly agentId: string;
    readonly result: string;
  }>;
  /** Optional abort signal to cancel the agent run mid-flight */
  readonly abortSignal?: AbortSignal;
}

export interface AgentRunResult {
  readonly text: string;
  readonly provider: AiProvider;
  readonly toolUseCount?: number;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

export async function runAgentIsolated(
  input: AgentRunInput,
): Promise<AgentRunResult> {
  const agent = input.agentRegistry.getById(input.agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${input.agentId}`);
  }

  const messages: readonly ConversationMessage[] = [
    {
      role: "user",
      content: input.task,
      timestamp: Math.floor(Date.now() / 1000),
    },
  ];

  // Conditional memory: only inject for non-trivial tasks
  const shouldInjectMemory = input.task.length >= MIN_TASK_LENGTH_FOR_MEMORY;
  const memories = shouldInjectMemory
    ? await getAgentMemories(input.agentId)
    : [];
  const memoryBlock = formatMemoryBlock(memories);

  // Build context from prior agent results (chain context propagation)
  let contextBlock = "";
  if (input.previousResults && input.previousResults.length > 0) {
    const sections = input.previousResults.map(
      (r) => `### ${r.agentId}\n${r.result.slice(0, 2000)}`,
    );
    contextBlock = `## Prior Agent Results\n${sections.join("\n\n")}`;
  }

  // Build system prompt: inline prompt + memories + context
  const agentPrompt = agent.systemPrompt;
  const basePrompt = [agentPrompt, memoryBlock, contextBlock]
    .filter(Boolean)
    .join("\n\n");
  const systemPrompt = input.buildSystemPrompt
    ? await input.buildSystemPrompt(agent, basePrompt)
    : basePrompt;

  const maxIterations = input.maxIterations ?? 100;

  let registry: ToolRegistry | null = null;
  if (input.buildRegistryForAgent) {
    registry = input.buildRegistryForAgent(agent);
  } else if (input.baseToolRegistry) {
    registry = input.baseToolRegistry.withFilter(agent.toolFilter);
  }

  const options = {
    systemPrompt,
    model: agent.model,
    provider: agent.provider,
    toolsEnabled: registry !== null,
    toolRegistry: registry ?? undefined,
    maxToolIterations: maxIterations,
    agentId: agent.id,
    onProgress: input.onProgress,
    usageContext: input.usageContext,
    abortSignal: input.abortSignal,
  };

  log.info("Running isolated agent", {
    agentId: input.agentId,
    provider: agent.provider,
    hasTools: registry !== null,
  });

  const response: AgentResponse = await chat(messages, options);

  log.info("Isolated agent completed", {
    agentId: input.agentId,
    toolUseCount: response.toolUseCount,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
  });

  return {
    text: response.text,
    provider: response.provider,
    toolUseCount: response.toolUseCount,
    usage: response.usage,
  };
}
