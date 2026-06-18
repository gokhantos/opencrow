import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "./exec.ts";
import { buildLaunchdPlist } from "./unit-builder.ts";
import type {
  OpenCrowService,
  ServiceInstallArgs,
  ServiceManageArgs,
  ServiceRuntime,
} from "./types.ts";

const LOG_DIR = path.join(os.homedir(), ".opencrow", "logs");

function domain(): string {
  return typeof process.getuid === "function"
    ? `gui/${process.getuid()}`
    : "gui/501";
}

async function launchctl(args: string[]) {
  return execFile("launchctl", args);
}

/** Poll launchctl print until the service is no longer running, up to ~5s */
async function waitForProcessExit(dom: string, label: string): Promise<void> {
  const POLL_MS = 250;
  const MAX_POLLS = 20;
  for (let i = 0; i < MAX_POLLS; i++) {
    await Bun.sleep(POLL_MS);
    const res = await launchctl(["print", `${dom}/${label}`]);
    if (res.code !== 0) return;
    const lower = res.stdout.toLowerCase();
    if (
      !lower.includes("pid =") &&
      !lower.includes('"running"') &&
      !lower.includes("state = running")
    ) {
      return;
    }
  }
}

function isNotLoaded(res: { stderr: string; stdout: string }): boolean {
  const detail = (res.stderr + res.stdout).toLowerCase();
  return (
    detail.includes("no such process") ||
    detail.includes("could not find service") ||
    detail.includes("not found")
  );
}

export function createLaunchdService(
  label: string,
  logPrefix: string,
  restartSec?: number,
): OpenCrowService {
  const plistPath = path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    `${label}.plist`,
  );

  return {
    label: "LaunchAgent",

    async install({
      programArguments,
      workingDirectory,
      environmentFile,
      stdout,
    }: ServiceInstallArgs): Promise<void> {
      const dom = domain();
      await fs.mkdir(LOG_DIR, { recursive: true });
      await fs.mkdir(path.dirname(plistPath), { recursive: true });

      const plist = buildLaunchdPlist({
        label,
        programArguments,
        workingDirectory,
        environmentFile,
        stdoutPath: path.join(LOG_DIR, `${logPrefix}.log`),
        stderrPath: path.join(LOG_DIR, `${logPrefix}.err.log`),
        ...(restartSec !== undefined ? { throttleInterval: restartSec } : {}),
      });
      await fs.writeFile(plistPath, plist, "utf8");

      await launchctl(["bootout", dom, plistPath]);
      await launchctl(["unload", plistPath]);
      await waitForProcessExit(dom, label);
      await launchctl(["enable", `${dom}/${label}`]);

      const boot = await launchctl(["bootstrap", dom, plistPath]);
      if (boot.code !== 0) {
        throw new Error(`launchctl bootstrap failed: ${boot.stderr.trim()}`);
      }

      await launchctl(["kickstart", "-k", `${dom}/${label}`]);

      stdout.write(`Installed LaunchAgent: ${plistPath}\n`);
      stdout.write(`Logs: ${LOG_DIR}/${logPrefix}.log\n`);
    },

    async uninstall({ stdout }: ServiceManageArgs): Promise<void> {
      const dom = domain();
      await launchctl(["bootout", dom, plistPath]);
      await launchctl(["unload", plistPath]);
      try {
        await fs.unlink(plistPath);
        stdout.write(`Removed: ${plistPath}\n`);
      } catch {
        stdout.write(`LaunchAgent not found at ${plistPath}\n`);
      }
    },

    async start({ stdout }: ServiceManageArgs): Promise<void> {
      const dom = domain();
      await launchctl(["bootstrap", dom, plistPath]);
      const kick = await launchctl(["kickstart", `${dom}/${label}`]);
      if (kick.code !== 0)
        throw new Error(`kickstart failed: ${kick.stderr.trim()}`);
      stdout.write(`Started ${label}\n`);
    },

    async stop({ stdout }: ServiceManageArgs): Promise<void> {
      const dom = domain();
      const res = await launchctl(["bootout", `${dom}/${label}`]);
      if (res.code !== 0 && !isNotLoaded(res)) {
        throw new Error(`bootout failed: ${res.stderr.trim()}`);
      }
      stdout.write(`Stopped ${label}\n`);
    },

    async restart({ stdout }: ServiceManageArgs): Promise<void> {
      const dom = domain();
      const res = await launchctl(["kickstart", "-k", `${dom}/${label}`]);
      if (res.code !== 0)
        throw new Error(`kickstart failed: ${res.stderr.trim()}`);
      stdout.write(`Restarted ${label}\n`);
    },

    async status(): Promise<ServiceRuntime> {
      const dom = domain();
      const res = await launchctl(["print", `${dom}/${label}`]);
      if (res.code !== 0) {
        return {
          status: "unknown",
          missingUnit: true,
          detail: res.stderr.trim(),
        };
      }
      const kv: Record<string, string> = {};
      for (const line of res.stdout.split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) {
          kv[line.slice(0, eq).trim().toLowerCase()] = line
            .slice(eq + 1)
            .trim();
        }
      }
      const state = kv["state"]?.toLowerCase();
      const pid = kv["pid"] ? parseInt(kv["pid"], 10) : undefined;
      return {
        status:
          state === "running" || pid ? "running" : state ? "stopped" : "unknown",
        state: kv["state"],
        pid,
        lastExitStatus: kv["last exit status"]
          ? parseInt(kv["last exit status"], 10)
          : undefined,
        lastExitReason: kv["last exit reason"],
      };
    },

    async isInstalled(): Promise<boolean> {
      const res = await launchctl(["print", `${domain()}/${label}`]);
      return res.code === 0;
    },
  };
}

// Backwards-compatible named exports for existing code
export const installLaunchAgent =
  createLaunchdService("ai.opencrow.app", "opencrow").install;
export const uninstallLaunchAgent =
  createLaunchdService("ai.opencrow.app", "opencrow").uninstall;
export const startLaunchAgent =
  createLaunchdService("ai.opencrow.app", "opencrow").start;
export const stopLaunchAgent =
  createLaunchdService("ai.opencrow.app", "opencrow").stop;
export const restartLaunchAgent =
  createLaunchdService("ai.opencrow.app", "opencrow").restart;
export const readLaunchAgentStatus =
  createLaunchdService("ai.opencrow.app", "opencrow").status;
export const isLaunchAgentInstalled =
  createLaunchdService("ai.opencrow.app", "opencrow").isInstalled;
