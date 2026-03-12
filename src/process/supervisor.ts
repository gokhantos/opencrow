import type { ProcessName } from "./types";
import {
  registerProcess,
  heartbeat,
  unregisterProcess,
  getProcess,
} from "./registry";
import {
  consumePendingCommands,
  acknowledgeCommand,
  cleanupOldCommands,
} from "./commands";
import { createLogger } from "../logger";

const log = createLogger("process:supervisor");

const HEARTBEAT_INTERVAL_MS = 5_000;
const COMMAND_POLL_INTERVAL_MS = 3_000;
const CLEANUP_INTERVAL_MS = 300_000; // 5 min

const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ProcessSupervisor {
  start(): Promise<void>;
  stop(): Promise<void>;
  onShutdown(hook: () => void | Promise<void>): void;
}

export function createProcessSupervisor(
  name: ProcessName,
  metadata: Record<string, unknown> = {},
): ProcessSupervisor {
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let commandTimer: ReturnType<typeof setInterval> | null = null;
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  const shutdownHooks: Array<() => void | Promise<void>> = [];

  async function pollCommands(): Promise<void> {
    try {
      const commands = await consumePendingCommands(name);

      for (const cmd of commands) {
        // Only handle process-level commands; skip app-specific ones
        if (cmd.action !== "restart" && cmd.action !== "stop") continue;

        log.info("Received process command", {
          process: name,
          action: cmd.action,
          commandId: cmd.id,
        });

        await acknowledgeCommand(cmd.id);

        if (cmd.action === "restart") {
          log.info("Restarting process (exit 0 for systemd restart)", {
            process: name,
          });
          await drainHooks();
          await unregisterProcess(name);
          process.exit(0);
        }

        if (cmd.action === "stop") {
          log.info("Stopping process", { process: name });
          await drainHooks();
          await unregisterProcess(name);
          process.exit(0);
        }
      }
    } catch (err) {
      log.error("Command poll failed", { process: name, error: err });
    }
  }

  async function doHeartbeat(): Promise<void> {
    try {
      await heartbeat(name);
    } catch (err) {
      log.error("Heartbeat failed", { process: name, error: err });
    }
  }

  async function doCleanup(): Promise<void> {
    try {
      await cleanupOldCommands();
    } catch (err) {
      log.error("Command cleanup failed", { process: name, error: err });
    }
  }

  async function drainHooks(): Promise<void> {
    if (shutdownHooks.length === 0) return;
    log.info("Draining shutdown hooks", {
      process: name,
      count: shutdownHooks.length,
    });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        log.warn("Shutdown hook timeout reached", { process: name });
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);
    });
    await Promise.race([
      Promise.allSettled(shutdownHooks.map((fn) => Promise.resolve(fn()))),
      timeout,
    ]);
    clearTimeout(timeoutHandle);
  }

  async function ensureSingleInstance(): Promise<void> {
    // Skip when spawned by the orchestrator (IPC channel present).
    // The orchestrator manages child lifecycle — killing siblings here
    // causes a restart loop (SIGTERM → exit 0 → orchestrator respawns → repeat).
    if (typeof process.send === "function") {
      log.debug("Spawned by orchestrator, skipping ensureSingleInstance", {
        process: name,
      });
      return;
    }

    const existing = await getProcess(name);
    if (!existing || existing.pid === process.pid) return;

    const isAlive = (() => {
      try {
        process.kill(existing.pid, 0);
        return true;
      } catch {
        return false;
      }
    })();

    if (!isAlive) {
      log.info("Stale process record (already dead)", {
        process: name,
        stalePid: existing.pid,
      });
      return;
    }

    log.info("Killing stale process", {
      process: name,
      stalePid: existing.pid,
      currentPid: process.pid,
    });

    try {
      process.kill(existing.pid, "SIGTERM");
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        try {
          process.kill(existing.pid, 0);
        } catch {
          log.info("Stale process exited after SIGTERM", {
            pid: existing.pid,
          });
          return;
        }
      }
      log.warn("Stale process did not exit, sending SIGKILL", {
        pid: existing.pid,
      });
      process.kill(existing.pid, "SIGKILL");
    } catch {
      // Process disappeared between checks
    }
  }

  // Respond to IPC ping from orchestrator
  function setupPingResponder(): void {
    if (typeof process.send === "function") {
      process.on("message", (msg: unknown) => {
        if (msg === "ping") {
          process.send!("pong");
        }
      });
    }
  }

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;

      setupPingResponder();
      await ensureSingleInstance();
      await registerProcess(name, metadata);
      log.info("Process registered", { process: name, pid: process.pid });

      heartbeatTimer = setInterval(doHeartbeat, HEARTBEAT_INTERVAL_MS);
      commandTimer = setInterval(pollCommands, COMMAND_POLL_INTERVAL_MS);
      cleanupTimer = setInterval(doCleanup, CLEANUP_INTERVAL_MS);

      // Graceful shutdown
      const shutdown = async () => {
        if (!running) return;
        running = false;
        log.info("Graceful shutdown", { process: name });
        await drainHooks();
        await unregisterProcess(name);
        process.exit(0);
      };

      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    },

    async stop(): Promise<void> {
      if (!running) return;
      running = false;

      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (commandTimer) clearInterval(commandTimer);
      if (cleanupTimer) clearInterval(cleanupTimer);
      heartbeatTimer = null;
      commandTimer = null;
      cleanupTimer = null;

      await drainHooks();
      await unregisterProcess(name);
      log.info("Process supervisor stopped", { process: name });
    },

    onShutdown(hook: () => void | Promise<void>): void {
      shutdownHooks.push(hook);
    },
  };
}
