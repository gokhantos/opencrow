import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../store/db";
import { createCronStore } from "./store";
import type { CronStore } from "./store";

let store: CronStore;

beforeEach(async () => {
  await initDb(process.env.DATABASE_URL);
  store = createCronStore();

  // Clean up any leftover test data
  const { getDb } = await import("../store/db");
  const db = getDb();
  await db.unsafe("DELETE FROM cron_runs");
  await db.unsafe("DELETE FROM cron_jobs");
});

afterEach(async () => {
  const { getDb } = await import("../store/db");
  const db = getDb();
  await db.unsafe("DELETE FROM cron_runs");
  await db.unsafe("DELETE FROM cron_jobs");
  await closeDb();
});

describe("CronStore", () => {
  test("addJob creates and retrieves a job", async () => {
    const job = await store.addJob({
      name: "Test Job",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "Hello" },
    });

    expect(job.id).toBeTruthy();
    expect(job.name).toBe("Test Job");
    expect(job.enabled).toBe(true);
    expect(job.schedule.kind).toBe("every");
    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.message).toBe("Hello");
    }
    expect(job.nextRunAt).toBeTruthy();
  });

  test("listJobs returns all jobs", async () => {
    await store.addJob({
      name: "Job 1",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "A" },
    });
    await store.addJob({
      name: "Job 2",
      schedule: { kind: "every", everyMs: 120_000 },
      payload: { kind: "agentTurn", message: "B" },
    });

    const jobs = await store.listJobs();
    expect(jobs.length).toBe(2);
  });

  test("updateJob patches job fields", async () => {
    const job = await store.addJob({
      name: "Original",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "Test" },
    });

    const updated = await store.updateJob(job.id, {
      name: "Updated",
      enabled: false,
    });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("Updated");
    expect(updated!.enabled).toBe(false);
  });

  test("updateJob returns null for nonexistent job", async () => {
    const result = await store.updateJob("nonexistent", { name: "Test" });
    expect(result).toBeNull();
  });

  test("removeJob deletes a job", async () => {
    const job = await store.addJob({
      name: "To Delete",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "Bye" },
    });

    expect(await store.removeJob(job.id)).toBe(true);
    expect(await store.getJob(job.id)).toBeNull();
    expect(await store.removeJob(job.id)).toBe(false);
  });

  test("getDueJobs returns enabled jobs past their next_run_at", async () => {
    const job = await store.addJob({
      name: "Due Job",
      schedule: { kind: "every", everyMs: 1 },
      payload: { kind: "agentTurn", message: "Now" },
    });

    // The job should be due since everyMs is 1ms
    const dueJobs = await store.getDueJobs(Date.now() + 60_000);
    expect(dueJobs.length).toBeGreaterThanOrEqual(1);
    expect(dueJobs.some((j) => j.id === job.id)).toBe(true);
  });

  test("getDueJobs excludes disabled jobs", async () => {
    const job = await store.addJob({
      name: "Disabled",
      schedule: { kind: "every", everyMs: 1 },
      payload: { kind: "agentTurn", message: "Skip" },
      enabled: false,
    });

    const dueJobs = await store.getDueJobs(Date.now() + 60_000);
    expect(dueJobs.some((j) => j.id === job.id)).toBe(false);
  });

  test("addRun and getRunsForJob", async () => {
    const job = await store.addJob({
      name: "Job with Runs",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "Test" },
    });

    const now = Math.floor(Date.now() / 1000);
    await store.addRun({
      id: "run-1",
      jobId: job.id,
      status: "ok",
      resultSummary: "Done",
      error: null,
      durationMs: 1500,
      startedAt: now - 2,
      endedAt: now,
      progress: null,
    });

    const runs = await store.getRunsForJob(job.id);
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("ok");
    expect(runs[0]!.durationMs).toBe(1500);
  });
});
