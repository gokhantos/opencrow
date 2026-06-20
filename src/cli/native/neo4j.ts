// src/cli/native/neo4j.ts
//
// Native Neo4j (Community) provisioner. mem0's graph backend connects to this
// over Bolt at bolt://127.0.0.1:7687. Unlike Qdrant (a single static binary we
// download + run under our own launchd plist), Neo4j ships a JVM app with its
// own config/data layout, and the Homebrew formula is designed to run via
// `brew services` (same pattern Postgres uses in provision.ts). We therefore:
//   1. require the `neo4j` formula (pulls cypher-shell + openjdk@21),
//   2. pin the listen addresses to loopback in neo4j.conf (defense-in-depth —
//      see pinLoopback below),
//   3. set the initial password BEFORE first start (idempotent — only when the
//      auth store is uninitialized; set-initial-password refuses otherwise),
//   4. start (or restart, to apply the conf pin) via `brew services`,
//   5. wait for Bolt on 127.0.0.1:7687 to accept TCP connections.
//
// The password is generated/persisted by provision.ts into .env (same place as
// OPENCROW_INTERNAL_TOKEN) and threaded in here.
import net from "node:net";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

export const NEO4J_BOLT_HOST = "127.0.0.1";
export const NEO4J_BOLT_PORT = 7687;
export const NEO4J_HTTP_PORT = 7474;

/**
 * Loopback pins applied to neo4j.conf. Keyed by config property; each replaces
 * any existing (commented or uncommented) line for that key, or is appended.
 * This is defense-in-depth: the Homebrew formula already defaults
 * server.default_listen_address to localhost, but we never want to silently
 * rely on that default — an upstream default change or a stray edit could
 * otherwise expose Bolt/HTTP on all interfaces.
 */
const LOOPBACK_PINS: ReadonlyArray<readonly [string, string]> = [
  ["server.default_listen_address", "127.0.0.1"],
  ["server.bolt.listen_address", `127.0.0.1:${NEO4J_BOLT_PORT}`],
  ["server.http.listen_address", `127.0.0.1:${NEO4J_HTTP_PORT}`],
];

function brewPrefix(): string {
  const out = spawnSync("brew", ["--prefix"], { encoding: "utf8" }).stdout?.trim();
  if (!out) throw new Error("Homebrew not found — install from https://brew.sh");
  return out;
}

function neo4jAdminPath(prefix: string): string {
  return `${prefix}/opt/neo4j/bin/neo4j-admin`;
}

/**
 * Resolve the active neo4j.conf. The Homebrew `neo4j` formula keeps config under
 * the Cellar's libexec/conf (NEO4J_HOME), reached via the version-tracking
 * `$prefix/opt/neo4j` symlink — there is no `$prefix/etc/neo4j`. Going through
 * the symlink keeps us version-agnostic across `brew upgrade`.
 */
function neo4jConfPath(prefix: string): string {
  return `${prefix}/opt/neo4j/libexec/conf/neo4j.conf`;
}

/**
 * Apply a single `key=value` pin to a neo4j.conf body. Idempotent at the line
 * level: replaces an existing line for `key` whether it is commented (`#key=…`)
 * or active (`key=…`), so re-runs never duplicate. Returns the (possibly
 * unchanged) body and whether a change was made.
 */
export function applyConfPin(
  body: string,
  key: string,
  value: string,
): { readonly body: string; readonly changed: boolean } {
  const desired = `${key}=${value}`;
  // Match an active or commented assignment for exactly this key.
  const lineRe = new RegExp(
    `^[ \\t]*#?[ \\t]*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*=.*$`,
    "m",
  );
  if (lineRe.test(body)) {
    let replaced = false;
    const next = body.replace(lineRe, (match) => {
      if (match === desired) return match; // already exactly correct
      replaced = true;
      return desired;
    });
    return { body: next, changed: replaced };
  }
  const sep = body.length === 0 || body.endsWith("\n") ? "" : "\n";
  return { body: `${body}${sep}${desired}\n`, changed: true };
}

/**
 * Pin Neo4j's listen addresses to loopback in neo4j.conf. Idempotent: only
 * rewrites the file when at least one pin actually changes. Returns true when
 * the file was modified (caller must restart the service to apply).
 */
