import { test, expect } from "bun:test";
import { nativePaths, QDRANT_LABEL, MEM0_LABEL } from "./paths.ts";

test("nativePaths resolves all dirs under the given home, absolute (no ~)", () => {
  const p = nativePaths("/Users/test");
  expect(p.root).toBe("/Users/test/.opencrow");
  expect(p.qdrantBinary).toBe("/Users/test/.opencrow/bin/qdrant");
  expect(p.qdrantStorage).toBe("/Users/test/.opencrow/qdrant/storage");
  expect(p.qdrantConfig).toBe("/Users/test/.opencrow/qdrant/config.yaml");
  expect(p.mem0Kuzu).toBe("/Users/test/.opencrow/mem0/kuzu");
  expect(p.mem0EnvFile).toBe("/Users/test/.opencrow/mem0/mem0.env");
  expect(Object.values(p).every((v) => !v.includes("~"))).toBe(true);
});

test("service labels are stable", () => {
  expect(QDRANT_LABEL).toBe("com.opencrow.qdrant");
  expect(MEM0_LABEL).toBe("com.opencrow.mem0");
});
