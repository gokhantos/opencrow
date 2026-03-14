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

  // Market process only if market section is present
  if (config.market !== undefined) {
    builtins.push({
      name: "market",
      entry: "src/entries/market.ts",
      restartPolicy: "always",
      maxRestarts: 10,
      restartWindowSec: 300,
    });
  }

  // SIGE process only if sige section is present and enabled
  if (config.sige !== undefined && config.sige.enabled) {
    builtins.push({
      name: "sige",
      entry: "src/entries/sige.ts",
      restartPolicy: "always",
      maxRestarts: 10,
      restartWindowSec: 300,
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

export interface ResolvedProcessSpec {
  readonly name: string;
  readonly entry: string;
  readonly env?: Record<string, string>;
  readonly restartPolicy: "always" | "on-failure" | "never";
  readonly maxRestarts: number;
  readonly restartWindowSec: number;
}
