import { Hono } from "hono";
import { z } from "zod";
import { Cron } from "croner";
import { createLogger } from "../../logger";
import {
  getAllWorkflows,
  getWorkflowById,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  getExecutionsByWorkflow,
  getExecution,
  getStepsByExecution,
} from "../../store/workflows";
import { startWorkflowExecution } from "../../workflows/engine";
import { executionEvents } from "../../workflows/events";
import { syncWorkflowTriggers } from "../../workflows/triggers";
import type { CronStore } from "../../cron/store";
import type { AgentRegistry } from "../../agents/registry";
import type { ToolRegistry } from "../../tools/registry";
import type { ResolvedAgent } from "../../agents/types";
import type { AgentOptions } from "../../agent/types";

const log = createLogger("web:workflows");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidSchema = z.string().regex(UUID_RE, "Invalid UUID");

const nodeSchema = z.object({
  id: z.string().max(200),
  type: z.string().max(100),
  position: z.object({ x: z.number(), y: z.number() }).passthrough(),
  data: z.record(z.string(), z.unknown()).refine(
    (val) => JSON.stringify(val).length < 10_000,
    { message: "Node data exceeds maximum allowed size" },
  ).superRefine((val, ctx) => {
    const expr = val.cronExpression;
    if (expr === undefined || expr === null || expr === "") return;
    if (typeof expr !== "string") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cronExpression must be a string" });
      return;
    }
    if (expr.length > 200) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cronExpression exceeds maximum length" });
      return;
    }
    try {
      new Cron(expr, { maxRuns: 0 });
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cronExpression is not a valid cron expression" });
    }
  }),
}).passthrough();

const edgeSchema = z.object({
  id: z.string().max(200),
  source: z.string().max(200),
  target: z.string().max(200),
  sourceHandle: z.string().max(200).nullable().optional(),
  targetHandle: z.string().max(200).nullable().optional(),
}).passthrough();

const viewportSchema = z.object({
  x: z.number(),
  y: z.number(),
  zoom: z.number(),
}).passthrough();

const createWorkflowSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  description: z.string().max(2000).optional(),
  enabled: z.boolean().optional(),
  nodes: z.array(nodeSchema).max(500).optional(),
  edges: z.array(edgeSchema).max(2000).optional(),
  viewport: viewportSchema.optional(),
});

const updateWorkflowSchema = createWorkflowSchema.partial();

export interface WorkflowRouteDeps {
  readonly agentRegistry: AgentRegistry;
  readonly toolRegistry: ToolRegistry | null;
  readonly cronStore?: CronStore;
  readonly buildAgentOptions?: (
    agent: ResolvedAgent,
    onProgress?: (event: import("../../agent/types").ProgressEvent) => void,
  ) => Promise<AgentOptions>;
}

