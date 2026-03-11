import { Hono } from "hono";
import type { WebAppDeps } from "../app";
import { getAllSessions } from "../../store/sessions";
import { getProcessStatuses } from "../../process/health";
import { createLogger } from "../../logger";

const log = createLogger("web-status");
const startTime = Date.now();

interface ExternalService {
  readonly name: string;
  readonly url: string;
}

const EXTERNAL_SERVICES: readonly ExternalService[] = [
  { name: "embedding", url: "http://127.0.0.1:8901/health" },
];

async function probeExternalServices() {
  const results = await Promise.all(
    EXTERNAL_SERVICES.map(async (svc) => {
      try {
        const res = await fetch(svc.url, {
          signal: AbortSignal.timeout(3000),
        });
        const ok = res.ok;
        return {
          name: svc.name,
          pid: 0,
          status: ok ? ("alive" as const) : ("dead" as const),
          startedAt: 0,
          lastHeartbeat: ok ? Date.now() : 0,
          uptimeSeconds: 0,
          metadata: {},
          desired: true,
          syncStatus: ok ? ("synced" as const) : ("stopped" as const),
          restartCount: 0,
          backoffMs: 0,
          nextRetryAt: null,
          orchestrated: false,
        };
      } catch {
        return {
          name: svc.name,
          pid: 0,
          status: "dead" as const,
          startedAt: 0,
          lastHeartbeat: 0,
          uptimeSeconds: 0,
          metadata: {},
          desired: true,
          syncStatus: "stopped" as const,
          restartCount: 0,
          backoffMs: 0,
          nextRetryAt: null,
          orchestrated: false,
        };
      }
    }),
  );
  return results;
}