export function pinLoopback(confPath: string, w: NodeJS.WritableStream): boolean {
  if (!fs.existsSync(confPath)) {
    w.write(
      `Warning: neo4j.conf not found at ${confPath}; skipping loopback pin (relying on formula default localhost binding).\n`,
    );
    return false;
  }
  const original = fs.readFileSync(confPath, "utf8");
  let body = original;
  for (const [key, value] of LOOPBACK_PINS) {
    body = applyConfPin(body, key, value).body;
  }
  if (body === original) return false;
  fs.writeFileSync(confPath, body, "utf8");
  w.write("Pinned Neo4j Bolt/HTTP listen addresses to 127.0.0.1 in neo4j.conf.\n");
  return true;
}

/**
 * Read the active loopback pins from a neo4j.conf body. Returns the resolved
 * value for each pinned key (uncommented lines only), or undefined when the key
 * is absent/commented. Used by the doctor check to assert the conf actually
 * pins loopback rather than trusting a TCP probe (which passes against 0.0.0.0).
 */
export function readActiveListenAddresses(
  confPath: string,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key] of LOOPBACK_PINS) out[key] = undefined;
  if (!fs.existsSync(confPath)) return out;
  const body = fs.readFileSync(confPath, "utf8");
  for (const [key] of LOOPBACK_PINS) {
    const re = new RegExp(
      `^[ \\t]*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*=[ \\t]*(.+?)[ \\t]*$`,
      "m",
    );
    const m = body.match(re);
    if (m?.[1]) out[key] = m[1];
  }
  return out;
}

/** Active conf path for external callers (doctor). */
export function activeConfPath(): string {
  return neo4jConfPath(brewPrefix());
}

/**
 * True when every pinned key is present and bound to loopback (127.0.0.1) in
 * the given conf. A value is considered loopback if it is exactly 127.0.0.1 or
 * a `127.0.0.1:<port>` form. Defaults (commented-out) do NOT count — we require
 * an explicit pin.
 */
export function confPinsLoopback(confPath: string): boolean {
  const active = readActiveListenAddresses(confPath);
  for (const [key] of LOOPBACK_PINS) {
    const v = active[key];
    if (!v) return false;
    const host = v.includes(":") ? v.slice(0, v.lastIndexOf(":")) : v;
    if (host !== "127.0.0.1") return false;
  }
  return true;
}

/**
 * TCP probe for Bolt readiness. Resolves true once the port accepts a
 * connection within the timeout, false otherwise. No data is sent.
 */
export function probeBolt(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

async function waitForBolt(attempts: number, delayMs: number): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await probeBolt(NEO4J_BOLT_HOST, NEO4J_BOLT_PORT, 1000)) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

/**
 * Classify a non-zero `neo4j-admin dbms set-initial-password` exit. The command
 * only succeeds while the auth store is uninitialized; on an already-initialized
 * store it fails with a recognizable message. We must NOT swallow genuine
 * failures (bad permissions, wrong binary, JVM error) as "already initialized".
 */
export function isAlreadyInitialized(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("already") ||
    s.includes("initial password was not set because live data was found") ||
    s.includes("the provided initial password was not set because") ||
    s.includes("auth file") // older phrasing referencing an existing auth file
  );
}

/**
 * Set the initial Neo4j password. `neo4j-admin dbms set-initial-password` only
 * works while the auth store is uninitialized; on an already-initialized store
 * it exits non-zero with an "already initialized" message, which we treat as a
 * no-op (the password in .env is reused across runs). Any OTHER non-zero exit
 * (bad perms, wrong binary, JVM crash) is a real error and is surfaced.
 *
 * SECURITY NOTE: this version of `neo4j-admin` (2026.x) takes the password as a
 * required positional argument and exposes no stdin/env/config alternative
 * (`--help` shows only `<password>` + `--additional-config`). The secret is
 * therefore briefly visible via `ps` for the lifetime of this one short-lived
 * command — but ONLY on the very first provision (the command no-ops once the
 * store is initialized), and only to local processes of the same user. There is
 * no non-argv path to remove this window on this version; if a future version
 * adds one (env var / stdin), migrate to it here.
 */
