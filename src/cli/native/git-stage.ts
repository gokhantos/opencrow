// src/cli/native/git-stage.ts
import { spawnSync } from "node:child_process";
import { createLogger } from "../../logger.ts";

const log = createLogger("native:git-stage");

// 16 MiB cap for `git show` stdout. The mem0 sidecar files (app.py,
// requirements.txt) are a few KB; this is generous headroom that still bounds
// memory if pointed at an unexpectedly large blob.
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

// Bound both git calls so a stalled remote can't wedge a deploy: `spawnSync`
// kills the child after `timeout` ms and returns a non-zero/error result, which
// our callers already treat as soft (fetch → warn + proceed; show → fallback).
const FETCH_TIMEOUT_MS = 30_000;
const SHOW_TIMEOUT_MS = 15_000;

/**
 * Materialize a repo file as it exists at `origin/master` (the merged, reviewed
 * ref) rather than the caller's local working tree.
 *
 * Why: many concurrent sessions share one checkout, and the staged sidecar
 * (`~/.opencrow/mem0/app/app.py`) is a single shared resource. Deploying from
 * the working tree lets a session with a STALE checkout silently re-stage old
 * code over a newer, already-merged fix. Reading from `origin/master` makes the
 * deployed bytes match a reviewed ref (RULE 3/5) and immune to a stale tree.
 *
 * Deliberate behavior change: a developer's UNCOMMITTED local edit to this file
 * will NOT be deployed by this path — origin/master wins. The sidecar must ship
 * reviewed code; the working-tree fallback only fires when origin/master is
 * genuinely unavailable (not a git repo, no `origin` remote, file absent there).
 *
 * Returns the file's bytes on success, or `null` on ANY failure (caller should
 * fall back to the working tree). `encoding: "buffer"` is intentional: app.py
 * contains non-ASCII characters (em-dashes, ellipses), so we must return the
 * exact bytes and never round-trip through a lossy string decode.
 */
export function readRepoFileFromOriginMaster(
  repoDir: string,
  repoRelPath: string,
): Buffer | null {
  // Best-effort refresh so `origin/master` is current. If this fails (offline,
  // no remote, auth), DO NOT abort — fall through and read whatever
  // `origin/master` ref already exists locally. That is still strictly better
  // than the working tree.
  const fetch = spawnSync("git", ["-C", repoDir, "fetch", "origin"], {
    stdio: "ignore",
    timeout: FETCH_TIMEOUT_MS,
  });
  if (fetch.status !== 0) {
    log.warn("git fetch origin failed; reading existing local origin/master ref", {
      repoDir,
      reason: fetch.error?.message ?? `exited ${fetch.status}`,
    });
  }

  const show = spawnSync(
    "git",
    ["-C", repoDir, "show", `origin/master:${repoRelPath}`],
    { encoding: "buffer", maxBuffer: MAX_BUFFER_BYTES, timeout: SHOW_TIMEOUT_MS },
  );

  if (show.status !== 0 || !show.stdout || show.stdout.length === 0) {
    log.warn("could not read file from origin/master", {
      repoDir,
      repoRelPath,
      reason: show.error?.message ?? `exited ${show.status}`,
    });
    return null;
  }

  return show.stdout;
}