export function createStatusRoutes(deps: WebAppDeps): Hono {
  const app = new Hono();

  app.get("/status", async (c) => {
    const sessions = await getAllSessions();
    const { getSecret } = await import("../../config/secrets");
    const authEnabled = Boolean(await getSecret("OPENCROW_WEB_TOKEN"));

    let channelStatus: Record<string, { status: string; type: string }> = {};
    let cronStatus: {
      running: boolean;
      jobCount: number;
      nextDueAt: number | null;
    } | null = null;

    // If running as standalone web, fetch live status from core
    if (deps.coreClient && deps.channels.size === 0) {
      try {
        const coreStatus = await deps.coreClient.getStatus();
        channelStatus = coreStatus.channels;
        cronStatus = coreStatus.cron;
      } catch (err) {
        log.warn("Failed to fetch core status", { error: err });
      }
    } else {
      for (const [name, channel] of deps.channels.entries()) {
        channelStatus[name] = {
          status: channel.isConnected() ? "connected" : "disconnected",
          type: name === "whatsapp" ? "whatsapp" : "telegram",
        };
      }
      cronStatus = deps.cronScheduler
        ? await deps.cronScheduler.getStatus()
        : null;
    }

    return c.json({
      uptime: Math.floor((Date.now() - startTime) / 1000),
      authEnabled,
      version: "0.2.0",
      sessions: sessions.length,
      channels: channelStatus,
      agents: deps.agentRegistry.agents.length,
      cron: cronStatus
        ? {
            running: cronStatus.running,
            jobCount: cronStatus.jobCount,
            nextDueAt: cronStatus.nextDueAt,
          }
        : null,
    });
  });

  // Process health (works in both distributed and distributed modes)
  app.get("/processes", async (c) => {
    // In standalone web mode, proxy to core
    if (deps.coreClient && deps.channels.size === 0) {
      try {
        // Fetch heartbeat data and orchestrator state in parallel
        const [heartbeatResult, orchestratorResult] = await Promise.all([
          deps.coreClient.listProcesses().catch(() => ({
            data: [] as ReadonlyArray<{
              name: string;
              pid: number;
              status: string;
              startedAt: number;
              lastHeartbeat: number;
              uptimeSeconds: number;
              metadata: Record<string, unknown>;
            }>,
          })),
          deps.coreClient.getOrchestratorState().catch(() => ({ data: null })),
        ]);

        const orchestratorState = orchestratorResult.data;

        if (orchestratorState) {
          // Merge orchestrator state with heartbeat data
          const heartbeatMap = new Map(
            heartbeatResult.data.map((p) => [p.name, p]),
          );

          const merged = orchestratorState.map((orch) => {
            const hb = heartbeatMap.get(orch.name);
            return {
              name: orch.name,
              pid: orch.pid ?? hb?.pid ?? 0,
              status:
                hb?.status ?? (orch.status === "running" ? "alive" : "dead"),
              startedAt: hb?.startedAt ?? 0,
              lastHeartbeat: hb?.lastHeartbeat ?? 0,
              uptimeSeconds: orch.uptimeSeconds ?? hb?.uptimeSeconds ?? 0,
              metadata: hb?.metadata ?? {},
              desired: orch.desired,
              syncStatus: orch.syncStatus,
              restartCount: orch.restartCount,
              backoffMs: orch.backoffMs ?? 0,
              nextRetryAt: orch.nextRetryAt ?? null,
              orchestrated: true,
            };
          });

          // Include any heartbeat-only processes not in orchestrator (e.g. core itself)
          for (const hb of heartbeatResult.data) {
            if (!orchestratorState.some((o) => o.name === hb.name)) {
              merged.push({
                ...hb,
                desired: true,
                syncStatus:
                  hb.status === "alive"
                    ? ("synced" as const)
                    : ("stopped" as const),
                restartCount: 0,
                backoffMs: 0,
                nextRetryAt: null,
                orchestrated: false,
              });
            }
          }

          const external = await probeExternalServices();
          return c.json({ data: [...merged, ...external] });
        }

        const external = await probeExternalServices();
        return c.json({
          data: [...heartbeatResult.data, ...external],
        });
      } catch (err) {
        log.warn("Failed to fetch processes from core", { error: err });
        const external = await probeExternalServices();
        return c.json({ data: external });
      }
    }

    // In distributed mode, read directly from DB
    try {
      const statuses = await getProcessStatuses();
      const external = await probeExternalServices();
      return c.json({ data: [...statuses, ...external] });
    } catch (err) {
      log.warn("Failed to fetch process statuses", { error: err });
      return c.json({ data: [] });
    }
  });

  app.post("/processes/:name/restart", async (c) => {
    const name = c.req.param("name");

    if (deps.coreClient && deps.channels.size === 0) {
      try {
        const result = await deps.coreClient.restartProcess(name);
        return c.json(result);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to restart process";
        return c.json({ error: message }, 500);
      }
    }

    // In distributed mode, send command directly
    try {
      const { sendCommand } = await import("../../process/commands");
      const commandId = await sendCommand(
        name as import("../../process/types").ProcessName,
        "restart",
      );
      return c.json({ ok: true, commandId });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to send restart command";
      return c.json({ error: message }, 500);
    }
  });

  app.post("/processes/:name/stop", async (c) => {
    const name = c.req.param("name");

    if (deps.coreClient && deps.channels.size === 0) {
      try {
        const result = await deps.coreClient.stopProcess(name);
        return c.json(result);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to stop process";
        return c.json({ error: message }, 500);
      }
    }

    try {
      const { sendCommand } = await import("../../process/commands");
      const commandId = await sendCommand(
        name as import("../../process/types").ProcessName,
        "stop",
      );
      return c.json({ ok: true, commandId });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to send stop command";
      return c.json({ error: message }, 500);
    }
  });

  app.post("/processes/:name/start", async (c) => {
    const name = c.req.param("name");

    if (deps.coreClient && deps.channels.size === 0) {
      try {
        const result = await deps.coreClient.startProcess(name);
        return c.json(result);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to start process";
        return c.json({ error: message }, 500);
      }
    }

    return c.json(
      { error: "Orchestrator not available in distributed mode" },
      503,
    );
  });

  return app;
}
