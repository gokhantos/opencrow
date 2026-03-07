import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { CronStore } from "../cron/store";
import type { CronJob } from "../cron/types";

// Mock createCronStore before importing the module under test
const mockStore: CronStore = {
  listJobs: mock(async () => [] as readonly CronJob[]),
  addJob: mock(async () => {
    throw new Error("DB not available");
  }),
  updateJob: mock(async () => null),
  removeJob: mock(async () => false),
  getRunsForJob: mock(async () => []),
  getJob: mock(async () => null),
  getDueJobs: mock(async () => []),
  setJobNextRun: mock(async () => {}),
  setJobLastRun: mock(async () => {}),
  addRun: mock(async () => {}),
  updateRunStatus: mock(async () => {}),
  updateRunProgress: mock(async () => {}),
  getActiveRuns: mock(async () => []),
  cleanupStaleRuns: mock(async () => 0),
} as unknown as CronStore;

mock.module("../cron/store", () => ({
  createCronStore: () => mockStore,
}));

const mockSendCommand = mock(async () => "cmd-id");
mock.module("../process/commands", () => ({
  sendCommand: mockSendCommand,
}));

mock.module("../store/db", () => ({
  getDb: () => {
    const fn = (strings: TemplateStringsArray, ..._values: unknown[]) => {
      return Promise.resolve([]);
    };
    fn.unsafe = () => Promise.resolve([]);
    return fn;
  },
}));

// Import after mocks are set up
const { createCronTool } = await import("./cron");
import type { CronToolConfig } from "./cron";

function makeMockConfig(): CronToolConfig {
  return { currentAgentId: "test-agent" };
}

function resetMocks() {
  (mockStore.listJobs as ReturnType<typeof mock>).mockReset();
  (mockStore.listJobs as ReturnType<typeof mock>).mockImplementation(
    async () => [] as readonly CronJob[],
  );
  (mockStore.addJob as ReturnType<typeof mock>).mockReset();
  (mockStore.addJob as ReturnType<typeof mock>).mockImplementation(async () => {
    throw new Error("DB not available");
  });
  (mockStore.updateJob as ReturnType<typeof mock>).mockReset();
  (mockStore.updateJob as ReturnType<typeof mock>).mockImplementation(
    async () => null,
  );
  (mockStore.removeJob as ReturnType<typeof mock>).mockReset();
  (mockStore.removeJob as ReturnType<typeof mock>).mockImplementation(
    async () => false,
  );
  (mockStore.getRunsForJob as ReturnType<typeof mock>).mockReset();
  (mockStore.getRunsForJob as ReturnType<typeof mock>).mockImplementation(
    async () => [],
  );
  mockSendCommand.mockReset();
  mockSendCommand.mockImplementation(async () => "cmd-id");
}

