import { Hono } from "hono";
import { z } from "zod";
import type { AgentDefinition } from "../../agents/types";
import type { WebAppDeps } from "../app";
import { REDACTED_SENTINEL, stripRedactedKeys } from "../../config/io";
import {
  loadConfigWithOverrides,
  getMergedAgentsWithSource,
  computeMergedAgentHash,
} from "../../config/loader";
import {
  addAgentToDb,
  updateAgentInDb,
  removeAgentFromDb,
  AgentConflictError,
} from "../../config/agent-mutations";

import { readdir } from "node:fs/promises";
import {
  buildMainAgentPrompt,
  buildSubAgentPrompt,
} from "../../prompts/loader";
import { TEMPLATES } from "../../tools/agent-templates";

const PROMPTS_DIR = `${process.cwd()}/prompts`;
const SAFE_AGENT_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Determine whether an agent's prompt comes from files or inline config */
async function getAgentPromptFiles(): Promise<ReadonlySet<string>> {
  try {
    const entries = await readdir(`${PROMPTS_DIR}/agents`);
    return new Set(entries.filter((e) => e.endsWith(".md")));
  } catch {
    return new Set();
  }
}

function getPromptMeta(
  agentId: string,
  isDefault: boolean,
  promptFileSet: ReadonlySet<string>,
): { promptSource: "file" | "inline"; promptFiles: string[] } {
  if (isDefault) {
    return {
      promptSource: "file",
      promptFiles: ["SOUL.md", "WORKFLOW.md", "ORCHESTRATION.md", "TECH.md"],
    };
  }
  if (!promptFileSet.has(`${agentId}.md`)) {
    return { promptSource: "inline", promptFiles: [] };
  }
  return {
    promptSource: "file",
    promptFiles: ["TECH.md", `agents/${agentId}.md`],
  };
}

/** Resolve the effective system prompt (from files or inline config) */
async function resolvePrompt(
  agentId: string,
  isDefault: boolean,
  inlinePrompt: string,
): Promise<string> {
  if (isDefault) return buildMainAgentPrompt();
  const loaded = await buildSubAgentPrompt(agentId);
  return loaded ?? inlinePrompt;
}

const agentCreateSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "ID must be lowercase alphanumeric with hyphens",
    ),
  name: z.string().min(1),
  description: z.string().optional(),
  default: z.boolean().optional(),
  provider: z.enum(["openrouter", "agent-sdk", "alibaba"]).optional(),
  model: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  maxIterations: z.number().int().min(1).optional(),
  toolFilter: z
    .object({
      mode: z.enum(["all", "allowlist", "blocklist"]),
      tools: z.array(z.string()),
    })
    .optional(),
  subagents: z
    .object({
      allowAgents: z.array(z.string()),
      maxChildren: z.number().int().min(1).max(20),
    })
    .optional(),
  reasoning: z.boolean().optional(),
  stateless: z.boolean().optional(),
  maxInputLength: z.number().int().min(1).optional(),
  modelParams: z
    .object({
      thinkingMode: z.enum(["adaptive", "enabled", "disabled"]).optional(),
      thinkingBudget: z.number().int().min(1024).max(128_000).optional(),
      effort: z.enum(["low", "medium", "high", "max"]).optional(),
      extendedContext: z.boolean().optional(),
      maxBudgetUsd: z.number().min(0.01).max(100).optional(),
    })
    .optional(),
  mcpServers: z
    .object({
      browser: z.boolean().optional(),
      github: z.boolean().optional(),
      context7: z.boolean().optional(),
      sequentialThinking: z.boolean().optional(),
      dbhub: z.boolean().optional(),
      filesystem: z.boolean().optional(),
      git: z.boolean().optional(),
      qdrant: z.boolean().optional(),
      braveSearch: z.boolean().optional(),
      firecrawl: z.boolean().optional(),
      serena: z.boolean().optional(),
    })
    .optional(),
  hooks: z
    .object({
      auditLog: z.boolean().optional(),
      notifications: z.boolean().optional(),
    })
    .optional(),
  telegramBotToken: z.string().optional(),
  skills: z.array(z.string()).optional(),
  configHash: z.string().optional(),
});

const agentUpdateSchema = agentCreateSchema.omit({ id: true }).partial();

async function reloadRegistry(deps: WebAppDeps): Promise<void> {
  const config = await loadConfigWithOverrides();
  deps.agentRegistry.reload(config.agents, config.agent);
}

/* Tool list is now served dynamically from /api/tools via buildToolCatalog() */

