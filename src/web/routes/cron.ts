import { Hono } from "hono";
import { z } from "zod";
import type { WebAppDeps } from "../app";
import type { CronJobCreate, CronJobPatch } from "../../cron/types";
import { computeNextRunAt } from "../../cron/schedule";

const cronScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("at"), at: z.string() }),
  z.object({ kind: z.literal("every"), everyMs: z.number().int().min(1000) }),
  z.object({
    kind: z.literal("cron"),
    expr: z.string(),
    tz: z.string().optional(),
  }),
]);

const cronPayloadSchema = z.object({
  kind: z.literal("agentTurn"),
  message: z.string().min(1),
  agentId: z.string().optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
});

const cronDeliverySchema = z.object({
  mode: z.enum(["none", "announce"]),
  channel: z.string().optional(),
  chatId: z.string().optional(),
});

const createJobSchema = z.object({
  name: z.string().min(1),
  schedule: cronScheduleSchema,
  payload: cronPayloadSchema,
  delivery: cronDeliverySchema.optional(),
  enabled: z.boolean().optional(),
  deleteAfterRun: z.boolean().optional(),
  priority: z.number().int().min(0).max(20).optional(),
});

const patchJobSchema = z.object({
  name: z.string().min(1).optional(),
  schedule: cronScheduleSchema.optional(),
  payload: cronPayloadSchema.optional(),
  delivery: cronDeliverySchema.optional(),
  enabled: z.boolean().optional(),
  deleteAfterRun: z.boolean().optional(),
  priority: z.number().int().min(0).max(20).optional(),
});

export function createCronRoutes(deps: WebAppDeps): Hono {
  const app = new Hono();

  const { cronStore, cronScheduler } = deps;

  if (!cronStore) {
    app.all("/cron/*", (c) =>
      c.json({ success: false, error: "Cron store unavailable" }, 503),
    );
    return app;
  }

  app.get("/cron/status", async (c) => {
    // Proxy to core when running standalone web
    if (deps.coreClient) {
      try {
        const result = await deps.coreClient.cronStatus();
        if (result.data) {
          return c.json({ success: true, data: result.data });
        }
      } catch {
        // Fall through to local fallback
      }
    }
    if (cronScheduler) {
      const status = await cronScheduler.getStatus();
      return c.json({
        success: true,
        data: {
          running: status.running,
          jobCount: status.jobCount,
          nextDueAt: status.nextDueAt,
        },
      });
    }
    // Fallback: build status from DB when scheduler isn't local
    const jobs = await cronStore.listJobs();
    const enabledJobs = jobs.filter((j) => j.enabled);
    const nextDueAt = enabledJobs.reduce<number | null>((min, j) => {
      if (j.nextRunAt == null) return min;
      return min == null ? j.nextRunAt : Math.min(min, j.nextRunAt);
    }, null);
    return c.json({
      success: true,
      data: {
        running: true,
        jobCount: jobs.length,
        nextDueAt,
      },
    });
  });

  app.get("/cron/active-runs", async (c) => {
    try {
      const runs = await cronStore.getActiveRuns();
      return c.json({ success: true, data: runs });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return c.json({ success: false, error: msg }, 500);
    }
  });

  app.get("/cron/jobs", async (c) => {
    const jobs = await cronStore.listJobs();
    return c.json({ success: true, data: jobs });
  });

  app.post("/cron/jobs", async (c) => {
    try {
      const body = await c.req.json();
      const parsed = createJobSchema.parse(body);

      const nextRunAt = computeNextRunAt(parsed.schedule, Date.now());
      if (!nextRunAt && parsed.schedule.kind !== "at") {
        return c.json(
          { success: false, error: "Could not compute next run time" },
          400,
        );
      }

      const job = await cronStore.addJob(parsed as CronJobCreate);
      return c.json({ success: true, data: job }, 201);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json({ success: false, error: error.message }, 400);
      }
      const msg = error instanceof Error ? error.message : "Unknown error";
      return c.json({ success: false, error: msg }, 500);
    }
  });

  app.patch("/cron/jobs/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const body = await c.req.json();
      const parsed = patchJobSchema.parse(body);

      const job = await cronStore.updateJob(id, parsed as CronJobPatch);
      if (!job) {
        return c.json({ success: false, error: "Job not found" }, 404);
      }

      return c.json({ success: true, data: job });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json({ success: false, error: error.message }, 400);
      }
      const msg = error instanceof Error ? error.message : "Unknown error";
      return c.json({ success: false, error: msg }, 500);
    }
  });

  app.delete("/cron/jobs/:id", async (c) => {
    const id = c.req.param("id");
    const removed = await cronStore.removeJob(id);
    if (!removed) {
      return c.json({ success: false, error: "Job not found" }, 404);
    }
    return c.json({ success: true });
  });

  app.post("/cron/jobs/:id/run", async (c) => {
    try {
      const id = c.req.param("id");
      if (cronScheduler) {
        await cronScheduler.runJobNow(id);
        return c.json({ success: true });
      }
      // Send command to cron process via DB queue
      const { sendCommand } = await import("../../process/commands");
      await sendCommand("cron", "cron:run_job", { jobId: id });
      return c.json({ success: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return c.json({ success: false, error: msg }, 500);
    }
  });

  app.get("/cron/jobs/:id/runs", async (c) => {
    const id = c.req.param("id");
    const limitParam = c.req.query("limit");
    const limit = Math.max(1, Math.min(Number(limitParam ?? "20") || 20, 100));
    const runs = await cronStore.getRunsForJob(id, limit);
    return c.json({ success: true, data: runs });
  });

  app.post("/cron/jobs/:id/toggle", async (c) => {
    const id = c.req.param("id");
    const job = await cronStore.getJob(id);
    if (!job) {
      return c.json({ success: false, error: "Job not found" }, 404);
    }

    const updated = await cronStore.updateJob(id, { enabled: !job.enabled });
    return c.json({ success: true, data: updated });
  });

  return app;
}