function setInitialPassword(prefix: string, password: string, w: NodeJS.WritableStream): void {
  const admin = neo4jAdminPath(prefix);
  const res = spawnSync(admin, ["dbms", "set-initial-password", password], {
    encoding: "utf8",
  });
  if (res.status === 0) {
    w.write("Neo4j initial password set.\n");
    return;
  }

  const stderr = (res.stderr ?? "") + (res.stdout ?? "");

  // spawn itself failed (binary missing / not executable) — not "initialized".
  if (res.error) {
    throw new Error(
      `neo4j-admin set-initial-password failed to run (${admin}): ${res.error.message}`,
    );
  }

  if (isAlreadyInitialized(stderr)) {
    w.write(
      "Neo4j auth store already initialized; keeping existing password (set-initial-password no-op).\n",
    );
    return;
  }

  // Genuine failure (bad perms, wrong binary, JVM error). Surface it.
  throw new Error(
    `neo4j-admin set-initial-password failed (exit ${res.status}): ${stderr.trim() || "no output"}`,
  );
}

/**
 * Restart Neo4j to apply a conf change. We do an explicit stop → wait-for-port-
 * release → start rather than `brew services restart`: the combined restart can
 * race, launching the new JVM before the old one releases Bolt/HTTP, which
 * leaves the launchd job in an `error` state. Stopping first avoids that race.
 */
async function restartService(w: NodeJS.WritableStream): Promise<void> {
  w.write("Restarting native Neo4j to apply loopback pin (stop → start)…\n");
  const stop = spawnSync("brew", ["services", "stop", "neo4j"], { stdio: "inherit" });
  if (stop.status !== 0 && stop.status !== null) {
    w.write("Warning: brew services stop neo4j returned non-zero status\n");
  }
  // Wait for Bolt to actually stop listening so the new JVM can rebind.
  for (let i = 0; i < 20; i++) {
    if (!(await probeBolt(NEO4J_BOLT_HOST, NEO4J_BOLT_PORT, 500))) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const start = spawnSync("brew", ["services", "start", "neo4j"], { stdio: "inherit" });
  if (start.status !== 0 && start.status !== null) {
    w.write("Warning: brew services start neo4j returned non-zero status\n");
  }
}

export async function provisionNeo4j(
  password: string,
  w: NodeJS.WritableStream,
): Promise<void> {
  if (!password) throw new Error("provisionNeo4j: empty NEO4J_PASSWORD");
  const prefix = brewPrefix();

  // Defense-in-depth: pin listen addresses to loopback before (re)starting.
  const confPath = neo4jConfPath(prefix);
  const confChanged = pinLoopback(confPath, w);

  // Set the initial password before the first start (no-op if already set).
  setInitialPassword(prefix, password, w);

  // Was Bolt already up before we touched anything? If the conf changed we must
  // restart a running service for the pin to take effect.
  const wasRunning = await probeBolt(NEO4J_BOLT_HOST, NEO4J_BOLT_PORT, 1000);

  if (wasRunning && confChanged) {
    await restartService(w);
  } else if (!wasRunning) {
    w.write("Starting native Neo4j (brew services)…\n");
    const start = spawnSync("brew", ["services", "start", "neo4j"], { stdio: "inherit" });
    if (start.status !== 0 && start.status !== null) {
      w.write("Warning: brew services start neo4j returned non-zero status\n");
    }
  } else {
    w.write("Neo4j already running and conf unchanged; no restart needed.\n");
  }

  const ready = await waitForBolt(40, 1500);
  if (!ready) {
    throw new Error(
      `Neo4j Bolt did not become reachable on ${NEO4J_BOLT_HOST}:${NEO4J_BOLT_PORT} after ~60s — check ${prefix}/opt/neo4j/libexec/logs/`,
    );
  }

  // Re-probe + assert the conf actually pins loopback (the TCP probe alone
  // cannot distinguish 127.0.0.1 from a 0.0.0.0 bind).
  if (!confPinsLoopback(confPath)) {
    w.write(
      `Warning: neo4j.conf at ${confPath} does not explicitly pin loopback after provisioning; verify it manually.\n`,
    );
  }
  w.write(`Neo4j ready on bolt://${NEO4J_BOLT_HOST}:${NEO4J_BOLT_PORT}\n`);
}
