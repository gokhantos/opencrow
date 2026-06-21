import { describe, it, expect, mock, beforeEach } from "bun:test";

// Mock the narrowest dependency: spawnSync from node:child_process. The helper
// shells out to `git fetch` then `git show`; we drive both via a queue of
// canned results so the decision logic is deterministic and DB/git-free.
type SpawnResult = {
  status: number | null;
  stdout?: Buffer;
  error?: Error;
};

const calls: string[][] = [];
let queue: SpawnResult[] = [];

const spawnSyncMock = mock((cmd: string, args: readonly string[]) => {
  calls.push([cmd, ...args]);
  const next = queue.shift();
  return next ?? { status: 0, stdout: Buffer.alloc(0) };
});

mock.module("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

const { readRepoFileFromOriginMaster } = await import("./git-stage.ts");

function reset() {
  calls.length = 0;
  queue = [];
  spawnSyncMock.mockClear();
}

const REPO = "/fake/repo";
const REL = "mem0-server/app.py";

describe("readRepoFileFromOriginMaster", () => {
  beforeEach(reset);

  it("returns the byte-exact buffer when git show exits 0", () => {
    // app.py contains non-ASCII (em-dash, ellipsis) — verify bytes survive.
    const payload = Buffer.from("x = 1  # em—dash and …ellipsis\n", "utf8");
    queue = [
      { status: 0 }, // git fetch origin
      { status: 0, stdout: payload }, // git show origin/master:<rel>
    ];

    const out = readRepoFileFromOriginMaster(REPO, REL);

    expect(out).not.toBeNull();
    expect(Buffer.isBuffer(out)).toBe(true);
    expect((out as Buffer).equals(payload)).toBe(true);

    // Asserts the exact git commands shelled out.
    expect(calls[0]).toEqual(["git", "-C", REPO, "fetch", "origin"]);
    expect(calls[1]).toEqual(["git", "-C", REPO, "show", `origin/master:${REL}`]);
  });

  it("returns null when git show exits non-zero (e.g. file absent / not a repo)", () => {
    queue = [
      { status: 0 }, // fetch ok
      { status: 128, stdout: Buffer.alloc(0) }, // show fails
    ];

    expect(readRepoFileFromOriginMaster(REPO, REL)).toBeNull();
  });

  it("returns null when git show exits 0 but stdout is empty", () => {
    queue = [
      { status: 0 },
      { status: 0, stdout: Buffer.alloc(0) },
    ];

    expect(readRepoFileFromOriginMaster(REPO, REL)).toBeNull();
  });

  it("returns null when spawnSync reports an error (git not found)", () => {
    queue = [
      { status: 0 },
      { status: null, error: new Error("spawn git ENOENT") },
    ];

    expect(readRepoFileFromOriginMaster(REPO, REL)).toBeNull();
  });

  it("is non-fatal when fetch fails: still attempts git show and returns its buffer", () => {
    const payload = Buffer.from("ok\n", "utf8");
    queue = [
      { status: 1, error: new Error("offline") }, // fetch fails (soft)
      { status: 0, stdout: payload }, // show still runs and succeeds
    ];

    const out = readRepoFileFromOriginMaster(REPO, REL);

    expect(out).not.toBeNull();
    expect((out as Buffer).equals(payload)).toBe(true);
    // Crucially, the show command was still attempted after the failed fetch.
    expect(calls.length).toBe(2);
    expect(calls[1]).toEqual(["git", "-C", REPO, "show", `origin/master:${REL}`]);
  });
});
