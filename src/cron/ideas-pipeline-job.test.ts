import { describe, expect, it } from "bun:test";
import {
  IDEAS_PIPELINE_JOB_NAME,
  buildIdeasPipelineJob,
  ensureIdeasPipelineJob,
  ideasPipelineJobMatches,
  type IdeasScheduleSettings,
} from "./ideas-pipeline-job";
import type { CronStore } from "./store";
import type { CronJob, CronJobCreate, CronJobPatch } from "./types";

const SETTINGS: IdeasScheduleSettings = {
  enabled: true,
  pipelineId: "mobile-app-ideas",
  cronExpr: "0 7 * * *",
};

function makeJob(over: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1",
    name: IDEAS_PIPELINE_JOB_NAME,
    enabled: true,
    deleteAfterRun: false,
    priority: 0,
    schedule: { kind: "cron", expr: "0 7 * * *" },
    payload: { kind: "pipelineRun", pipelineId: "mobile-app-ideas" },
    delivery: { mode: "none" },
    nextRunAt: 123,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** Minimal in-memory CronStore recording only the calls this seeder makes. */
function fakeStore(jobs: readonly CronJob[]) {
  const added: CronJobCreate[] = [];
  const patched: Array<{ id: string; patch: CronJobPatch }> = [];
  const store = {
    async listJobs() {
      return jobs;
    },
    async addJob(input: CronJobCreate) {
      added.push(input);
      return makeJob({ id: "new-job", name: input.name, enabled: input.enabled ?? true });
    },
    async updateJob(id: string, patch: CronJobPatch) {
      patched.push({ id, patch });
      return makeJob({ id });
    },
  } as unknown as CronStore;
  return { store, added, patched };
}

describe("buildIdeasPipelineJob", () => {
  it("builds a pipelineRun payload on a cron schedule with no announce delivery", () => {
    const job = buildIdeasPipelineJob(SETTINGS);
    expect(job.name).toBe(IDEAS_PIPELINE_JOB_NAME);
    expect(job.payload).toEqual({ kind: "pipelineRun", pipelineId: "mobile-app-ideas" });
    expect(job.schedule).toEqual({ kind: "cron", expr: "0 7 * * *" });
    expect(job.delivery).toEqual({ mode: "none" });
    expect(job.enabled).toBe(true);
    expect(job.deleteAfterRun).toBe(false);
  });

  it("omits tz entirely when not configured, rather than setting undefined", () => {
    expect("tz" in (buildIdeasPipelineJob(SETTINGS).schedule as Record<string, unknown>)).toBe(
      false,
    );
  });

  it("carries tz through when configured", () => {
    const job = buildIdeasPipelineJob({ ...SETTINGS, tz: "Europe/Istanbul" });
    expect(job.schedule).toEqual({ kind: "cron", expr: "0 7 * * *", tz: "Europe/Istanbul" });
  });
});

describe("ideasPipelineJobMatches", () => {
  it("matches an identical job", () => {
    expect(ideasPipelineJobMatches(makeJob(), buildIdeasPipelineJob(SETTINGS))).toBe(true);
  });

  it("detects a changed cron expression", () => {
    expect(
      ideasPipelineJobMatches(
        makeJob(),
        buildIdeasPipelineJob({ ...SETTINGS, cronExpr: "0 3 * * *" }),
      ),
    ).toBe(false);
  });

  it("detects a changed pipeline id", () => {
    expect(
      ideasPipelineJobMatches(
        makeJob(),
        buildIdeasPipelineJob({ ...SETTINGS, pipelineId: "ai-app-ideas" }),
      ),
    ).toBe(false);
  });

  it("detects a changed tz", () => {
    expect(
      ideasPipelineJobMatches(
        makeJob(),
        buildIdeasPipelineJob({ ...SETTINGS, tz: "Europe/Istanbul" }),
      ),
    ).toBe(false);
  });

  it("detects a disabled/enabled mismatch", () => {
    expect(ideasPipelineJobMatches(makeJob({ enabled: false }), buildIdeasPipelineJob(SETTINGS))).toBe(
      false,
    );
  });

  it("rejects a job that is not a pipelineRun (a name collision with an agent job)", () => {
    const agentJob = makeJob({ payload: { kind: "agentTurn", message: "hi" } });
    expect(ideasPipelineJobMatches(agentJob, buildIdeasPipelineJob(SETTINGS))).toBe(false);
  });

  it("ignores bookkeeping fields that change on every run", () => {
    const ran = makeJob({ nextRunAt: 999, lastRunAt: 888, lastStatus: "ok", updatedAt: 777 });
    expect(ideasPipelineJobMatches(ran, buildIdeasPipelineJob(SETTINGS))).toBe(true);
  });
});

describe("ensureIdeasPipelineJob", () => {
  it("creates the job when none exists", async () => {
    const { store, added, patched } = fakeStore([]);
    expect(await ensureIdeasPipelineJob(store, SETTINGS)).toBe("created");
    expect(added).toHaveLength(1);
    expect(added[0]?.payload).toEqual({ kind: "pipelineRun", pipelineId: "mobile-app-ideas" });
    expect(patched).toHaveLength(0);
  });

  it("is idempotent — a matching job is left untouched", async () => {
    const { store, added, patched } = fakeStore([makeJob()]);
    expect(await ensureIdeasPipelineJob(store, SETTINGS)).toBe("unchanged");
    expect(added).toHaveLength(0);
    expect(patched).toHaveLength(0);
  });

  it("reconciles a drifted schedule instead of creating a duplicate", async () => {
    const { store, added, patched } = fakeStore([
      makeJob({ schedule: { kind: "cron", expr: "0 3 * * *" } }),
    ]);
    expect(await ensureIdeasPipelineJob(store, SETTINGS)).toBe("updated");
    expect(added).toHaveLength(0);
    expect(patched).toHaveLength(1);
    expect(patched[0]?.patch.schedule).toEqual({ kind: "cron", expr: "0 7 * * *" });
    expect(patched[0]?.patch.enabled).toBe(true);
  });

  it("does not create a job when the schedule is disabled by config", async () => {
    const { store, added, patched } = fakeStore([]);
    expect(await ensureIdeasPipelineJob(store, { ...SETTINGS, enabled: false })).toBe("disabled");
    expect(added).toHaveLength(0);
    expect(patched).toHaveLength(0);
  });

  it("disables (never deletes) an existing job when config turns the schedule off", async () => {
    const { store, added, patched } = fakeStore([makeJob({ enabled: true })]);
    expect(await ensureIdeasPipelineJob(store, { ...SETTINGS, enabled: false })).toBe("disabled");
    expect(added).toHaveLength(0);
    expect(patched).toEqual([{ id: "job-1", patch: { enabled: false } }]);
  });

  it("re-enables a previously disabled job when config turns it back on", async () => {
    const { store, patched } = fakeStore([makeJob({ enabled: false })]);
    expect(await ensureIdeasPipelineJob(store, SETTINGS)).toBe("updated");
    expect(patched[0]?.patch.enabled).toBe(true);
  });

  it("ignores unrelated jobs when looking for its own", async () => {
    const { store, added } = fakeStore([
      makeJob({ id: "other", name: "deep-health-check", payload: { kind: "agentTurn", message: "x" } }),
    ]);
    expect(await ensureIdeasPipelineJob(store, SETTINGS)).toBe("created");
    expect(added).toHaveLength(1);
  });
});
