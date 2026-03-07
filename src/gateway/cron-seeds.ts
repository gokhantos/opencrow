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
  await seedIdeaValidator({ cronStore, existingJobs, primaryTelegramUser });
  await seedSignalArchival({ cronStore, existingJobs });
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

type IdeaGenAgentId = (typeof IDEA_GEN_AGENTS)[number];

interface IdeaCronJobSpec {
  readonly name: string;
  readonly agentId: IdeaGenAgentId;
  readonly schedule: string;
  readonly mode: "research" | "ideation";
  readonly logLabel: string;
}

function buildIdeaCronJobSpecs(): IdeaCronJobSpec[] {
  return IDEA_GEN_AGENTS.flatMap((agentId) => {
    const label = agentId.replace(/-/g, " ").replace(" gen", "");
    return [
      {
        name: `${agentId}-research`,
        agentId,
        schedule: "0 0,4,8,12,16,20 * * *",
        mode: "research" as const,
        logLabel: `${label} research (every 4h)`,
      },
      {
        name: `${agentId}-ideation`,
        agentId,
        schedule: "0 6,18 * * *",
        mode: "ideation" as const,
        logLabel: `${label} ideation (9AM/9PM UTC+3)`,
      },
    ];
  });
}

async function seedIdeaGenJobs(opts: {
  cronStore: CronStore;
  config: OpenCrowConfig;
  existingJobs: Awaited<ReturnType<CronStore["listJobs"]>>;
  primaryTelegramUser: number | undefined;
  agentBotChannels: Map<string, Channel>;
}): Promise<void> {
  const { cronStore, existingJobs, primaryTelegramUser, agentBotChannels } = opts;

  // Research: every 4h (UTC: 0,4,8,12,16,20) — accumulate signals
  // Ideation: twice daily (UTC: 6,18 = 9AM/9PM UTC+3) — synthesize signals into ideas
  // Research runs 2h before ideation so fresh signals are ready

  for (const job of buildIdeaCronJobSpecs()) {
    const existing = existingJobs.find((j) => j.name === job.name);

    if (!existing) {
      const hasAgentBot = agentBotChannels.has(job.agentId);
      const delivery =
        primaryTelegramUser && hasAgentBot
          ? {
              mode: "announce" as const,
              channel: `telegram:${job.agentId}`,
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
        name: job.name,
        enabled: true,
        schedule: { kind: "cron", expr: job.schedule },
        payload: {
          kind: "agentTurn",
          agentId: job.agentId,
          mode: job.mode,
        },
        delivery,
      });
      log.info(`Registered ${job.logLabel} cron job`, {
        agentId: job.agentId,
        mode: job.mode,
        delivery: delivery.mode,
        channel:
          delivery.mode === "announce"
            ? (delivery as { channel: string }).channel
            : "none",
      });
    } else if (existing.payload.kind === "agentTurn") {
      // Sync mode and delivery channel for existing jobs
      const hasAgentBot = agentBotChannels.has(job.agentId);
      const expectedChannel = hasAgentBot ? `telegram:${job.agentId}` : "telegram";

      const needsModeUpdate = existing.payload.mode !== job.mode;
      const needsDeliveryUpdate =
        primaryTelegramUser &&
        existing.delivery.mode === "announce" &&
        existing.delivery.channel !== expectedChannel;

      if (needsModeUpdate || needsDeliveryUpdate) {
        await cronStore.updateJob(existing.id, {
          ...(needsModeUpdate && {
            payload: {
              kind: "agentTurn" as const,
              agentId: job.agentId,
              mode: job.mode,
            },
          }),
          ...(needsDeliveryUpdate && {
            delivery: {
              mode: "announce" as const,
              channel: expectedChannel,
              chatId: String(primaryTelegramUser),
            },
          }),
        });
        log.info(`Updated ${job.name} cron job`, {
          agentId: job.agentId,
          mode: job.mode,
          modeUpdated: needsModeUpdate,
          deliveryUpdated: needsDeliveryUpdate,
        });
      }
    }
  }
}

async function seedIdeaValidator(opts: {
  cronStore: CronStore;
  existingJobs: Awaited<ReturnType<CronStore["listJobs"]>>;
  primaryTelegramUser: number | undefined;
}): Promise<void> {
  const { cronStore, existingJobs, primaryTelegramUser } = opts;

  const existing = existingJobs.find((j) => j.name === "idea-validator");
  if (existing) return;

  const delivery = primaryTelegramUser
    ? {
        mode: "announce" as const,
        channel: "telegram",
        chatId: String(primaryTelegramUser),
      }
    : { mode: "none" as const };

  await cronStore.addJob({
    name: "idea-validator",
    enabled: true,
    schedule: { kind: "cron", expr: "0 10 * * *" },
    payload: {
      kind: "agentTurn",
      agentId: "idea-validator",
    },
    delivery,
  });
  log.info("Registered idea-validator cron job (10:00 UTC daily)");
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
