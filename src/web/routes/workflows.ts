import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "../../logger";
import {
  getAllWorkflows,
  getWorkflowById,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
} from "../../store/workflows";

const log = createLogger("web:workflows");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidSchema = z.string().regex(UUID_RE, "Invalid UUID");

const nodeSchema = z.object({
  id: z.string().max(200),
  type: z.string().max(100),
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.record(z.string(), z.unknown()).refine(
    (val) => JSON.stringify(val).length < 10_000,
    { message: "Node data exceeds maximum allowed size" },
  ),
});

const edgeSchema = z.object({
  id: z.string().max(200),
  source: z.string().max(200),
  target: z.string().max(200),
  sourceHandle: z.string().max(200).nullable().optional(),
  targetHandle: z.string().max(200).nullable().optional(),
});

const viewportSchema = z.object({
  x: z.number(),
  y: z.number(),
  zoom: z.number(),
});

const createWorkflowSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  description: z.string().max(2000).optional(),
  nodes: z.array(nodeSchema).max(500).optional(),
  edges: z.array(edgeSchema).max(2000).optional(),
  viewport: viewportSchema.optional(),
});

const updateWorkflowSchema = createWorkflowSchema.partial();

export function createWorkflowRoutes(): Hono {
  const app = new Hono();

  app.get("/workflows", async (c) => {
    try {
      const workflows = await getAllWorkflows();
      return c.json({ success: true, data: workflows });
    } catch (err) {
      log.error("Failed to list workflows", { err });
      return c.json({ success: false, error: "Failed to fetch workflows" }, 500);
    }
  });

  app.get("/workflows/:id", async (c) => {
    const id = c.req.param("id");
    if (!uuidSchema.safeParse(id).success) {
      return c.json({ success: false, error: "Invalid workflow ID" }, 400);
    }
    try {
      const workflow = await getWorkflowById(id);
      if (!workflow) {
        return c.json({ success: false, error: "Workflow not found" }, 404);
      }
      return c.json({ success: true, data: workflow });
    } catch (err) {
      log.error("Failed to get workflow", { err, id });
      return c.json({ success: false, error: "Failed to fetch workflow" }, 500);
    }
  });

  app.post("/workflows", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = createWorkflowSchema.safeParse(body);
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
      const workflow = await createWorkflow(parsed.data);
      return c.json({ success: true, data: workflow }, 201);
    } catch (err) {
      log.error("Failed to create workflow", { err });
      return c.json({ success: false, error: "Failed to create workflow" }, 500);
    }
  });

  app.put("/workflows/:id", async (c) => {
    const id = c.req.param("id");
    if (!uuidSchema.safeParse(id).success) {
      return c.json({ success: false, error: "Invalid workflow ID" }, 400);
    }

    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = updateWorkflowSchema.safeParse(body);
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
      const workflow = await updateWorkflow(id, parsed.data);
      if (!workflow) {
        return c.json({ success: false, error: "Workflow not found" }, 404);
      }
      return c.json({ success: true, data: workflow });
    } catch (err) {
      log.error("Failed to update workflow", { err, id });
      return c.json({ success: false, error: "Failed to update workflow" }, 500);
    }
  });

  app.delete("/workflows/:id", async (c) => {
    const id = c.req.param("id");
    if (!uuidSchema.safeParse(id).success) {
      return c.json({ success: false, error: "Invalid workflow ID" }, 400);
    }
    try {
      const deleted = await deleteWorkflow(id);
      if (!deleted) {
        return c.json({ success: false, error: "Workflow not found" }, 404);
      }
      return c.json({ success: true });
    } catch (err) {
      log.error("Failed to delete workflow", { err, id });
      return c.json({ success: false, error: "Failed to delete workflow" }, 500);
    }
  });

  return app;
}