describe("createCronTool", () => {
  beforeEach(() => {
    resetMocks();
  });

  describe("tool definition", () => {
    it("should have the correct name", () => {
      const tool = createCronTool(makeMockConfig());
      expect(tool.name).toBe("cron");
    });

    it("should have a description mentioning scheduled tasks", () => {
      const tool = createCronTool(makeMockConfig());
      expect(tool.description).toBeTruthy();
      expect(tool.description.toLowerCase()).toContain("schedul");
    });

    it("should have system category", () => {
      const tool = createCronTool(makeMockConfig());
      expect(tool.categories).toEqual(["system"]);
    });

    it("should require action in inputSchema", () => {
      const tool = createCronTool(makeMockConfig());
      expect(tool.inputSchema.required).toEqual(["action"]);
    });

    it("should have action property with valid enum values", () => {
      const tool = createCronTool(makeMockConfig());
      const props = tool.inputSchema.properties as Record<string, any>;
      expect(props.action).toBeDefined();
      expect(props.action.enum).toEqual([
        "status",
        "list",
        "add",
        "update",
        "remove",
        "run",
        "runs",
        "status_all",
      ]);
    });

    it("should have all expected input properties", () => {
      const tool = createCronTool(makeMockConfig());
      const props = tool.inputSchema.properties as Record<string, any>;
      const expectedKeys = [
        "action",
        "job_id",
        "name",
        "schedule_kind",
        "at",
        "every_ms",
        "cron_expr",
        "tz",
        "message",
        "agent_id",
        "timeout_seconds",
        "deliver_channel",
        "deliver_chat_id",
        "enabled",
        "delete_after_run",
      ];
      for (const key of expectedKeys) {
        expect(props[key]).toBeDefined();
      }
    });
  });

  describe("CronToolConfig", () => {
    it("should not require cronStore or scheduler", () => {
      // Config only needs currentAgentId (optional)
      const config: CronToolConfig = {};
      const tool = createCronTool(config);
      expect(tool.name).toBe("cron");
    });
  });

  describe("execute - status action", () => {
    it("should return status from store listing", async () => {
      const futureTs = Math.floor(Date.now() / 1000) + 3600;
      (mockStore.listJobs as ReturnType<typeof mock>).mockImplementation(
        async () =>
          [
            {
              id: "j1",
              name: "job-one",
              enabled: true,
              nextRunAt: futureTs,
              schedule: { kind: "every", everyMs: 600000 },
              payload: { kind: "agentTurn", message: "test" },
              delivery: { mode: "none" },
              lastStatus: "ok",
              lastRunAt: null,
              lastError: null,
              createdAt: 0,
              updatedAt: 0,
              deleteAfterRun: false,
              priority: 10,
            },
            {
              id: "j2",
              name: "job-two",
              enabled: false,
              nextRunAt: null,
              schedule: { kind: "every", everyMs: 600000 },
              payload: { kind: "agentTurn", message: "test2" },
              delivery: { mode: "none" },
              lastStatus: null,
              lastRunAt: null,
              lastError: null,
              createdAt: 0,
              updatedAt: 0,
              deleteAfterRun: false,
              priority: 10,
            },
          ] as readonly CronJob[],
      );

      const tool = createCronTool(makeMockConfig());
      const result = await tool.execute({ action: "status" });
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.output);
      expect(parsed.jobCount).toBe(2);
      expect(parsed.enabledCount).toBe(1);
      expect(parsed.nextDueJob).toBe("job-one");
    });

    it("should handle empty job list", async () => {
      const tool = createCronTool(makeMockConfig());
      const result = await tool.execute({ action: "status" });
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.output);
      expect(parsed.jobCount).toBe(0);
      expect(parsed.enabledCount).toBe(0);
      expect(parsed.nextDueAt).toBeNull();
      expect(parsed.nextDueJob).toBeNull();
    });
  });

  describe("execute - list action", () => {
    it("should return empty list when no jobs exist", async () => {
      const tool = createCronTool(makeMockConfig());
      const result = await tool.execute({ action: "list" });
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.output);
      expect(parsed).toEqual([]);
    });
  });

  describe("execute - add action validation", () => {
    it("should require name, schedule_kind, and message", async () => {
      const tool = createCronTool(makeMockConfig());
      const result = await tool.execute({ action: "add" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("name");
      expect(result.output).toContain("schedule_kind");
      expect(result.output).toContain("message");
    });

    it("should reject add with missing schedule params", async () => {
      const tool = createCronTool(makeMockConfig());
      const result = await tool.execute({
        action: "add",
        name: "test-job",
        schedule_kind: "every",
        message: "do something",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("invalid schedule");
    });

    it("should reject add with schedule_kind 'at' but no 'at' value", async () => {
      const tool = createCronTool(makeMockConfig());
      const result = await tool.execute({
        action: "add",
        name: "test-job",
        schedule_kind: "at",
        message: "do something",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("invalid schedule");
    });

    it("should reject add with schedule_kind 'cron' but no expression", async () => {
      const tool = createCronTool(makeMockConfig());
      const result = await tool.execute({
        action: "add",
        name: "test-job",
        schedule_kind: "cron",
        message: "do something",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("invalid schedule");
    });

    it("should reject 'every' with interval under 5 minutes", async () => {
      const tool = createCronTool(makeMockConfig());
      const result = await tool.execute({
        action: "add",
        name: "test-job",
        schedule_kind: "every",
        every_ms: 60000, // 1 minute - too short
        message: "do something",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("invalid schedule");
    });

    it("should reject 'at' with a past date", async () => {
      const tool = createCronTool(makeMockConfig());
      const result = await tool.execute({
        action: "add",
        name: "test-job",
        schedule_kind: "at",
        at: "2020-01-01T00:00:00Z",
        message: "do something",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("invalid schedule");
    });

    it("should reject 'at' with an invalid date string", async () => {
      const tool = createCronTool(makeMockConfig());
      const result = await tool.execute({
        action: "add",
        name: "test-job",
        schedule_kind: "at",
        at: "not-a-date",
        message: "do something",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("invalid schedule");
    });

    it("should reject 'cron' with an invalid expression", async () => {
      const tool = createCronTool(makeMockConfig());
      const result = await tool.execute({
        action: "add",
        name: "test-job",
        schedule_kind: "cron",
        cron_expr: "not a cron",
        message: "do something",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("invalid schedule");
    });

    it("should reject add when max 50 jobs reached", async () => {
      const fiftyJobs = Array.from({ length: 50 }, (_, i) => ({
        id: `j${i}`,
        name: `job-${i}`,
        enabled: true,
        nextRunAt: null,
        schedule: { kind: "every" as const, everyMs: 600000 },
        payload: { kind: "agentTurn" as const, message: "test" },
        delivery: { mode: "none" as const },
        lastStatus: null,
        lastRunAt: null,
        lastError: null,
        createdAt: 0,
        updatedAt: 0,
        deleteAfterRun: false,
              priority: 10,
      }));
      (mockStore.listJobs as ReturnType<typeof mock>).mockImplementation(
        async () => fiftyJobs as readonly CronJob[],
      );

      const tool = createCronTool(makeMockConfig());
      const result = await tool.execute({
        action: "add",
        name: "one-more",
        schedule_kind: "every",
        every_ms: 600000,
        message: "do something",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("maximum 50");
    });
  });

  describe("execute - update action validation", () => {
    it("should require job_id for update", async () => {
      const tool = createCronTool(makeMockConfig());
      const result = await tool.execute({ action: "update" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("job_id");
    });
  });

  describe("execute - remove action validation", () => {
    it("should require job_id for remove", async () => {
      const tool = createCronTool(makeMockConfig());
      const result = await tool.execute({ action: "remove" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("job_id");
    });
  });

  describe("execute - run action", () => {
    it("should require job_id for run", async () => {
      const tool = createCronTool(makeMockConfig());
      const result = await tool.execute({ action: "run" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("job_id");
    });

    it("should trigger job run and return success", async () => {
      const tool = createCronTool(makeMockConfig());
      const result = await tool.execute({ action: "run", job_id: "job-123" });
      // Either the mock intercepts sendCommand (returns success) or
      // the real sendCommand runs against the mocked DB (also succeeds)
      expect(result.isError).toBe(false);
      expect(result.output).toContain("job-123");
      expect(result.output.toLowerCase()).toContain("trigger");
    });
  });

  describe("execute - runs action validation", () => {
    it("should require job_id for runs", async () => {
      const tool = createCronTool(makeMockConfig());
      const result = await tool.execute({ action: "runs" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("job_id");
    });
  });

  describe("execute - unknown action", () => {
    it("should return error for unknown action", async () => {
      const tool = createCronTool(makeMockConfig());
      const result = await tool.execute({ action: "invalid_action" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Unknown action");
    });
  });
});
