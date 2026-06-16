import { createLaunchdService } from "./launchd.ts";
import { createSystemdService } from "./systemd.ts";
import type { OpenCrowService, ServiceName } from "./types.ts";

interface ServiceDef {
  readonly systemdUnit: string;
  readonly systemdDesc: string;
  readonly launchdLabel: string;
  readonly logPrefix: string;
  readonly after?: readonly string[];
  readonly requires?: readonly string[];
  readonly restartSec?: number;
}

const SERVICE_DEFS: Record<ServiceName, ServiceDef> = {
  core: {
    systemdUnit: "opencrow.service",
    systemdDesc: "OpenCrow Core (DB, agents, cron, memory, internal API)",
    launchdLabel: "ai.opencrow.app",
    logPrefix: "opencrow",
  },
  web: {
    systemdUnit: "opencrow-web.service",
    systemdDesc: "OpenCrow Web UI",
    launchdLabel: "ai.opencrow.web",
    logPrefix: "opencrow-web",
    after: ["opencrow.service"],
    restartSec: 3,
  },
  telegram: {
    systemdUnit: "opencrow-telegram.service",
    systemdDesc: "OpenCrow Telegram Bot",
    launchdLabel: "ai.opencrow.telegram",
    logPrefix: "opencrow-telegram",
    after: ["opencrow.service"],
    restartSec: 3,
  },
  whatsapp: {
    systemdUnit: "opencrow-whatsapp.service",
    systemdDesc: "OpenCrow WhatsApp Channel",
    launchdLabel: "ai.opencrow.whatsapp",
    logPrefix: "opencrow-whatsapp",
    after: ["opencrow.service"],
    restartSec: 3,
  },
  scrapers: {
    systemdUnit: "opencrow-scrapers.service",
    systemdDesc: "OpenCrow Scrapers",
    launchdLabel: "ai.opencrow.scrapers",
    logPrefix: "opencrow-scrapers",
    after: ["opencrow.service"],
    restartSec: 5,
  },
};

export function resolveService(name: ServiceName = "core"): OpenCrowService {
  const def = SERVICE_DEFS[name];

  if (process.platform === "darwin") {
    return createLaunchdService(def.launchdLabel, def.logPrefix);
  }

  if (process.platform === "linux") {
    const systemdOpts =
      def.after || def.requires || def.restartSec
        ? {
            after: def.after,
            requires: def.requires,
            restartSec: def.restartSec,
          }
        : undefined;
    return createSystemdService(def.systemdUnit, def.systemdDesc, systemdOpts);
  }

  throw new Error(
    `Service management not supported on platform: ${process.platform}`,
  );
}

export type { OpenCrowService };
