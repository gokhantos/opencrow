import { createLogger } from "../logger";
import { acknowledgeCommand, cleanupOldCommands, consumePendingCommands } from "./commands";
import { decideStaleAction, INSTANCE_ID_KEY, type StaleDecisionInput } from "./instance-guard";
import { getProcess, heartbeat, registerProcess, unregisterProcess } from "./registry";
import { detectInContainer, isAncestorOf, isPidAlive } from "./runtime-probes";
import type { ProcessName } from "./types";

const log = createLogger("process:supervisor");

/**
 * How often each process writes its liveness heartbeat to process_registry.
 * The orphan-cleanup threshold in the orchestrator is 60 s, so 15 s gives a
 * comfortable 4:1 safety margin while cutting DB writes by 3× vs the old 5 s.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * How often each process reads its pending commands (restart / stop).
 * Commands are low-urgency (a restart can tolerate a few extra seconds).
 * Raising from 3 s to 10 s cuts one of the highest-frequency DB selects.
 */
const COMMAND_POLL_INTERVAL_MS = 10_000;

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
  // Unique per-process-start identity. Persisted into the registry row so a
  // later boot can positively tell whether a stale row belongs to a genuinely
  // different live instance (kill-eligible on a host) vs. a recycled PID that
  // merely collides (never kill — see instance-guard.ts).
  const instanceId = crypto.randomUUID();
  const registryMetadata: Record<string, unknown> = {
    ...metadata,
    [INSTANCE_ID_KEY]: instanceId,
  };

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

    // Gather the raw facts once; the decision itself is a pure, syscall-free
    // function (instance-guard.ts) so the dangerous kill path stays gated.
    const existingPid = existing?.pid ?? 0;
    const existingPidAlive = existing ? isPidAlive(existing.pid) : false;
    const existingInstanceId =
      typeof existing?.metadata[INSTANCE_ID_KEY] === "string"
        ? (existing.metadata[INSTANCE_ID_KEY] as string)
        : undefined;

    const decisionInput: StaleDecisionInput = {
      hasExisting: existing !== null,
      existingPid,
      existingInstanceId,
      selfPid: process.pid,
      selfInstanceId: instanceId,
      existingPidAlive,
      // Only walk ancestry when the PID is actually alive and not us — the walk
      // is the costly probe and is only consulted for live, foreign PIDs.
      existingPidIsAncestor:
        existingPidAlive && existingPid !== process.pid
          ? isAncestorOf(existingPid, process.pid)
          : false,
      inContainer: detectInContainer(),
    };

    const decision = decideStaleAction(decisionInput);

    if (decision.action === "skip" || decision.action === "takeover") {
      log.info("Single-instance reconcile: no kill", {
        process: name,
        action: decision.action,
        reason: decision.reason,
        stalePid: existingPid,
        currentPid: process.pid,
      });
      return;
    }

    // decision.action === "kill" — positively a different, live instance on a host.
    log.info("Killing stale process", {
      process: name,
      stalePid: existingPid,
      currentPid: process.pid,
      reason: decision.reason,
    });

    try {
      process.kill(existingPid, "SIGTERM");
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        if (!isPidAlive(existingPid)) {
          log.info("Stale process exited after SIGTERM", { pid: existingPid });
          return;
        }
      }
      log.warn("Stale process did not exit, sending SIGKILL", {
        pid: existingPid,
      });
      process.kill(existingPid, "SIGKILL");
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
      await registerProcess(name, registryMetadata);
      log.info("Process registered", {
        process: name,
        pid: process.pid,
        instanceId,
      });

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
