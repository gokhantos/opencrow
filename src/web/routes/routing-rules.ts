import { Hono } from "hono";
import { z } from "zod";
import {
  listRoutingRules,
  addRoutingRule,
  updateRoutingRule,
  removeRoutingRule,
  resolveAgentForMessage,
} from "../../store/routing-rules";
import type { WebAppDeps } from "../app";
import { createLogger } from "../../logger";

const log = createLogger("routing-rules-api");

const ruleCreateSchema = z.object({
  channel: z.string().min(1),
  matchType: z.enum(["chat", "user", "group", "pattern"]),
  matchValue: z.string().min(1),
  agentId: z.string().min(1),
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true),
  notes: z.string().optional(),
});

const ruleUpdateSchema = z.object({
  agentId: z.string().min(1).optional(),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
  notes: z.string().optional(),
});

const resolveSchema = z.object({
  channel: z.string().min(1),
  chatId: z.string().min(1),
  senderId: z.string().min(1),
});

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export function createRoutingRulesRoutes(_deps?: WebAppDeps): Hono {
  const app = new Hono();

  app.get("/routing/rules", async (c) => {
    try {
      const rules = await listRoutingRules();
      return c.json({ success: true, data: rules });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to list rules";
      return c.json({ success: false, error: msg }, 500);
    }
  });

  app.post("/routing/rules", async (c) => {
    const body = await c.req.json().catch((err: unknown) => {
      log.warn("Malformed JSON body", { path: c.req.path, err });
      return null;
    });
    if (!body) {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = ruleCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Validation failed",
        },
        400,
      );
    }

    const data = parsed.data;
    if (data.matchType === "pattern" && !isValidRegex(data.matchValue)) {
      return c.json(
        { success: false, error: "matchValue is not a valid regex" },
        400,
      );
    }

    try {
      const rule = await addRoutingRule({ ...data, notes: data.notes ?? null });
      return c.json({ success: true, data: rule }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create rule";
      return c.json({ success: false, error: msg }, 500);
    }
  });

  app.put("/routing/rules/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch((err: unknown) => {
      log.warn("Malformed JSON body", { path: c.req.path, err });
      return null;
    });
    if (!body) {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = ruleUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Validation failed",
        },
        400,
      );
    }

    try {
      const updated = await updateRoutingRule(id, parsed.data);
      if (!updated) {
        return c.json({ success: false, error: "Rule not found" }, 404);
      }
      return c.json({ success: true, data: updated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update rule";
      return c.json({ success: false, error: msg }, 500);
    }
  });

  app.delete("/routing/rules/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const removed = await removeRoutingRule(id);
      if (!removed) {
        return c.json({ success: false, error: "Rule not found" }, 404);
      }
      return c.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete rule";
      return c.json({ success: false, error: msg }, 500);
    }
  });

  app.post("/routing/rules/resolve", async (c) => {
    const body = await c.req.json().catch((err: unknown) => {
      log.warn("Malformed JSON body", { path: c.req.path, err });
      return null;
    });
    if (!body) {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = resolveSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Validation failed",
        },
        400,
      );
    }

    try {
      const result = await resolveAgentForMessage(
        parsed.data.channel,
        parsed.data.chatId,
        parsed.data.senderId,
      );
      return c.json({ success: true, data: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to resolve rule";
      return c.json({ success: false, error: msg }, 500);
    }
  });

  return app;
}