export function createWorkflowRoutes(deps?: WorkflowRouteDeps): Hono {
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
      if (deps?.cronStore) {
        syncWorkflowTriggers(workflow, deps.cronStore).catch((err) =>
          log.warn("Failed to sync workflow triggers after create", { err }),
        );
      }
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
      if (deps?.cronStore) {
        syncWorkflowTriggers(workflow, deps.cronStore).catch((err) =>
          log.warn("Failed to sync workflow triggers after update", { err }),
        );
      }
      return c.json({ success: true, data: workflow });
    } catch (err) {
      log.error("Failed to update workflow", { err, id });
      return c.json({ success: false, error: "Failed to update workflow" }, 500);
    }
  });

  app.post("/workflows/:id/duplicate", async (c) => {
    const id = c.req.param("id");
    if (!uuidSchema.safeParse(id).success) {
      return c.json({ success: false, error: "Invalid workflow ID" }, 400);
    }
    try {
      const original = await getWorkflowById(id);
      if (!original) {
        return c.json({ success: false, error: "Workflow not found" }, 404);
      }
      const copy = await createWorkflow({
        name: `Copy of ${original.name}`,
        description: original.description,
        nodes: original.nodes,
        edges: original.edges,
        viewport: original.viewport,
      });
      return c.json({ success: true, data: copy }, 201);
    } catch (err) {
      log.error("Failed to duplicate workflow", { err, id });
      return c.json({ success: false, error: "Failed to duplicate workflow" }, 500);
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

  // ---------------------------------------------------------------------------
  // Execution endpoints
  // ---------------------------------------------------------------------------

  app.post("/workflows/:id/run", async (c) => {
    const id = c.req.param("id");
    if (!uuidSchema.safeParse(id).success) {
      return c.json({ success: false, error: "Invalid workflow ID" }, 400);
    }

    if (!deps) {
      return c.json(
        { success: false, error: "Workflow execution is not available in this mode" },
        503,
      );
    }

    const workflow = await getWorkflowById(id).catch(() => null);
    if (!workflow) {
      return c.json({ success: false, error: "Workflow not found" }, 404);
    }

    const rawBody = await c.req.json().catch(() => ({}));

    // Validate that the body is a plain object (record) and within size limit.
    const triggerInputSchema = z.record(z.string(), z.unknown()).optional();
    const parsedBody = triggerInputSchema.safeParse(
      rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {},
    );
    if (!parsedBody.success) {
      return c.json(
        { success: false, error: "Trigger input must be a plain object" },
        400,
      );
    }

    const triggerInput = parsedBody.data ?? {};

    if (JSON.stringify(triggerInput).length > 100_000) {
      return c.json({ success: false, error: "Trigger input exceeds maximum allowed size" }, 413);
    }

    const engineDeps = {
      agentRegistry: deps.agentRegistry,
      toolRegistry: deps.toolRegistry,
      buildAgentOptions: deps.buildAgentOptions,
    };

    try {
      const { executionId } = await startWorkflowExecution(
        workflow,
        triggerInput,
        engineDeps,
      );
      return c.json({ success: true, data: { executionId } }, 202);
    } catch (err) {
      log.error("Failed to start workflow execution", { err, workflowId: id });
      return c.json({ success: false, error: "Failed to start workflow execution" }, 500);
    }
  });

  app.get("/workflows/:id/executions", async (c) => {
    const id = c.req.param("id");
    if (!uuidSchema.safeParse(id).success) {
      return c.json({ success: false, error: "Invalid workflow ID" }, 400);
    }

    const limitParam = c.req.query("limit");
    const limit = Math.max(1, Math.min(Number(limitParam ?? "50") || 50, 200));

    try {
      const executions = await getExecutionsByWorkflow(id, limit);
      return c.json({ success: true, data: executions });
    } catch (err) {
      log.error("Failed to list executions", { err, workflowId: id });
      return c.json({ success: false, error: "Failed to fetch executions" }, 500);
    }
  });

  app.get("/workflow-executions/:id/stream", async (c) => {
    const id = c.req.param("id");
    if (!uuidSchema.safeParse(id).success) {
      return c.json({ success: false, error: "Invalid execution ID" }, 400);
    }

    const execution = await getExecution(id).catch(() => null);
    if (!execution) {
      return c.json({ success: false, error: "Execution not found" }, 404);
    }

    const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
    const encoder = new TextEncoder();
    // Maximum time a live SSE subscription is held open. Prevents subscriber
    // leaks when a workflow execution stalls and never emits a terminal event.
    const SSE_MAX_DURATION_MS = 30 * 60 * 1000; // 30 minutes

    const stream = new ReadableStream({
      start(controller) {
        function send(event: unknown): void {
          const line = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(line));
        }

        function close(): void {
          try { controller.close(); } catch { /* already closed */ }
        }

        getExecution(id)
          .then(async (snap) => {
            if (!snap) {
              close();
              return;
            }
            const steps = await getStepsByExecution(id);
            send({ type: "snapshot", execution: snap, steps });

            if (terminalStatuses.has(snap.status)) {
              close();
              return;
            }

            const unsubscribe = executionEvents.subscribe(id, (event) => {
              send(event);
              if (event.type === "execution" && terminalStatuses.has(event.status)) {
                unsubscribe();
                clearTimeout(ttlTimer);
                close();
              }
            });

            // Re-check execution status after subscribing to close the race window
            // where execution completed between the initial snapshot check and subscribe.
            getExecution(id)
              .then((recheck) => {
                if (recheck && terminalStatuses.has(recheck.status)) {
                  unsubscribe();
                  clearTimeout(ttlTimer);
                  close();
                }
              })
              .catch(() => { /* ignore — stream will TTL */ });

            // Force-close the SSE stream after the maximum duration so that
            // stalled executions do not hold a subscriber open indefinitely.
            const ttlTimer = setTimeout(() => {
              log.warn("SSE stream TTL expired, closing subscriber", { executionId: id });
              unsubscribe();
              close();
            }, SSE_MAX_DURATION_MS);

            c.req.raw.signal.addEventListener("abort", () => {
              unsubscribe();
              clearTimeout(ttlTimer);
              close();
            });
          })
          .catch((err) => {
            log.error("SSE stream setup error", { err, executionId: id });
            close();
          });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  app.get("/workflow-executions/:id", async (c) => {
    const id = c.req.param("id");
    if (!uuidSchema.safeParse(id).success) {
      return c.json({ success: false, error: "Invalid execution ID" }, 400);
    }

    try {
      const execution = await getExecution(id);
      if (!execution) {
        return c.json({ success: false, error: "Execution not found" }, 404);
      }
      const steps = await getStepsByExecution(id);
      return c.json({ success: true, data: { ...execution, steps } });
    } catch (err) {
      log.error("Failed to get execution", { err, id });
      return c.json({ success: false, error: "Failed to fetch execution" }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // Webhook trigger endpoint
  // ---------------------------------------------------------------------------

  app.post("/webhooks/:workflowId", async (c) => {
    const workflowId = c.req.param("workflowId");
    if (!uuidSchema.safeParse(workflowId).success) {
      return c.json({ success: false, error: "Invalid workflow ID" }, 400);
    }

    if (!deps) {
      return c.json(
        { success: false, error: "Workflow execution is not available in this mode" },
        503,
      );
    }

    const workflow = await getWorkflowById(workflowId).catch(() => null);
    if (!workflow) {
      return c.json({ success: false, error: "Workflow not found" }, 404);
    }

    if (!workflow.enabled) {
      return c.json({ success: false, error: "Workflow is not enabled" }, 403);
    }

    const triggerNode = workflow.nodes.find((n) => n.type === "trigger");
    if (!triggerNode || triggerNode.data.triggerType !== "webhook") {
      return c.json({ success: false, error: "Workflow does not have a webhook trigger" }, 400);
    }

    const rawBody = await c.req.json().catch(() => ({}));
    const triggerInputSchema = z.record(z.string(), z.unknown()).optional();
    const parsedBody = triggerInputSchema.safeParse(
      rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {},
    );
    if (!parsedBody.success) {
      return c.json({ success: false, error: "Request body must be a plain object" }, 400);
    }

    const triggerInput = parsedBody.data ?? {};
    if (JSON.stringify(triggerInput).length > 100_000) {
      return c.json({ success: false, error: "Request body exceeds maximum allowed size" }, 413);
    }

    const engineDeps = {
      agentRegistry: deps.agentRegistry,
      toolRegistry: deps.toolRegistry,
      buildAgentOptions: deps.buildAgentOptions,
    };

    try {
      const { executionId } = await startWorkflowExecution(
        workflow,
        triggerInput,
        engineDeps,
      );
      return c.json({ success: true, data: { executionId } }, 202);
    } catch (err) {
      log.error("Failed to start webhook workflow execution", { err, workflowId });
      return c.json({ success: false, error: "Failed to start workflow execution" }, 500);
    }
  });

  return app;
}
