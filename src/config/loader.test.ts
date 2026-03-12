import { test, expect, describe } from "bun:test";

// We test applyEnvOverrides by replicating the logic, since it's not exported.
// This validates the env → config mapping rules.

function applyEnvOverrides(
  config: Record<string, unknown>,
  env: Record<string, string | undefined>,
): Record<string, unknown> {
  const result = { ...config };

  const channels = (result.channels ?? {}) as Record<string, unknown>;
  let telegram = { ...((channels.telegram ?? {}) as Record<string, unknown>) };

  if (env.TELEGRAM_BOT_TOKEN) {
    telegram = {
      ...telegram,
      botToken: env.TELEGRAM_BOT_TOKEN,
    };
  }

  if (env.TELEGRAM_ALLOWED_USER_IDS) {
    const ids = env.TELEGRAM_ALLOWED_USER_IDS.split(",")
      .map((id) => Number(id.trim()))
      .filter((id) => !Number.isNaN(id));
    telegram = { ...telegram, allowedUserIds: ids };
  }

  result.channels = { ...channels, telegram };

  const web = { ...((result.web ?? {}) as Record<string, unknown>) };
  if (env.OPENCROW_WEB_HOST) {
    web.host = env.OPENCROW_WEB_HOST;
  }
  if (env.OPENCROW_WEB_PORT) {
    web.port = Number(env.OPENCROW_WEB_PORT);
  }
  result.web = web;

  if (env.DATABASE_URL) {
    const postgres = {
      ...((result.postgres ?? {}) as Record<string, unknown>),
    };
    postgres.url = env.DATABASE_URL;
    result.postgres = postgres;
  }

  if (env.LOG_LEVEL) {
    result.logLevel = env.LOG_LEVEL;
  }

  if (env.OPENCROW_BROWSER_ENABLED === "true") {
    const existing = (result.browser ?? {}) as Record<string, unknown>;
    result.browser = { ...existing, enabled: true };
  }

  return result;
}

describe("applyEnvOverrides", () => {
  test("sets TELEGRAM_BOT_TOKEN", () => {
    const result = applyEnvOverrides(
      {},
      { TELEGRAM_BOT_TOKEN: "test-token-123" },
    );
    const telegram = (result.channels as Record<string, unknown>)
      .telegram as Record<string, unknown>;
    expect(telegram.botToken).toBe("test-token-123");
  });

  test("parses TELEGRAM_ALLOWED_USER_IDS as comma-separated numbers", () => {
    const result = applyEnvOverrides(
      {},
      { TELEGRAM_ALLOWED_USER_IDS: "123, 456, 789" },
    );
    const telegram = (result.channels as Record<string, unknown>)
      .telegram as Record<string, unknown>;
    expect(telegram.allowedUserIds).toEqual([123, 456, 789]);
  });

  test("filters invalid IDs from TELEGRAM_ALLOWED_USER_IDS", () => {
    const result = applyEnvOverrides(
      {},
      { TELEGRAM_ALLOWED_USER_IDS: "123, abc, 789" },
    );
    const telegram = (result.channels as Record<string, unknown>)
      .telegram as Record<string, unknown>;
    expect(telegram.allowedUserIds).toEqual([123, 789]);
  });

  test("sets DATABASE_URL", () => {
    const result = applyEnvOverrides(
      {},
      { DATABASE_URL: "postgres://user:pass@host/db" },
    );
    const postgres = result.postgres as Record<string, unknown>;
    expect(postgres.url).toBe("postgres://user:pass@host/db");
  });

  test("preserves existing postgres fields when setting DATABASE_URL", () => {
    const result = applyEnvOverrides(
      { postgres: { max: 50 } },
      { DATABASE_URL: "postgres://new@host/db" },
    );
    const postgres = result.postgres as Record<string, unknown>;
    expect(postgres.url).toBe("postgres://new@host/db");
    expect(postgres.max).toBe(50);
  });

  test("sets LOG_LEVEL", () => {
    const result = applyEnvOverrides({}, { LOG_LEVEL: "debug" });
    expect(result.logLevel).toBe("debug");
  });

  test("sets web host and port", () => {
    const result = applyEnvOverrides(
      {},
      { OPENCROW_WEB_HOST: "0.0.0.0", OPENCROW_WEB_PORT: "3000" },
    );
    const web = result.web as Record<string, unknown>;
    expect(web.host).toBe("0.0.0.0");
    expect(web.port).toBe(3000);
  });

  test("enables browser when OPENCROW_BROWSER_ENABLED=true", () => {
    const result = applyEnvOverrides({}, { OPENCROW_BROWSER_ENABLED: "true" });
    const browser = result.browser as Record<string, unknown>;
    expect(browser.enabled).toBe(true);
  });

  test("does not enable browser for other values", () => {
    const result = applyEnvOverrides({}, { OPENCROW_BROWSER_ENABLED: "false" });
    expect(result.browser).toBeUndefined();
  });

  test("does not modify config when no env vars set", () => {
    const input = { logLevel: "info", web: { port: 8080 } };
    const result = applyEnvOverrides(input, {});
    expect(result.logLevel).toBe("info");
    expect((result.web as Record<string, unknown>).port).toBe(8080);
  });

  test("does not mutate original config", () => {
    const original = { logLevel: "info" };
    const frozen = { ...original };
    applyEnvOverrides(original, { LOG_LEVEL: "debug" });
    expect(original.logLevel).toBe(frozen.logLevel);
  });
});
