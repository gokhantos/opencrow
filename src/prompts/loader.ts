import { createLogger } from "../logger";

const log = createLogger("prompts:loader");

const PROMPTS_DIR = `${process.cwd()}/prompts`;

/** Cache prompt files in memory; key = relative path from prompts/ */
const cache = new Map<string, string>();

async function loadPromptFile(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const path = `${PROMPTS_DIR}/${name}`;
  try {
    const file = Bun.file(path);
    const content = await file.text();
    cache.set(name, content);
    return content;
  } catch (err) {
    log.warn("Failed to load prompt file", { name, error: err });
    return "";
  }
}

/** Load a prompt file only if it exists, returning empty string otherwise */
async function loadOptionalPromptFile(name: string): Promise<string> {
  const path = `${PROMPTS_DIR}/${name}`;
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) return "";
  return loadPromptFile(name);
}

/**
 * Build the full system prompt for the main OpenCrow agent.
 * Concatenates: SOUL.md + WORKFLOW.md + ORCHESTRATION.md + TECH.md
 */
export async function buildMainAgentPrompt(): Promise<string> {
  const parts = await Promise.all([
    loadPromptFile("SOUL.md"),
    loadPromptFile("TOOLS.md"),
    loadPromptFile("WORKFLOW.md"),
    loadPromptFile("ORCHESTRATION.md"),
    loadPromptFile("TECH.md"),
  ]);

  const prompt = parts.filter(Boolean).join("\n\n---\n\n");

  log.info("Built main agent prompt", {
    length: prompt.length,
    sections: parts.filter(Boolean).length,
  });

  return prompt;
}

/**
 * Build the system prompt for a sub-agent.
 * Concatenates: TECH.md + agents/{agentId}.md
 * Returns null if no agent-specific prompt file exists (caller should fall
 * back to the agent's inline systemPrompt).
 */
export async function buildSubAgentPrompt(
  agentId: string,
): Promise<string | null> {
  const agentContent = await loadOptionalPromptFile(`agents/${agentId}.md`);
  if (!agentContent) {
    log.info("No prompt file for agent, using inline prompt", { agentId });
    return null;
  }

  const techContent = await loadPromptFile("TECH.md");
  const toolsContent = await loadOptionalPromptFile("TOOLS.md");
  const prompt = [techContent, toolsContent, agentContent]
    .filter(Boolean)
    .join("\n\n---\n\n");

  log.info("Built sub-agent prompt", {
    agentId,
    length: prompt.length,
  });

  return prompt;
}

/** Clear the prompt cache (useful for dev/hot-reload) */
export function clearPromptCache(): void {
  cache.clear();
}
