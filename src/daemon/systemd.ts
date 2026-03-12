import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "./exec.ts";
import { buildSystemdUnit } from "./unit-builder.ts";
import { createLogger } from "../logger";
import type {
  OpenCrowService,
  ServiceInstallArgs,
  ServiceManageArgs,
  ServiceRuntime,
} from "./types.ts";

const log = createLogger("daemon");

function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function unitPath(unitName: string): string {
  if (isRoot()) return `/etc/systemd/system/${unitName}`;
  return path.join(os.homedir(), ".config", "systemd", "user", unitName);
}

async function systemctl(args: string[]) {
  if (isRoot()) return execFile("systemctl", args);
  return execFile("systemctl", ["--user", ...args]);
}

function parseKeyValues(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) {
      result[line.slice(0, eq).trim().toLowerCase()] = line
        .slice(eq + 1)
        .trim();
    }
  }
  return result;
}

async function enableLinger(): Promise<void> {
  if (isRoot()) return;
  const username = os.userInfo().username;
  const res = await execFile("loginctl", ["enable-linger", username]);
  if (res.code !== 0) {
    process.stderr.write(
      `Warning: loginctl enable-linger failed: ${res.stderr.trim()}\n`,
    );
  }
}

export function createSystemdService(
  unitName: string,
  description: string,
  opts?: {
    after?: readonly string[];
    requires?: readonly string[];
    restartSec?: number;
  },
): OpenCrowService {
  return {
    label: "systemd",

    async install({
      programArguments,
      workingDirectory,
      environmentFile,
      stdout,
      port,
    }: ServiceInstallArgs): Promise<void> {
      const p = unitPath(unitName);
      await fs.mkdir(path.dirname(p), { recursive: true });

      const home = os.homedir();
      const currentPath =
        process.env.PATH ??
        "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
      const bunBinDir = path.join(home, ".bun", "bin");
      const enrichedPath = currentPath.includes(bunBinDir)
        ? currentPath
        : `${bunBinDir}:${currentPath}`;

      const unit = buildSystemdUnit({
        description,
        programArguments,
        workingDirectory,
        environmentFile,
        environment: {
          HOME: home,
          PATH: enrichedPath,
        },
        after: opts?.after,
        requires: opts?.requires,
        restartSec: opts?.restartSec,
      });
      await fs.writeFile(p, unit, "utf8");

      const reload = await systemctl(["daemon-reload"]);
      if (reload.code !== 0) {
        throw new Error(`daemon-reload failed: ${reload.stderr.trim()}`);
      }

      const enable = await systemctl(["enable", unitName]);
      if (enable.code !== 0) {
        throw new Error(`enable failed: ${enable.stderr.trim()}`);
      }

      await systemctl(["stop", unitName]);

      if (port) {
        await execFile("fuser", ["-k", `${port}/tcp`]).catch((err) => log.debug("No process on port to kill (expected)", err));
        await Bun.sleep(500);
      }

      const start = await systemctl(["start", unitName]);
      if (start.code !== 0) {
        throw new Error(`start failed: ${start.stderr.trim()}`);
      }

      await enableLinger();

      stdout.write(
        `Installed systemd service (${isRoot() ? "system" : "user"}): ${p}\n`,
      );
    },

    async uninstall({ stdout }: ServiceManageArgs): Promise<void> {
      await systemctl(["disable", "--now", unitName]);
      const p = unitPath(unitName);
      try {
        await fs.unlink(p);
        stdout.write(`Removed: ${p}\n`);
      } catch {
        stdout.write(`Service file not found at ${p}\n`);
      }
      await systemctl(["daemon-reload"]);
    },

    async start({ stdout }: ServiceManageArgs): Promise<void> {
      const res = await systemctl(["start", unitName]);
      if (res.code !== 0) throw new Error(`start failed: ${res.stderr.trim()}`);
      stdout.write(`Started ${unitName}\n`);
    },

    async stop({ stdout }: ServiceManageArgs): Promise<void> {
      const res = await systemctl(["stop", unitName]);
      if (res.code !== 0) throw new Error(`stop failed: ${res.stderr.trim()}`);
      stdout.write(`Stopped ${unitName}\n`);
    },

    async restart({ stdout }: ServiceManageArgs): Promise<void> {
      const res = await systemctl(["restart", unitName]);
      if (res.code !== 0)
        throw new Error(`restart failed: ${res.stderr.trim()}`);
      stdout.write(`Restarted ${unitName}\n`);
    },

    async status(): Promise<ServiceRuntime> {
      const res = await systemctl([
        "show",
        unitName,
        "--no-page",
        "--property",
        "ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode",
      ]);
      if (res.code !== 0) {
        const missing = res.stderr.toLowerCase().includes("not found");
        return {
          status: missing ? "stopped" : "unknown",
          detail: res.stderr.trim(),
          missingUnit: missing,
        };
      }
      const kv = parseKeyValues(res.stdout);
      const activeState = kv["activestate"]?.toLowerCase();
      const pid = kv["mainpid"] ? parseInt(kv["mainpid"], 10) : undefined;
      return {
        status:
          activeState === "active"
            ? "running"
            : activeState
              ? "stopped"
              : "unknown",
        state: kv["activestate"],
        subState: kv["substate"],
        pid: pid && pid > 0 ? pid : undefined,
        lastExitStatus:
          kv["execmainstatus"] !== undefined
            ? parseInt(kv["execmainstatus"], 10)
            : undefined,
        lastExitReason: kv["execmaincode"],
      };
    },

    async isInstalled(): Promise<boolean> {
      const res = await systemctl(["is-enabled", unitName]);
      return res.code === 0;
    },
  };
}

// Backwards-compatible named exports for existing code
export const installSystemdService = createSystemdService(
  "opencrow.service",
  "OpenCrow AI Assistant",
).install;
export const uninstallSystemdService = createSystemdService(
  "opencrow.service",
  "OpenCrow AI Assistant",
).uninstall;
export const startSystemdService = createSystemdService(
  "opencrow.service",
  "OpenCrow AI Assistant",
).start;
export const stopSystemdService = createSystemdService(
  "opencrow.service",
  "OpenCrow AI Assistant",
).stop;
export const restartSystemdService = createSystemdService(
  "opencrow.service",
  "OpenCrow AI Assistant",
).restart;
export const readSystemdServiceStatus = createSystemdService(
  "opencrow.service",
  "OpenCrow AI Assistant",
).status;
export const isSystemdServiceInstalled = createSystemdService(
  "opencrow.service",
  "OpenCrow AI Assistant",
).isInstalled;
