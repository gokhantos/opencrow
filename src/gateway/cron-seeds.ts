import type { OpenCrowConfig } from "../config/schema";
import type { CronStore } from "../cron/store";
import { createLogger } from "../logger";

const log = createLogger("gateway:cron-seeds");

export async function seedDefaultCronJobs(opts: {
  cronStore: CronStore;
  config: OpenCrowConfig;
}): Promise<void> {
  const { cronStore, config } = opts;
  const existingJobs = await cronStore.listJobs();
  const primaryTelegramUser = config.channels.telegram.allowedUserIds[0];

  await seedDailyNewsBriefing({ cronStore, existingJobs, primaryTelegramUser });
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
