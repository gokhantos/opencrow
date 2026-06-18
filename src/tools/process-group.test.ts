import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { killProcessGroup } from "./process-group";

// Returns the count of live processes whose command line contains `marker`.
// Uses pgrep -f (matches full args). Exit code 1 = no matches (count 0).
async function countProcesses(marker: string): Promise<number> {
  const proc = Bun.spawn(["pgrep", "-f", marker], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (!out) return 0;
  return out.split("\n").filter(Boolean).length;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("killProcessGroup", () => {
  describe("input guards", () => {
    it("ignores non-positive pids without throwing", () => {
      expect(() => killProcessGroup(0)).not.toThrow();
      expect(() => killProcessGroup(-1)).not.toThrow();
    });

    it("ignores non-integer pids without throwing", () => {
      expect(() => killProcessGroup(Number.NaN)).not.toThrow();
      expect(() => killProcessGroup(1.5)).not.toThrow();
    });

    it("does not throw for an already-dead group (ESRCH is swallowed)", () => {
      // A pid that is almost certainly not a live group leader. Even if it
      // happened to exist, SIGKILL of a stranger's group would fail with EPERM
      // which is also swallowed — the call must never throw.
      expect(() => killProcessGroup(2_000_000_001)).not.toThrow();
    });
  });

  // The core guarantee: a detached leader's *forked children* (the producer in
  // a `yes | head` pipeline) are reaped when we kill the group by the leader
  // pid, not just the leader itself. Without detached spawn + negative-pid
  // signal, `yes` re-parents to PID 1 and spins a CPU core forever.
  describe("group reaping of a forked child", () => {
    let marker: string;

    beforeEach(() => {
      marker = `PGTESTMARKER_${crypto.randomUUID().replace(/-/g, "")}`;
    });

    afterEach(() => {
      // Defensive: reap anything a regression may have leaked so it can't bleed
      // CPU-spinning processes across the suite.
      Bun.spawnSync(["pkill", "-9", "-f", marker]);
    });

    it("reaps the forked producer child of a detached pipeline leader", async () => {
      // bash forks the pipeline: `yes <marker>` (long-lived, CPU-spinning) into
      // `head` (caps the buffer so we don't fill memory). The marker rides in
      // argv so pgrep -f can find a survivor. `detached: true` => the bash
      // process leads its own group, so pgid == pid and the negative-pid signal
      // reaches the whole pipeline.
      const proc = Bun.spawn(["bash", "-c", `yes ${marker} | head -n 100000000`], {
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      });

      // Wait until the forked producer is actually running before we kill, so
      // the assertion proves the GROUP kill reaped it (not that it never
      // started). pgrep -f matches the `yes <marker>` child by its argv.
      let alive = await countProcesses(marker);
      for (let i = 0; i < 20 && alive === 0; i++) {
        await sleep(50);
        alive = await countProcesses(marker);
      }
      expect(alive).toBeGreaterThan(0);

      killProcessGroup(proc.pid);

      // Poll briefly: signalling is async w.r.t. the OS reaping the group.
      let count = await countProcesses(marker);
      for (let i = 0; i < 20 && count > 0; i++) {
        await sleep(100);
        count = await countProcesses(marker);
      }
      expect(count).toBe(0);
    });

    it("leaks the forked child when only the leader pid is killed (control)", async () => {
      // Control case proving the test is meaningful: SIGKILLing ONLY the leader
      // (positive pid) leaves the forked `yes` producer orphaned/alive. This is
      // exactly the bug killProcessGroup fixes. We then clean it up via the
      // group kill so the test doesn't leak.
      const proc = Bun.spawn(["bash", "-c", `yes ${marker} | head -n 100000000`], {
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      });

      let alive = await countProcesses(marker);
      for (let i = 0; i < 20 && alive === 0; i++) {
        await sleep(50);
        alive = await countProcesses(marker);
      }
      expect(alive).toBeGreaterThan(0);

      // Kill ONLY the leader (positive pid) — the forked child survives.
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        // leader may already be gone; the child is what we assert on.
      }

      // Give the OS time to re-parent/keep the producer running.
      let survivors = await countProcesses(marker);
      for (let i = 0; i < 5 && survivors === 0; i++) {
        await sleep(50);
        survivors = await countProcesses(marker);
      }
      expect(survivors).toBeGreaterThan(0);

      // Now reap the orphan via the group kill so we don't leak.
      killProcessGroup(proc.pid);
      let count = await countProcesses(marker);
      for (let i = 0; i < 20 && count > 0; i++) {
        await sleep(100);
        count = await countProcesses(marker);
      }
      expect(count).toBe(0);
    });
  });
});
