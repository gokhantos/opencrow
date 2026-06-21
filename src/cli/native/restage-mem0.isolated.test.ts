import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Mock the narrowest dependency: spawnSync from node:child_process. restageMem0
// shells out to git (fetch + show, via stageSidecarFile) and then to launchctl
// kickstart. We drive each by command so the staging path writes a known
// app.py and the kickstart exit code is controllable.
type SpawnResult = {
  status: number | null;
  stdout?: Buffer;
  error?: Error;
};

const calls: string[][] = [];
let showPayload: Buffer = Buffer.from("# staged app.py\n", "utf8");
let kickstartStatus = 0;

const spawnSyncMock = mock((cmd: string, args: readonly string[]): SpawnResult => {
  calls.push([cmd, ...args]);
  if (cmd === "git") {
    const sub = args[2]; // ["-C", repoDir, <sub>, ...]
    if (sub === "fetch") return { status: 0 };
    if (sub === "show") return { status: 0, stdout: showPayload };
    return { status: 0, stdout: Buffer.alloc(0) };
  }
  if (cmd === "launchctl") return { status: kickstartStatus };
  return { status: 0, stdout: Buffer.alloc(0) };
});

mock.module("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

const { restageMem0 } = await import("./mem0.ts");
const { nativePaths } = await import("./paths.ts");

describe("restageMem0 kickstart path", () => {
  let tmpHome: string;

  beforeEach(async () => {
    calls.length = 0;
    showPayload = Buffer.from("# staged app.py\n", "utf8");
    kickstartStatus = 0;
    spawnSyncMock.mockClear();
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "restage-mem0-iso-"));
    // Provision marker: a present .venv dir makes the guard pass.
    await fs.mkdir(path.join(nativePaths(tmpHome).mem0AppDir, ".venv"), {
      recursive: true,
    });
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("stages app.py from origin/master, clears __pycache__, and kickstarts", async () => {
    const p = nativePaths(tmpHome);
    const appDir = p.mem0AppDir;
    // Stale bytecode that the restart must not be able to execute.
    await fs.mkdir(path.join(appDir, "__pycache__"), { recursive: true });
    await fs.writeFile(path.join(appDir, "__pycache__", "app.cpython-311.pyc"), "stale");

    await restageMem0(p, tmpHome);

    // app.py written from the git-show buffer.
    const written = await fs.readFile(path.join(appDir, "app.py"));
    expect(written.equals(showPayload)).toBe(true);

    // __pycache__ removed.
    await expect(fs.access(path.join(appDir, "__pycache__"))).rejects.toThrow();

    // launchctl kickstart -k invoked with the mem0 label in the gui domain.
    const kick = calls.find((c) => c[0] === "launchctl");
    expect(kick?.[1]).toBe("kickstart");
    expect(kick?.[2]).toBe("-k");
    expect(kick?.[3]).toContain("com.opencrow.mem0");

    // No bootout/bootstrap — restart in place only.
    expect(calls.some((c) => c[0] === "launchctl" && c[1] === "bootout")).toBe(false);
    expect(calls.some((c) => c[0] === "launchctl" && c[1] === "bootstrap")).toBe(false);
  });

  it("throws a helpful error when kickstart exits non-zero", async () => {
    kickstartStatus = 1;
    const p = nativePaths(tmpHome);

    await expect(restageMem0(p, tmpHome)).rejects.toThrow(
      /launchctl kickstart \(mem0\) failed.*native up/s,
    );
  });
});
