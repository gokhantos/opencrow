import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import { initDb, closeDb, getDb } from "./db";
import {
  createWorkflow,
  getAllWorkflows,
  getWorkflowById,
  updateWorkflow,
  deleteWorkflow,
  createExecution,
  getExecution,
  updateExecution,
  getExecutionsByWorkflow,
  createStep,
  updateStep,
  getStepsByExecution,
  type WorkflowNode,
  type WorkflowEdge,
  type WorkflowViewport,
} from "./workflows";

// Note: Using real database for integration testing
// Mocks pollute the module cache and break other tests

describe("workflows", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    vi.clearAllMocks();
    const db = getDb();
    // Cascade: deleting workflows also deletes executions and steps via FK
    await db.unsafe("DELETE FROM workflows WHERE name LIKE 'test-%'");
  });

  afterEach(async () => {
    const db = getDb();
    await db.unsafe("DELETE FROM workflows WHERE name LIKE 'test-%'");
    await closeDb();
  });

  // ---------------------------------------------------------------------------
  // Workflow CRUD
  // ---------------------------------------------------------------------------

  describe("createWorkflow", () => {
    it("creates with minimal input and applies defaults", async () => {
      const wf = await createWorkflow({ name: "test-minimal" });

      expect(wf.name).toBe("test-minimal");
      expect(wf.description).toBe("");
      expect(wf.enabled).toBe(false);
      expect(wf.nodes).toEqual([]);
      expect(wf.edges).toEqual([]);
      expect(wf.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
      expect(typeof wf.id).toBe("string");
      expect(wf.createdAt).toBeGreaterThan(0);
      expect(wf.updatedAt).toBeGreaterThan(0);
    });

    it("creates with nodes and edges and round-trips JSONB correctly", async () => {
      const nodes: WorkflowNode[] = [
        {
          id: "node-1",
          type: "trigger",
          position: { x: 100, y: 200 },
          data: { label: "Start", timeout: 30 },
        },
        {
          id: "node-2",
          type: "action",
          position: { x: 300, y: 200 },
          data: { label: "Do thing" },
        },
      ];
      const edges: WorkflowEdge[] = [
        {
          id: "edge-1",
          source: "node-1",
          target: "node-2",
          sourceHandle: "out",
          targetHandle: "in",
        },
      ];
      const viewport: WorkflowViewport = { x: 10, y: 20, zoom: 1.5 };

      const wf = await createWorkflow({
        name: "test-full",
        description: "A full workflow",
        enabled: true,
        nodes,
        edges,
        viewport,
      });

      expect(wf.name).toBe("test-full");
      expect(wf.description).toBe("A full workflow");
      expect(wf.enabled).toBe(true);
      expect(wf.nodes).toEqual(nodes);
      expect(wf.edges).toEqual(edges);
      expect(wf.viewport).toEqual(viewport);
    });
  });

  describe("getAllWorkflows", () => {
    it("returns workflows ordered by updated_at DESC", async () => {
      // Insert with a small delay so updated_at differs
      const wf1 = await createWorkflow({ name: "test-order-a" });
      // Bump updated_at on wf1 so it should appear first after the update
      await updateWorkflow(wf1.id, { description: "bumped" });
      const wf2 = await createWorkflow({ name: "test-order-b" });

      const all = await getAllWorkflows();
      const testWfs = all.filter((w) => w.name.startsWith("test-order-"));

      expect(testWfs.length).toBe(2);
      // wf2 was inserted last so its updated_at is >= wf1's bumped value;
      // either way the array must be sorted descending
      for (let i = 0; i < testWfs.length - 1; i++) {
        expect(testWfs[i]!.updatedAt).toBeGreaterThanOrEqual(
          testWfs[i + 1]!.updatedAt,
        );
      }
    });
  });

  describe("getWorkflowById", () => {
    it("returns the workflow when it exists", async () => {
      const created = await createWorkflow({
        name: "test-find-me",
        description: "find this",
      });

      const found = await getWorkflowById(created.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.name).toBe("test-find-me");
      expect(found!.description).toBe("find this");
    });

    it("returns null for a nonexistent id", async () => {
      const result = await getWorkflowById("00000000-0000-0000-0000-000000000000");
      expect(result).toBeNull();
    });
  });

  describe("updateWorkflow", () => {
    it("partial update preserves unspecified fields", async () => {
      const nodes: WorkflowNode[] = [
        {
          id: "n1",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: {},
        },
      ];
      const created = await createWorkflow({
        name: "test-partial",
        description: "original description",
        enabled: true,
        nodes,
      });

      const updated = await updateWorkflow(created.id, { name: "test-partial-renamed" });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("test-partial-renamed");
      // Fields not in the patch are preserved
      expect(updated!.description).toBe("original description");
      expect(updated!.enabled).toBe(true);
      expect(updated!.nodes).toEqual(nodes);
    });

    it("returns null for a nonexistent id", async () => {
      const result = await updateWorkflow(
        "00000000-0000-0000-0000-000000000000",
        { name: "test-ghost" },
      );
      expect(result).toBeNull();
    });
  });

  describe("deleteWorkflow", () => {
    it("returns true on first delete then false on second attempt", async () => {
      const wf = await createWorkflow({ name: "test-delete-me" });

      const first = await deleteWorkflow(wf.id);
      const second = await deleteWorkflow(wf.id);

      expect(first).toBe(true);
      expect(second).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Execution CRUD
  // ---------------------------------------------------------------------------

  describe("createExecution", () => {
    it("creates with pending status and stores JSONB triggerInput", async () => {
      const wf = await createWorkflow({ name: "test-exec-parent" });
      const triggerInput = { event: "cron", ts: 1234567890, payload: { key: "val" } };

      const exec = await createExecution({
        workflowId: wf.id,
        triggerInput,
      });

      expect(exec.workflowId).toBe(wf.id);
      expect(exec.status).toBe("pending");
      expect(exec.triggerInput).toEqual(triggerInput);
      expect(exec.result).toBeNull();
      expect(exec.error).toBeNull();
      expect(exec.startedAt).toBeNull();
      expect(exec.finishedAt).toBeNull();
      expect(typeof exec.id).toBe("string");
    });
  });

  describe("getExecution", () => {
    it("retrieves an execution by id", async () => {
      const wf = await createWorkflow({ name: "test-exec-get" });
      const created = await createExecution({
        workflowId: wf.id,
        triggerInput: { source: "manual" },
      });

      const found = await getExecution(created.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.workflowId).toBe(wf.id);
      expect(found!.triggerInput).toEqual({ source: "manual" });
    });
  });

  describe("updateExecution", () => {
    it("stores result when result is explicitly provided", async () => {
      const wf = await createWorkflow({ name: "test-exec-result" });
      const exec = await createExecution({
        workflowId: wf.id,
        triggerInput: {},
      });
      const now = Math.floor(Date.now() / 1000);
      const resultPayload = { output: "success", count: 42 };

      const updated = await updateExecution(exec.id, {
        status: "completed",
        result: resultPayload,
        startedAt: now - 5,
        finishedAt: now,
      });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("completed");
      expect(updated!.result).toEqual(resultPayload);
      expect(updated!.startedAt).toBe(now - 5);
      expect(updated!.finishedAt).toBe(now);
    });

    it("does not wipe an existing result when result is omitted from the patch", async () => {
      const wf = await createWorkflow({ name: "test-exec-no-wipe" });
      const exec = await createExecution({
        workflowId: wf.id,
        triggerInput: {},
      });
      const resultPayload = { data: "persisted" };
      // First update: set a result
      await updateExecution(exec.id, {
        status: "running",
        result: resultPayload,
      });

      // Second update: change status only, no result key in input
      const updated = await updateExecution(exec.id, { status: "completed" });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("completed");
      // Result must still be the previously stored value
      expect(updated!.result).toEqual(resultPayload);
    });
  });

  describe("getExecutionsByWorkflow", () => {
    it("returns executions ordered by created_at DESC", async () => {
      const wf = await createWorkflow({ name: "test-exec-list" });

      const exec1 = await createExecution({ workflowId: wf.id, triggerInput: { seq: 1 } });
      const exec2 = await createExecution({ workflowId: wf.id, triggerInput: { seq: 2 } });
      const exec3 = await createExecution({ workflowId: wf.id, triggerInput: { seq: 3 } });

      const list = await getExecutionsByWorkflow(wf.id);

      expect(list.length).toBe(3);
      // Most recently created must come first
      const ids = list.map((e) => e.id);
      expect(ids.indexOf(exec3.id)).toBeLessThan(ids.indexOf(exec2.id));
      expect(ids.indexOf(exec2.id)).toBeLessThan(ids.indexOf(exec1.id));
    });
  });

  // ---------------------------------------------------------------------------
  // Step CRUD
  // ---------------------------------------------------------------------------

  describe("createStep", () => {
    it("creates a step with pending status", async () => {
      const wf = await createWorkflow({ name: "test-step-parent" });
      const exec = await createExecution({ workflowId: wf.id, triggerInput: {} });

      const step = await createStep({
        executionId: exec.id,
        nodeId: "node-abc",
        nodeType: "http-request",
      });

      expect(step.executionId).toBe(exec.id);
      expect(step.nodeId).toBe("node-abc");
      expect(step.nodeType).toBe("http-request");
      expect(step.status).toBe("pending");
      expect(step.input).toBeNull();
      expect(step.output).toBeNull();
      expect(step.error).toBeNull();
      expect(step.startedAt).toBeNull();
      expect(step.finishedAt).toBeNull();
      expect(typeof step.id).toBe("string");
    });
  });

  describe("updateStep", () => {
    it("stores both input and output JSONB when both are provided", async () => {
      const wf = await createWorkflow({ name: "test-step-both" });
      const exec = await createExecution({ workflowId: wf.id, triggerInput: {} });
      const step = await createStep({
        executionId: exec.id,
        nodeId: "node-1",
        nodeType: "transform",
      });
      const now = Math.floor(Date.now() / 1000);
      const inputPayload = { raw: "data", count: 3 };
      const outputPayload = { transformed: true, items: [1, 2, 3] };

      const updated = await updateStep(step.id, {
        status: "completed",
        input: inputPayload,
        output: outputPayload,
        startedAt: now - 2,
        finishedAt: now,
      });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("completed");
      expect(updated!.input).toEqual(inputPayload);
      expect(updated!.output).toEqual(outputPayload);
      expect(updated!.startedAt).toBe(now - 2);
      expect(updated!.finishedAt).toBe(now);
    });

    it("stores output only and leaves input null when input is omitted", async () => {
      const wf = await createWorkflow({ name: "test-step-output-only" });
      const exec = await createExecution({ workflowId: wf.id, triggerInput: {} });
      const step = await createStep({
        executionId: exec.id,
        nodeId: "node-2",
        nodeType: "filter",
      });
      const outputPayload = { kept: 7 };

      const updated = await updateStep(step.id, {
        status: "completed",
        output: outputPayload,
      });

      expect(updated).not.toBeNull();
      expect(updated!.output).toEqual(outputPayload);
      // input was never set so must remain null
      expect(updated!.input).toBeNull();
    });
  });

  describe("getStepsByExecution", () => {
    it("returns all steps belonging to an execution", async () => {
      const wf = await createWorkflow({ name: "test-step-list" });
      const exec = await createExecution({ workflowId: wf.id, triggerInput: {} });

      const step1 = await createStep({
        executionId: exec.id,
        nodeId: "node-x",
        nodeType: "trigger",
      });
      const step2 = await createStep({
        executionId: exec.id,
        nodeId: "node-y",
        nodeType: "action",
      });
      const step3 = await createStep({
        executionId: exec.id,
        nodeId: "node-z",
        nodeType: "condition",
      });

      const steps = await getStepsByExecution(exec.id);

      expect(steps.length).toBe(3);
      const ids = steps.map((s) => s.id);
      expect(ids).toContain(step1.id);
      expect(ids).toContain(step2.id);
      expect(ids).toContain(step3.id);
    });
  });
});
