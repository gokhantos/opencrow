import { test, expect, describe, beforeEach } from "bun:test";
import {
  beginRun,
  endRun,
  isRunActive,
  __resetActiveRuns,
} from "./active-runs";

describe("active-runs registry", () => {
  beforeEach(() => {
    __resetActiveRuns();
  });

  test("a run is not active until begun", () => {
    expect(isRunActive("r1")).toBe(false);
    expect(beginRun("r1")).toBe(true);
    expect(isRunActive("r1")).toBe(true);
  });

  test("beginRun is an atomic check-and-set: a second begin is rejected", () => {
    expect(beginRun("r1")).toBe(true);
    // The duplicate-dispatch guard: the second attempt to run the SAME id in
    // this process must be told it lost the race.
    expect(beginRun("r1")).toBe(false);
    expect(isRunActive("r1")).toBe(true);
  });

  test("endRun releases the id so it can be begun again (e.g. a later resume)", () => {
    beginRun("r1");
    endRun("r1");
    expect(isRunActive("r1")).toBe(false);
    expect(beginRun("r1")).toBe(true);
  });

  test("distinct run ids are tracked independently", () => {
    beginRun("a");
    expect(isRunActive("a")).toBe(true);
    expect(isRunActive("b")).toBe(false);
    expect(beginRun("b")).toBe(true);
    endRun("a");
    expect(isRunActive("a")).toBe(false);
    expect(isRunActive("b")).toBe(true);
  });

  test("endRun on an unknown id is a no-op", () => {
    expect(() => endRun("never-started")).not.toThrow();
    expect(isRunActive("never-started")).toBe(false);
  });
});