export function createAgentRoutes(deps: WebAppDeps): Hono {
  const app = new Hono();

  app.get("/agents", async (c) => {
    await reloadRegistry(deps);

    const mergedWithSource = await getMergedAgentsWithSource();
    const sourceMap = new Map(mergedWithSource.map((a) => [a.id, a._source]));
    const promptFileSet = await getAgentPromptFiles();

    const agents = deps.agentRegistry.agents.map((a) => {
        const meta = getPromptMeta(a.id, a.default, promptFileSet);
        return {
          id: a.id,
          name: a.name,
          description: a.description,
          provider: a.provider,
          model: a.model,
          maxIterations: a.maxIterations,
          isDefault: a.default,
          toolFilter: a.toolFilter,
          subagents: a.subagents,
          telegramBotToken: a.telegramBotToken ? "configured" : undefined,
          reasoning: a.reasoning,
          stateless: a.stateless,
          maxInputLength: a.maxInputLength,
          modelParams: a.modelParams,
          mcpServers: a.mcpServers,
          hooks: a.hooks,
          skills: a.skills ?? [],
          promptSource: meta.promptSource,
          promptFiles: meta.promptFiles,
          source: sourceMap.get(a.id) ?? "file",
        };
      });

    const agentHash = computeMergedAgentHash(mergedWithSource);

    return c.json({
      success: true,
      data: agents,
      configHash: agentHash,
    });
  });

  app.get("/agents/templates", (c) => {
    return c.json({ success: true, data: TEMPLATES });
  });

  app.get("/agents/:id", async (c) => {
    const agentId = c.req.param("id");
    if (!SAFE_AGENT_ID.test(agentId)) {
      return c.json({ success: false, error: "Invalid agent ID" }, 400);
    }
    await reloadRegistry(deps);
    const agent = deps.agentRegistry.getById(agentId);
    if (!agent) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    const mergedWithSource = await getMergedAgentsWithSource();
    const sourceEntry = mergedWithSource.find((a) => a.id === agentId);
    const agentHash = computeMergedAgentHash(mergedWithSource);
    const promptFileSet = await getAgentPromptFiles();
    const meta = getPromptMeta(agentId, agent.default, promptFileSet);
    const resolvedPrompt = await resolvePrompt(
      agentId,
      agent.default,
      agent.systemPrompt,
    );

    return c.json({
      success: true,
      data: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        provider: agent.provider,
        model: agent.model,
        isDefault: agent.default,
        systemPrompt: resolvedPrompt,
        maxIterations: agent.maxIterations,
        toolFilter: agent.toolFilter,
        subagents: agent.subagents,
        reasoning: agent.reasoning,
        stateless: agent.stateless,
        maxInputLength: agent.maxInputLength,
        modelParams: agent.modelParams,
        mcpServers: agent.mcpServers,
        hooks: agent.hooks,
        skills: agent.skills ?? [],
        telegramBotToken: agent.telegramBotToken
          ? REDACTED_SENTINEL
          : undefined,
        promptSource: meta.promptSource,
        promptFiles: meta.promptFiles,
        source: sourceEntry?._source ?? "file",
      },
      configHash: agentHash,
    });
  });

  app.post("/agents", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = agentCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Validation failed",
        },
        400,
      );
    }

    const { configHash, ...agentData } = parsed.data;
    if (!configHash) {
      return c.json({ success: false, error: "configHash is required" }, 400);
    }

    if (agentData.telegramBotToken === REDACTED_SENTINEL) {
      return c.json(
        {
          success: false,
          error: "Provide a real token or omit telegramBotToken",
        },
        400,
      );
    }

    try {
      const newHash = await addAgentToDb(
        agentData as AgentDefinition,
        configHash,
      );
      await reloadRegistry(deps);
      return c.json(
        {
          success: true,
          message: `Agent '${agentData.id}' created.`,
          configHash: newHash,
        },
        201,
      );
    } catch (err) {
      if (err instanceof AgentConflictError) {
        return c.json({ success: false, error: err.message }, 409);
      }
      const msg = err instanceof Error ? err.message : "Failed to create agent";
      return c.json({ success: false, error: msg }, 500);
    }
  });

  app.put("/agents/:id", async (c) => {
    const agentId = c.req.param("id");
    if (!SAFE_AGENT_ID.test(agentId)) {
      return c.json({ success: false, error: "Invalid agent ID" }, 400);
    }

    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = agentUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Validation failed",
        },
        400,
      );
    }

    const { configHash, ...rawAgentData } = parsed.data;
    if (!configHash) {
      return c.json({ success: false, error: "configHash is required" }, 400);
    }

    const agentData = stripRedactedKeys(rawAgentData);

    try {
      const newHash = await updateAgentInDb(
        agentId,
        agentData as Partial<AgentDefinition>,
        configHash,
      );
      await reloadRegistry(deps);
      return c.json({
        success: true,
        message: `Agent '${agentId}' updated.`,
        configHash: newHash,
      });
    } catch (err) {
      if (err instanceof AgentConflictError) {
        return c.json({ success: false, error: err.message }, 409);
      }
      const msg = err instanceof Error ? err.message : "Failed to update agent";
      return c.json({ success: false, error: msg }, 500);
    }
  });

  app.delete("/agents/:id", async (c) => {
    const agentId = c.req.param("id");
    if (!SAFE_AGENT_ID.test(agentId)) {
      return c.json({ success: false, error: "Invalid agent ID" }, 400);
    }

    const agent = deps.agentRegistry.getById(agentId);
    if (agent?.default) {
      return c.json(
        { success: false, error: "The default agent cannot be deleted" },
        403,
      );
    }

    const configHash = c.req.query("configHash");
    if (!configHash) {
      return c.json(
        { success: false, error: "configHash query param is required" },
        400,
      );
    }

    try {
      const newHash = await removeAgentFromDb(agentId, configHash);
      await reloadRegistry(deps);
      return c.json({
        success: true,
        message: `Agent '${agentId}' deleted.`,
        configHash: newHash,
      });
    } catch (err) {
      if (err instanceof AgentConflictError) {
        return c.json({ success: false, error: err.message }, 409);
      }
      const msg = err instanceof Error ? err.message : "Failed to delete agent";
      return c.json({ success: false, error: msg }, 500);
    }
  });

  return app;
}
