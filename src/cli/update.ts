import * as p from "@clack/prompts";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { getAppDir, getVersion } from "./prompts.ts";

const APP_DIR = getAppDir();
const ROLLBACK_LOG = path.join(homedir(), ".opencrow", "rollback.log");

function run(cmd: string, args: string[], label: string): boolean {
  const s = p.spinner();
  s.start(label);
  const result = spawnSync(cmd, args, {
    cwd: APP_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  const output = (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");
  if (result.status !== 0) {
    s.stop(`${label} — failed`);
    p.log.error(output);
    return false;
  }
  s.stop(`${label} — done`);
  return true;
}

/** Resolve the current git HEAD inside the app dir, or null if unavailable. */
function currentCommit(): string | null {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: APP_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  if (result.status !== 0) return null;
  const commit = (result.stdout?.toString() ?? "").trim();
  return /^[0-9a-f]{7,40}$/.test(commit) ? commit : null;
}

/**
 * Run `opencrow doctor` as a subprocess so its `process.exit(1)` on failure does
 * not abort the update flow. Returns true only when doctor exits cleanly.
 */
function runDoctorSubprocess(): boolean {
  const result = spawnSync("bun", ["run", "src/cli.ts", "doctor"], {
    cwd: APP_DIR,
    stdio: ["ignore", "inherit", "inherit"],
    timeout: 120_000,
  });
  return result.status === 0;
}

/**
 * Append a RollbackEvent in the line-delimited JSON shape that
 * health/rollback-notifier.ts#consumeRollbackEvents reads, so the guardian
 * surfaces the rollback to operators. Best-effort: a logging failure must not
 * mask the rollback itself.
 */
function emitRollbackEvent(from: string, to: string, reason: string): void {
  try {
    fs.mkdirSync(path.dirname(ROLLBACK_LOG), { recursive: true });
    const event = {
      timestamp: new Date().toISOString(),
      from,
      to,
      reason,
    };
    fs.appendFileSync(ROLLBACK_LOG, `${JSON.stringify(event)}\n`);
  } catch (err) {
    p.log.warn(
      `Could not record rollback event: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function restartServiceIfRunning(): Promise<void> {
  try {
    const { resolveService } = await import("../daemon/service.ts");
    const svc = resolveService("core");
    const runtime = await svc.status();
    if (runtime.status === "running") {
      p.log.info("Restarting service...");
      await svc.restart({ stdout: process.stdout });
    }
  } catch {
    p.log.info("No running service to restart");
  }
}

export async function runUpdate(): Promise<void> {
  p.intro(`OpenCrow v${getVersion()} — Update`);

  // 0. Checkpoint the known-good commit BEFORE we mutate the tree, so a failed
  //    deploy has a concrete target to roll back to. Persist it via the shared
  //    checkpoint helper and also keep it locally for this run.
  const knownGood = currentCommit();
  try {
    const { recordKnownGoodCommit } = await import("../health/checkpoint.ts");
    await recordKnownGoodCommit();
  } catch {
    // Non-fatal: we still hold `knownGood` locally for the rollback path below.
  }
  if (!knownGood) {
    p.log.warn("Could not determine current commit — rollback will be unavailable");
  }

  // 1. Git pull
  if (!run("git", ["pull", "origin", "master"], "Pulling latest changes")) {
    p.outro("Update failed at git pull");
    process.exit(1);
  }

  // 2. Bun install
  if (!run("bun", ["install"], "Installing dependencies")) {
    p.outro("Update failed at bun install");
    process.exit(1);
  }

  // 3. Restart service if running
  await restartServiceIfRunning();

  // 4. Doctor check (subprocess so its exit(1) doesn't kill us)
  p.log.step("Running health check...");
  const healthy = runDoctorSubprocess();

  if (healthy) {
    p.outro("Update complete!");
    return;
  }

  // 5. Post-update health check failed — offer rollback to the checkpoint.
  p.log.error("Health check failed after update.");

  if (!knownGood) {
    p.log.warn(
      "No known-good commit recorded; cannot roll back automatically. " +
        "Inspect the failures above and recover manually.",
    );
    p.outro("Update finished with health-check failures (no rollback available)");
    return;
  }

  const shouldRollback = await p.confirm({
    message: `Roll back to the last known-good commit (${knownGood.slice(0, 8)}) and restart?`,
    initialValue: true,
  });

  if (p.isCancel(shouldRollback) || !shouldRollback) {
    p.log.warn("Skipping rollback — leaving the updated (unhealthy) tree in place.");
    p.outro("Update finished with health-check failures (rollback declined)");
    return;
  }

  const failed = currentCommit() ?? "unknown";

  if (!run("git", ["reset", "--hard", knownGood], "Rolling back to known-good commit")) {
    p.log.error("Rollback failed — manual recovery required.");
    p.outro("Rollback failed");
    return;
  }

  // Reinstall deps for the rolled-back tree, then restart.
  run("bun", ["install"], "Reinstalling dependencies");
  await restartServiceIfRunning();

  emitRollbackEvent(failed, knownGood, "post-update health check failed");
  p.log.success(`Rolled back to ${knownGood.slice(0, 8)} and restarted.`);
  p.outro("Update rolled back after health-check failure");
}
