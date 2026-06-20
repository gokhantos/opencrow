import { test, expect } from "bun:test";
import { classifyHttpCheck } from "./doctor.ts";

test("classifyHttpCheck passes when reachable", () => {
  const r = classifyHttpCheck("Qdrant", true, "http://127.0.0.1:6333");
  expect(r.status).toBe("pass");
});

test("classifyHttpCheck fails with a repair hint when unreachable", () => {
  const r = classifyHttpCheck("mem0", false, "http://127.0.0.1:8050");
  expect(r.status).toBe("fail");
  expect(r.repair).toContain("opencrow native up");
});
