import type { OpenCrowConfig } from "../config/schema";
import type { CronStore } from "../cron/store";
import type { Channel } from "../channels/types";
import { createLogger } from "../logger";

const log = createLogger("gateway:cron-seeds");

export async function seedDefaultCronJobs(opts: {
  cronStore: CronStore;
  config: OpenCrowConfig;
  agentBotChannels: Map<string, Channel>;
}): Promise<void> {
  const { cronStore, config, agentBotChannels } = opts;
  const existingJobs = await cronStore.listJobs();
  const primaryTelegramUser = config.channels.telegram.allowedUserIds[0];

  await seedDailyNewsBriefing({ cronStore, existingJobs, primaryTelegramUser });
  await seedIdeaGenJobs({ cronStore, config, existingJobs, primaryTelegramUser, agentBotChannels });
  await seedSignalArchival({ cronStore, existingJobs });
  await seedIdeaArchival({ cronStore, existingJobs });
}

async function seedDailyNewsBriefing(opts: {
  cronStore: CronStore;
  existingJobs: Awaited<ReturnType<CronStore["listJobs"]>>;
  primaryTelegramUser: number | undefined;
}): Promise<void> {
  const { cronStore, existingJobs, primaryTelegramUser } = opts;

  const hasBriefing = existingJobs.some((j) => j.name === "daily-news-briefing");
  if (hasBriefing) return;

  const delivery = primaryTelegramUser
    ? {
        mode: "announce" as const,
        channel: "telegram",
        chatId: String(primaryTelegramUser),
      }
    : { mode: "none" as const };

  await cronStore.addJob({
    name: "daily-news-briefing",
    enabled: false,
    schedule: { kind: "cron", expr: "0 8 * * *" },
    payload: {
      kind: "agentTurn",
      message:
        "Generate a comprehensive daily news briefing. Use search_news and get_calendar to gather the latest articles and economic events from the past 24 hours, then synthesize key themes, market-moving events, and notable developments into a concise briefing.",
    },
    delivery,
  });
  log.info("Registered daily-news-briefing cron job (08:00 daily)", {
    delivery: delivery.mode,
    chatId: primaryTelegramUser ?? "none",
  });
}

const IDEA_GEN_AGENTS = [
  "mobile-idea-gen",
  "crypto-idea-gen",
  "ai-idea-gen",
  "oss-idea-gen",
] as const;


async function seedIdeaGenJobs(opts: {
  cronStore: CronStore;
  config: OpenCrowConfig;
  existingJobs: Awaited<ReturnType<CronStore["listJobs"]>>;
  primaryTelegramUser: number | undefined;
  agentBotChannels: Map<string, Channel>;
}): Promise<void> {
  const { cronStore, existingJobs, primaryTelegramUser, agentBotChannels } = opts;

  // Migrate: remove old -research and -ideation jobs
  const legacySuffixes = ["-research", "-ideation"];
  for (const job of existingJobs) {
    const isLegacy = IDEA_GEN_AGENTS.some((agentId) =>
      legacySuffixes.some((suffix) => job.name === `${agentId}${suffix}`),
    );
    if (isLegacy) {
      await cronStore.removeJob(job.id);
      log.info("Removed legacy idea-gen cron job", { name: job.name, id: job.id });
    }
  }

  // Seed single pipeline job per agent (3x/day: 06:00, 14:00, 22:00 UTC)
  for (const agentId of IDEA_GEN_AGENTS) {
    const jobName = `${agentId}-pipeline`;
    const existing = existingJobs.find((j) => j.name === jobName);
    if (existing) continue;

    const hasAgentBot = agentBotChannels.has(agentId);
    const delivery =
      primaryTelegramUser && hasAgentBot
        ? {
            mode: "announce" as const,
            channel: `telegram:${agentId}`,
            chatId: String(primaryTelegramUser),
          }
        : primaryTelegramUser
          ? {
              mode: "announce" as const,
              channel: "telegram",
              chatId: String(primaryTelegramUser),
            }
          : { mode: "none" as const };

    await cronStore.addJob({
      name: jobName,
      enabled: true,
      schedule: { kind: "cron", expr: "0 6,14,22 * * *" },
      payload: {
        kind: "agentTurn",
        agentId,
        mode: "pipeline",
      },
      delivery,
    });

    const label = agentId.replace(/-/g, " ").replace(" gen", "");
    log.info(`Registered ${label} pipeline cron job (3x/day)`, {
      agentId,
      delivery: delivery.mode,
      channel: delivery.mode === "announce" ? (delivery as { channel: string }).channel : "none",
    });
  }
}

async function seedSignalArchival(opts: {
  cronStore: CronStore;
  existingJobs: Awaited<ReturnType<CronStore["listJobs"]>>;
}): Promise<void> {
  const { cronStore, existingJobs } = opts;

  const existing = existingJobs.find((j) => j.name === "signal-archival");
  if (existing) return;

  await cronStore.addJob({
    name: "signal-archival",
    enabled: true,
    schedule: { kind: "cron", expr: "0 3 * * *" },
    payload: {
      kind: "internal",
      handler: "signal-archival",
    },
    delivery: { mode: "none" },
  });
  log.info("Registered signal-archival cron job (03:00 UTC daily)");
}

async function seedIdeaArchival(opts: {
  cronStore: CronStore;
  existingJobs: Awaited<ReturnType<CronStore["listJobs"]>>;
}): Promise<void> {
  const { cronStore, existingJobs } = opts;
  const existing = existingJobs.find((j) => j.name === "idea-archival");
  if (existing) return;

  await cronStore.addJob({
    name: "idea-archival",
    enabled: true,
    schedule: { kind: "cron", expr: "0 4 * * *" },
    payload: {
      kind: "internal",
      handler: "idea-archival",
    },
    delivery: { mode: "none" },
  });
  log.info("Registered idea-archival cron job (04:00 UTC daily)");
}
