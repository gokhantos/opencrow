import { spawnSync } from "node:child_process";
import { test, expect } from "bun:test";
import { buildInfraPlist } from "./plist.ts";

// Validates that a rendered plist is well-formed XML/plist via `plutil -lint`.
// macOS-only; on other platforms (or if plutil is absent) it no-ops so the
// suite stays green in CI/Linux.
function expectValidPlist(xml: string): void {
  const lint = spawnSync("plutil", ["-lint", "-s", "-"], {
    input: xml,
    encoding: "utf8",
  });
  if (lint.error || lint.status === null) return; // plutil unavailable -> skip
  expect(lint.status).toBe(0);
}

const plist = buildInfraPlist({
  label: "com.opencrow.qdrant",
  programArguments: ["/Users/test/.opencrow/bin/qdrant", "--config-path", "/cfg.yaml"],
  workingDirectory: "/Users/test/.opencrow/qdrant",
  env: { QDRANT__SERVICE__HTTP_PORT: "6333" },
  stdoutPath: "/log/qdrant.log",
  stderrPath: "/log/qdrant.err.log",
});

test("includes label, KeepAlive, RunAtLoad", () => {
  expect(plist).toContain("<string>com.opencrow.qdrant</string>");
  expect(plist).toContain("<key>KeepAlive</key>");
  expect(plist).toContain("<key>RunAtLoad</key>");
});

test("renders each program argument as a <string>", () => {
  expect(plist).toContain("<string>--config-path</string>");
  expect(plist).toContain("<string>/cfg.yaml</string>");
});

test("renders the env dict as EnvironmentVariables", () => {
  expect(plist).toContain("<key>EnvironmentVariables</key>");
  expect(plist).toContain("<key>QDRANT__SERVICE__HTTP_PORT</key>");
  expect(plist).toContain("<string>6333</string>");
});

test("defaults ThrottleInterval to 5", () => {
  expect(plist).toContain("<key>ThrottleInterval</key>");
  expect(plist).toContain("<integer>5</integer>");
});

test("omits ResourceLimits when processLimit is unset", () => {
  expect(plist).not.toContain("SoftResourceLimits");
  expect(plist).not.toContain("NumberOfProcesses");
});

test("renders Soft+Hard NumberOfProcesses limits when processLimit is set", () => {
  const limited = buildInfraPlist({
    label: "com.opencrow.mem0",
    programArguments: ["/bin/bash", "/wrapper.sh"],
    workingDirectory: "/app",
    stdoutPath: "/log/mem0.log",
    stderrPath: "/log/mem0.err.log",
    processLimit: 768,
  });
  expect(limited).toContain("<key>SoftResourceLimits</key>");
  expect(limited).toContain("<key>HardResourceLimits</key>");
  expect(limited).toContain("<key>NumberOfProcesses</key>");
  expect(limited).toContain("<integer>768</integer>");
});

test("renders Soft+Hard NumberOfFiles limits when fileLimit is set alone", () => {
  const limited = buildInfraPlist({
    label: "com.opencrow.qdrant",
    programArguments: ["/bin/qdrant"],
    workingDirectory: "/app",
    stdoutPath: "/log/q.log",
    stderrPath: "/log/q.err.log",
    fileLimit: 65536,
  });
  expect(limited).toContain("<key>SoftResourceLimits</key>");
  expect(limited).toContain("<key>HardResourceLimits</key>");
  // NumberOfFiles must appear in BOTH the Soft and the Hard dict (twice total).
  const fileKeyCount = limited.split("<key>NumberOfFiles</key>").length - 1;
  expect(fileKeyCount).toBe(2);
  expect(limited).toContain("<integer>65536</integer>");
  // fileLimit alone must NOT render a process limit.
  expect(limited).not.toContain("NumberOfProcesses");
});

test("emits exactly ONE Soft/Hard dict containing BOTH limits when both are set", () => {
  const limited = buildInfraPlist({
    label: "com.opencrow.qdrant",
    programArguments: ["/bin/qdrant"],
    workingDirectory: "/app",
    stdoutPath: "/log/q.log",
    stderrPath: "/log/q.err.log",
    processLimit: 768,
    fileLimit: 65536,
  });
  // Invalid-double-dict regression guard: each ResourceLimits key appears once.
  const softCount = limited.split("<key>SoftResourceLimits</key>").length - 1;
  const hardCount = limited.split("<key>HardResourceLimits</key>").length - 1;
  expect(softCount).toBe(1);
  expect(hardCount).toBe(1);
  // Both inner limits present (twice each: once per Soft/Hard dict).
  expect(limited.split("<key>NumberOfProcesses</key>").length - 1).toBe(2);
  expect(limited.split("<key>NumberOfFiles</key>").length - 1).toBe(2);
  expect(limited).toContain("<integer>768</integer>");
  expect(limited).toContain("<integer>65536</integer>");
  // The rendered XML must be a valid plist (guards the single-key-per-dict rule).
  expectValidPlist(limited);
});

test("omits ResourceLimits entirely when neither limit is set", () => {
  expect(plist).not.toContain("SoftResourceLimits");
  expect(plist).not.toContain("HardResourceLimits");
  expect(plist).not.toContain("NumberOfProcesses");
  expect(plist).not.toContain("NumberOfFiles");
});
