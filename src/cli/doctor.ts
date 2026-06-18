import * as p from "@clack/prompts";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getAppDir, getVersion } from "./prompts.ts";

const APP_DIR = getAppDir();
const ENV_PATH = path.join(APP_DIR, ".env");

type CheckResult = {
  readonly name: string;
  readonly status: "pass" | "warn" | "fail";
  readonly message: string;
  readonly repair?: string;
};

function runCmd(cmd: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  const output =
    (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");
  return { ok: result.status === 0, output: output.trim() };
}

function readEnvVars(): Record<string, string> {
  if (!fs.existsSync(ENV_PATH)) return {};
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

async function checkBun(): Promise<CheckResult> {
  const result = runCmd("bun", ["--version"]);
  if (!result.ok) {
    return {
      name: "Bun",
      status: "fail",
      message: "Bun not found",
      repair: "curl -fsSL https://bun.sh/install | bash",
    };
  }
  const version = result.output.trim();
  const major = parseInt(version.split(".")[0] ?? "0", 10);
  if (major < 1) {
    return {
      name: "Bun",
      status: "warn",
      message: `Bun ${version} — upgrade recommended (>= 1.0)`,
      repair: "bun upgrade",
    };
  }
  return { name: "Bun", status: "pass", message: `v${version}` };
}

async function checkPostgres(): Promise<CheckResult> {
  const env = readEnvVars();
  const dbUrl = env.DATABASE_URL;
  if (!dbUrl) {
    return {
      name: "PostgreSQL",
      status: "fail",
      message: "DATABASE_URL not set in .env",
      repair: "opencrow setup",
    };
  }

  try {
    const { SQL } = await import("bun");
    const db = new SQL({ url: dbUrl, max: 1 });
    await db`SELECT 1 as ok`;
    await db.close();
    return { name: "PostgreSQL", status: "pass", message: "Connected" };
  } catch (err) {
    return {
      name: "PostgreSQL",
      status: "fail",
      message: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
      repair: "Check DATABASE_URL in .env and ensure PostgreSQL is running",
    };
  }
}

async function checkQdrant(): Promise<CheckResult> {
  const env = readEnvVars();
  const url = env.QDRANT_URL;
  if (!url) {
    return {
      name: "Qdrant",
      status: "warn",
      message: "QDRANT_URL not set (vector search disabled)",
    };
  }

  try {
    const res = await fetch(`${url}/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok
      ? { name: "Qdrant", status: "pass", message: "Healthy" }
      : { name: "Qdrant", status: "fail", message: `HTTP ${res.status}` };
  } catch {
    return {
      name: "Qdrant",
      status: "fail",
      message: "Connection failed",
      repair: "Ensure Qdrant is running on the configured URL",
    };
  }
}

async function checkEnvFile(): Promise<CheckResult> {
  if (!fs.existsSync(ENV_PATH)) {
    return {
      name: ".env file",
      status: "fail",
      message: "Not found",
      repair: "opencrow setup",
    };
  }

  const env = readEnvVars();
  const required = ["DATABASE_URL", "OPENCROW_WEB_TOKEN"];
  const missing = required.filter((k) => !env[k]);

  if (missing.length > 0) {
    return {
      name: ".env file",
      status: "fail",
      message: `Missing: ${missing.join(", ")}`,
      repair: "opencrow setup",
    };
  }

  return { name: ".env file", status: "pass", message: "Valid" };
}

async function checkService(): Promise<CheckResult> {
  try {
    const { resolveService } = await import("../daemon/service.ts");
    const svc = resolveService("core");
    const installed = await svc.isInstalled();
    if (!installed) {
      return {
        name: "Service",
        status: "warn",
        message: "Not installed",
        repair: "opencrow service core install",
      };
    }
    const runtime = await svc.status();
    return runtime.status === "running"
      ? {
          name: "Service",
          status: "pass",
          message: `Running (PID ${runtime.pid ?? "?"})`,
        }
      : {
          name: "Service",
          status: "fail",
          message: `Installed but ${runtime.status}`,
          repair: "opencrow service core start",
        };
  } catch (err) {
    return {
      name: "Service",
      status: "warn",
      message: `Could not check: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkDiskSpace(): Promise<CheckResult> {
  const result = runCmd("df", ["-h", APP_DIR]);
  if (!result.ok) {
    return { name: "Disk Space", status: "warn", message: "Could not check" };
  }
  const lines = result.output.split("\n");
  if (lines.length < 2) {
    return { name: "Disk Space", status: "warn", message: "Could not parse" };
  }
  const parts = lines[1]!.split(/\s+/);
  const usePercent = parseInt(parts[4] ?? "0", 10);
  if (usePercent > 90) {
    return {
      name: "Disk Space",
      status: "fail",
      message: `${usePercent}% used — critically low`,
    };
  }
  if (usePercent > 80) {
    return {
      name: "Disk Space",
      status: "warn",
      message: `${usePercent}% used`,
    };
  }
  return {
    name: "Disk Space",
    status: "pass",
    message: `${parts[3] ?? "?"} available`,
  };
}

/**
 * Validate the secrets the control plane and channels need at runtime.
 *
 * OPENCROW_INTERNAL_TOKEN gates the internal API (process control, SIGE/mem0,
 * the chat bridge) — without it those routes fail closed with 503. The web
 * dashboard token gates the UI. Surfacing absence here turns a confusing
 * runtime 503/lockout into a clear pre-flight signal.
 */
async function checkRuntimeTokens(): Promise<CheckResult> {
  const env = readEnvVars();
  const merged: Record<string, string | undefined> = {
    ...env,
    OPENCROW_INTERNAL_TOKEN:
      process.env.OPENCROW_INTERNAL_TOKEN ?? env.OPENCROW_INTERNAL_TOKEN,
    OPENCROW_WEB_TOKEN: process.env.OPENCROW_WEB_TOKEN ?? env.OPENCROW_WEB_TOKEN,
  };

  const missing = (["OPENCROW_INTERNAL_TOKEN", "OPENCROW_WEB_TOKEN"] as const).filter(
    (k) => !merged[k],
  );

  if (missing.includes("OPENCROW_INTERNAL_TOKEN")) {
    return {
      name: "Runtime tokens",
      status: "fail",
      message: `Missing: ${missing.join(", ")} — internal API fails closed (503) without OPENCROW_INTERNAL_TOKEN`,
      repair: "opencrow setup (regenerates tokens into .env)",
    };
  }

  if (missing.length > 0) {
    return {
      name: "Runtime tokens",
      status: "warn",
      message: `Missing: ${missing.join(", ")} — dashboard auth disabled`,
      repair: "opencrow setup",
    };
  }

  return { name: "Runtime tokens", status: "pass", message: "Configured" };
}

/**
 * Validate the OS-level probes the monitor's resource checks depend on.
 *
 * The monitor shells out for disk (`df -P`) and memory (Linux `free`, macOS
 * `vm_stat`/`sysctl`). If a probe binary is absent the check silently no-ops, so
 * verify availability here and warn rather than letting monitoring quietly do
 * nothing.
 */
async function checkMonitorProbes(): Promise<CheckResult> {
  const platform = process.platform;
  const missing: string[] = [];

  if (!runCmd("df", ["-P", "/"]).ok) missing.push("df");

  if (platform === "darwin") {
    if (!runCmd("vm_stat", []).ok) missing.push("vm_stat");
    if (!runCmd("sysctl", ["-n", "hw.memsize"]).ok) missing.push("sysctl");
  } else if (platform === "linux") {
    if (!runCmd("free", ["-m"]).ok) missing.push("free");
  } else {
    return {
      name: "Monitor probes",
      status: "warn",
      message: `Resource probes (disk/memory) are unsupported on ${platform}; those checks will no-op`,
    };
  }

  if (missing.length > 0) {
    return {
      name: "Monitor probes",
      status: "warn",
      message: `Missing: ${missing.join(", ")} — corresponding monitor checks will silently no-op`,
      repair:
        platform === "linux"
          ? "Install coreutils/procps (df, free)"
          : "Ensure df/vm_stat/sysctl are on PATH",
    };
  }

  return { name: "Monitor probes", status: "pass", message: "df + memory probes available" };
}

function printResult(result: CheckResult): void {
  const icon =
    result.status === "pass"
      ? "\x1b[32m✓\x1b[0m"
      : result.status === "warn"
        ? "\x1b[33m!\x1b[0m"
        : "\x1b[31m✗\x1b[0m";

  console.log(`  ${icon} ${result.name}: ${result.message}`);
  if (result.repair) {
    console.log(`    → ${result.repair}`);
  }
}

/**
 * Detect autonomous SIGE misconfig: the two switches must be consistent.
 *
 * - sige.enabled     — required for the SIGE process to run at all (manifest.ts).
 * - smart.sigeAuto.enabled — required for the autonomous scheduler to tick.
 *
 * Both must be true for autonomous SIGE to function. Common misconfig cases:
 *   sigeAuto ON but sige OFF  → scheduler ticks but no worker processes sessions.
 *   sige ON but sigeAuto OFF  → normal seeded-only mode (this is the default; not a problem).
 */
async function checkSigeAutoConfig(): Promise<CheckResult[]> {
  try {
    const { loadConfig } = await import("../config/loader");
    const cfg = loadConfig();
    const sigeEnabled = cfg.sige?.enabled === true;
    const sigeAutoEnabled = cfg.pipelines.ideas.smart.sigeAuto.enabled;
    const results: CheckResult[] = [];

    if (sigeAutoEnabled && !sigeEnabled) {
      results.push({
        name: "Autonomous SIGE config",
        status: "warn",
        message:
          "smart.sigeAuto.enabled=true but sige.enabled=false — autonomous scheduler ticks but the SIGE process is disabled; sessions will pile up unprocessed.",
        repair: "Set sige.enabled=true in your config, or disable sigeAuto.enabled",
      });
    }

    if (sigeEnabled && sigeAutoEnabled) {
      results.push({
        name: "Autonomous SIGE config",
        status: "pass",
        message: "Both sige.enabled and smart.sigeAuto.enabled are true — autonomous mode active",
      });
    }

    return results;
  } catch {
    // Config load failure is surfaced by other checks; don't double-report.
    return [];
  }
}

export async function runDoctor(): Promise<void> {
  p.intro(`OpenCrow v${getVersion()} — Health Check`);

  const env = readEnvVars();
  const hasQdrant = Boolean(env.QDRANT_URL);

  const sigeAutoChecks = await checkSigeAutoConfig();

  const checks = await Promise.all([
    checkBun(),
    checkEnvFile(),
    checkRuntimeTokens(),
    checkPostgres(),
    ...(hasQdrant ? [checkQdrant()] : []),
    checkService(),
    checkDiskSpace(),
    checkMonitorProbes(),
  ]);

  const allChecks = [...checks, ...sigeAutoChecks];

  console.log("");
  for (const check of allChecks) {
    printResult(check);
  }
  console.log("");

  const fails = allChecks.filter((c) => c.status === "fail").length;
  const warns = allChecks.filter((c) => c.status === "warn").length;
  const passes = allChecks.filter((c) => c.status === "pass").length;

  if (fails > 0) {
    p.outro(`${passes} passed, ${warns} warnings, ${fails} failures`);
    process.exit(1);
  } else if (warns > 0) {
    p.outro(`${passes} passed, ${warns} warnings`);
  } else {
    p.outro(`All ${passes} checks passed`);
  }
}
