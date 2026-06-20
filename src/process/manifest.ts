import type { OpenCrowConfig } from "../config/schema";
import type { ResolvedAgent } from "../agents/types";

/**
 * Builds the desired process list from config + dynamic agent/scraper discovery.
 *
 * Static processes come from config.processes.static.
 * Agent processes are dynamically discovered from agents with telegramBotToken + the default agent.
 * Scraper processes are one-per-scraper-id from config.
 */
export function resolveManifest(
  config: OpenCrowConfig,
  agents: readonly ResolvedAgent[],
): readonly ResolvedProcessSpec[] {
  const processesConfig = config.processes;
  if (!processesConfig) return [];

  const specs: ResolvedProcessSpec[] = [];

  // Static processes from config (user-defined extras)
  for (const s of processesConfig.static) {
    specs.push(s);
  }

  // Built-in infrastructure processes (always spawned)
  const builtins: ResolvedProcessSpec[] = [
    {
      name: "cron",
      entry: "src/entries/cron.ts",
      restartPolicy: "always",
      maxRestarts: 10,
      restartWindowSec: 300,
    },
    {
      name: "web",
      entry: "src/web-index.ts",
      restartPolicy: "always",
      maxRestarts: 10,
      restartWindowSec: 300,
    },
  ];

  // SIGE idea-generation ENGINE — only when the sige section is present and
  // enabled. This is the expensive, now manual-only path: manual sessions are
  // executed by this process's poll loop, and the autonomous idea scheduler is
  // gated separately by smart.sigeAuto.enabled (default OFF).
  if (config.sige !== undefined && config.sige.enabled) {
    builtins.push({
      name: "sige",
      entry: "src/entries/sige.ts",
      restartPolicy: "always",
      maxRestarts: 10,
      restartWindowSec: 300,
      // sige is a heavy LLM workload: Round 1 runs ~10 concurrent agents streaming
      // simultaneously plus a cancel-watcher DB poll, which intermittently saturates
      // its event loop and delays the IPC pong past any reasonable window. Its
      // genuinely-stuck LLM calls are already bounded by a per-call deadline
      // (src/agent/llm-timeout.ts), so orchestrator hung-detection adds no safety
      // and only produced false SIGKILLs that prevented any run from completing.
      // Disable IPC hung-detection for sige; crash/exit-based restart still applies.
      heartbeat: { enabled: false },
    });
  }

  // DATA INGESTION — the continuous mem0 entity/relation extraction loop that
  // keeps the shared knowledge corpus fresh. A first-class DOMAIN, fully
  // INDEPENDENT of the `sige` section: the mem0 knowledge it populates is read by
  // BOTH the generation pipeline (graph-reasoning) AND SIGE, so it runs whether or
  // not the (expensive, manual-only) SIGE idea engine is enabled — and even when
  // the `sige` section is absent entirely. It carries its own mem0 connection
  // (config.ingestion.mem0). Default ON; set config.ingestion.enabled = false to
  // stop this autonomous loop.
  if (config.ingestion?.enabled !== false) {
    builtins.push({
      name: "ingestion",
      entry: "src/entries/ingestion.ts",
      restartPolicy: "always",
      maxRestarts: 10,
      restartWindowSec: 300,
      // Like sige, ingestion is an LLM-bound workload: it drives mem0 entity/relation
      // extraction, which saturates its event loop and can delay the IPC pong past any
      // reasonable window without being genuinely hung. Disable IPC hung-detection so the
      // orchestrator never false-kills it; crash/exit-based restart still applies.
      heartbeat: { enabled: false },
    });
  }

  for (const b of builtins) {
    // Skip if already defined in static (user override)
    if (!specs.some((s) => s.name === b.name)) {
      specs.push(b);
    }
  }

  // Agent processes (present when agentProcesses section exists)
  if (processesConfig.agentProcesses !== undefined) {
    const agentEntry = processesConfig.agentProcesses.entry;
    const agentRestartPolicy = processesConfig.agentProcesses.restartPolicy;

    // Spawn a process for each agent that has a telegramBotToken, owns WhatsApp,
    // or is the default agent (which uses the shared Telegram bot token).
    for (const agent of agents) {
      const ownsWhatsApp =
        config.channels.whatsapp !== undefined &&
        config.channels.whatsapp.defaultAgent === agent.id;

      const hasSharedTelegram =
        agent.default && Boolean(config.channels.telegram.botToken);

      if (!agent.telegramBotToken && !ownsWhatsApp && !hasSharedTelegram) continue;

      specs.push({
        name: `agent:${agent.id}`,
        entry: agentEntry,
        env: { OPENCROW_AGENT_ID: agent.id },
        restartPolicy: agentRestartPolicy,
        maxRestarts: 10,
        restartWindowSec: 300,
      });
    }
  }

  // Scraper processes (present when scraperProcesses section exists)
  if (processesConfig.scraperProcesses !== undefined) {
    const scraperEntry = processesConfig.scraperProcesses.entry;
    const scraperRestartPolicy = processesConfig.scraperProcesses.restartPolicy;

    for (const scraperId of processesConfig.scraperProcesses.scraperIds) {
      specs.push({
        name: `scraper:${scraperId}`,
        entry: scraperEntry,
        env: { OPENCROW_SCRAPER_ID: scraperId },
        restartPolicy: scraperRestartPolicy,
        maxRestarts: 10,
        restartWindowSec: 300,
      });
    }
  }

  return specs;
}

/**
 * Per-process tuning of the orchestrator's IPC liveness (ping/pong) detection.
 *
 * The defaults (in child-lifecycle.ts) suit short-lived, event-loop-responsive
 * processes (web, cron, scrapers, agents). A heavy LLM workload like `sige`
 * legitimately saturates its event loop during concurrent streaming and can miss
 * the tight pong window without being hung — its genuinely-stuck calls are already
 * bounded by a per-call deadline (src/agent/llm-timeout.ts), so IPC hung-detection
 * adds no safety for it and only causes false SIGKILLs. Such a process either
 * disables hung-detection (`enabled: false`) or is given a generous budget.
 */
export interface HeartbeatSpec {
  /** When false, the orchestrator never pings this child and never hung-kills it. */
  readonly enabled?: boolean;
  /** How long to wait for a pong before counting a missed ping (ms). */
  readonly pingTimeoutMs?: number;
  /** Consecutive missed pings before the child is declared hung and SIGKILLed. */
  readonly hungStrikesMax?: number;
}

export interface ResolvedProcessSpec {
  readonly name: string;
  readonly entry: string;
  readonly env?: Record<string, string>;
  readonly restartPolicy: "always" | "on-failure" | "never";
  readonly maxRestarts: number;
  readonly restartWindowSec: number;
  readonly heartbeat?: HeartbeatSpec;
}
