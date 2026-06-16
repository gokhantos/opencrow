import { z } from "zod";

/* ===============================================
   Agent Form schema (shared between Create & Edit)
   =============================================== */
export const agentFormSchema = z.object({
  id: z.string(),
  name: z.string().min(1, "Name is required"),
  description: z.string(),
  provider: z.string(),
  model: z.string(),
  maxIterations: z.number().int().min(1).max(500),
  reasoning: z.boolean(),
  thinkingMode: z.enum(["adaptive", "enabled", "disabled"]),
  thinkingBudget: z.number().int(),
  effort: z.enum(["low", "medium", "high", "max"]),
  extendedContext: z.boolean(),
  stateless: z.boolean(),
  maxInputLength: z.coerce.number().int().min(0).default(0),
  systemPrompt: z.string(),
  toolMode: z.enum(["all", "allowlist", "blocklist"]),
  selectedTools: z.array(z.string()),
  allowAgents: z.string(),
  maxChildren: z.number().int().min(1).max(20),
  telegramBotToken: z.string(),
  mcpBrowser: z.boolean(),
  mcpGithub: z.boolean(),
  mcpContext7: z.boolean(),
  mcpSeqThinking: z.boolean(),
  mcpDbhub: z.boolean(),
  mcpFilesystem: z.boolean(),
  mcpGit: z.boolean(),
  mcpQdrant: z.boolean(),
  mcpBraveSearch: z.boolean(),
  mcpFirecrawl: z.boolean(),
  mcpSerena: z.boolean(),
  hookAuditLog: z.boolean(),
  hookNotifications: z.boolean(),
  selectedSkills: z.array(z.string()),
});

export type AgentFormValues = z.infer<typeof agentFormSchema>;
