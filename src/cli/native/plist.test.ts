import { test, expect } from "bun:test";
import { buildInfraPlist } from "./plist.ts";

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
