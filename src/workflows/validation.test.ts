import { test, expect, describe } from "bun:test";
import { validateWorkflowForExecution, topologicalSort } from "./validation";
import type { WorkflowNode, WorkflowEdge } from "../store/workflows";

const node = (id: string, type = "action"): WorkflowNode => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: {},
});

const edge = (id: string, source: string, target: string): WorkflowEdge => ({
  id,
  source,
  target,
});

describe("validateWorkflowForExecution", () => {
  test("valid simple workflow (trigger → action) returns valid=true", () => {
    const nodes = [node("t1", "trigger"), node("a1")];
    const edges = [edge("e1", "t1", "a1")];
    const result = validateWorkflowForExecution(nodes, edges);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("no trigger node returns error about exactly one trigger", () => {
    const nodes = [node("a1"), node("a2")];
    const edges = [edge("e1", "a1", "a2")];
    const result = validateWorkflowForExecution(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("exactly one trigger node"))).toBe(true);
  });

  test("multiple trigger nodes returns error with count", () => {
    const nodes = [node("t1", "trigger"), node("t2", "trigger"), node("a1")];
    const edges = [edge("e1", "t1", "a1"), edge("e2", "t2", "a1")];
    const result = validateWorkflowForExecution(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("2 trigger nodes"))).toBe(true);
  });

  test("edge referencing unknown source returns error", () => {
    const nodes = [node("t1", "trigger"), node("a1")];
    const edges = [edge("e1", "missing", "a1")];
    const result = validateWorkflowForExecution(nodes, edges);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes('"e1"') && e.includes('"missing"')),
    ).toBe(true);
  });

  test("edge referencing unknown target returns error", () => {
    const nodes = [node("t1", "trigger"), node("a1")];
    const edges = [edge("e1", "t1", "ghost")];
    const result = validateWorkflowForExecution(nodes, edges);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes('"e1"') && e.includes('"ghost"')),
    ).toBe(true);
  });

  test("disconnected node not reachable from trigger returns error", () => {
    const nodes = [node("t1", "trigger"), node("a1"), node("a2")];
    // a2 is not connected to anything
    const edges = [edge("e1", "t1", "a1")];
    const result = validateWorkflowForExecution(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"a2"') && e.includes("not reachable"))).toBe(true);
  });

  test("cycle detection (A→B→A) returns error about cycle", () => {
    const nodes = [node("t1", "trigger"), node("a1"), node("a2")];
    const edges = [
      edge("e1", "t1", "a1"),
      edge("e2", "a1", "a2"),
      edge("e3", "a2", "a1"),
    ];
    const result = validateWorkflowForExecution(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("cycle"))).toBe(true);
  });

  test("empty graph (no nodes) returns error about trigger", () => {
    const result = validateWorkflowForExecution([], []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("trigger"))).toBe(true);
  });

  test("single trigger node, no edges returns valid=true", () => {
    const nodes = [node("t1", "trigger")];
    const result = validateWorkflowForExecution(nodes, []);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("linear chain (trigger→A→B→C) returns valid=true", () => {
    const nodes = [
      node("t1", "trigger"),
      node("a1"),
      node("a2"),
      node("a3"),
    ];
    const edges = [
      edge("e1", "t1", "a1"),
      edge("e2", "a1", "a2"),
      edge("e3", "a2", "a3"),
    ];
    const result = validateWorkflowForExecution(nodes, edges);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe("topologicalSort", () => {
  test("linear chain returns nodes in trigger-to-leaf order", () => {
    const nodes = [node("t1", "trigger"), node("a1"), node("a2"), node("a3")];
    const edges = [
      edge("e1", "t1", "a1"),
      edge("e2", "a1", "a2"),
      edge("e3", "a2", "a3"),
    ];
    const sorted = topologicalSort(nodes, edges, "t1");
    const ids = sorted.map((n) => n.id);
    expect(ids[0]).toBe("t1");
    expect(ids.indexOf("a1")).toBeLessThan(ids.indexOf("a2"));
    expect(ids.indexOf("a2")).toBeLessThan(ids.indexOf("a3"));
  });

  test("diamond graph returns valid topological order with C after A and B", () => {
    // trigger → A, trigger → B, A → C, B → C
    const nodes = [
      node("t1", "trigger"),
      node("a1"),
      node("b1"),
      node("c1"),
    ];
    const edges = [
      edge("e1", "t1", "a1"),
      edge("e2", "t1", "b1"),
      edge("e3", "a1", "c1"),
      edge("e4", "b1", "c1"),
    ];
    const sorted = topologicalSort(nodes, edges, "t1");
    const ids = sorted.map((n) => n.id);
    expect(ids[0]).toBe("t1");
    expect(ids.indexOf("a1")).toBeLessThan(ids.indexOf("c1"));
    expect(ids.indexOf("b1")).toBeLessThan(ids.indexOf("c1"));
  });

  test("single trigger node returns just the trigger", () => {
    const nodes = [node("t1", "trigger")];
    const sorted = topologicalSort(nodes, [], "t1");
    expect(sorted).toHaveLength(1);
    expect(sorted[0]!.id).toBe("t1");
  });

  test("cycle throws error about topological sort", () => {
    const nodes = [node("t1", "trigger"), node("a1"), node("a2")];
    const edges = [
      edge("e1", "t1", "a1"),
      edge("e2", "a1", "a2"),
      edge("e3", "a2", "a1"),
    ];
    expect(() => topologicalSort(nodes, edges, "t1")).toThrow(
      /cannot topologically sort/i,
    );
  });
});
