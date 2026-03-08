import { Sender } from "@questdb/nodejs-client";
import type { Logger as QDBLogger } from "@questdb/nodejs-client";
import { createLogger } from "../../logger";

const log = createLogger("market:questdb");

/** Only forward errors/warnings from the QuestDB client; suppress info/debug chatter */
const quietLogger: QDBLogger = (level, message) => {
  if (level === "error") log.error(String(message));
  else if (level === "warn") log.warn(String(message));
};

interface QuestDBClient {
  readonly sender: Sender;
  readonly query: <T>(sql: string) => Promise<readonly T[]>;
}

let client: QuestDBClient | null = null;

export function getQuestDB(): QuestDBClient {
  if (!client) {
    throw new Error("QuestDB not initialized. Call initQuestDB() first.");
  }
  return client;
}

/** Create an independent ILP sender for concurrent use (caller must close it) */
export async function createSender(): Promise<Sender> {
  if (!client) {
    throw new Error("QuestDB not initialized. Call initQuestDB() first.");
  }
  const ilp = process.env.QUESTDB_ILP_URL ?? "tcp::addr=127.0.0.1:9009";
  const sender = await Sender.fromConfig(ilp, { log: quietLogger });
  await sender.connect();
  return sender;
}

interface QuestDBExecResponse {
  readonly columns: readonly { name: string; type: string }[];
  readonly count: number;
  readonly dataset: readonly (readonly unknown[])[];
  readonly ddl?: string;
}

async function questQuery<T>(
  httpUrl: string,
  sql: string,
): Promise<readonly T[]> {
  const url = `${httpUrl}/exec?query=${encodeURIComponent(sql)}&count=true`;
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`QuestDB query failed (${response.status}): ${text}`);
  }

  const result = (await response.json()) as QuestDBExecResponse;

  if (!result.dataset || result.dataset.length === 0) {
    return [];
  }

  const columns = result.columns;
  return result.dataset.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i]!.name] = row[i];
    }
    return obj as T;
  });
}

async function questExec(httpUrl: string, sql: string): Promise<void> {
  const url = `${httpUrl}/exec?query=${encodeURIComponent(sql)}`;
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`QuestDB exec failed (${response.status}): ${text}`);
  }
}

export async function initQuestDB(
  ilpUrl?: string,
  httpUrl?: string,
): Promise<QuestDBClient> {
  if (client) return client;

  const ilp =
    ilpUrl ?? process.env.QUESTDB_ILP_URL ?? "tcp::addr=127.0.0.1:9009";
  const http =
    httpUrl ?? process.env.QUESTDB_HTTP_URL ?? "http://127.0.0.1:9000";

  const sender = await Sender.fromConfig(ilp, { log: quietLogger });
  await sender.connect();
  log.info("QuestDB ILP sender connected", { ilp });

  // Verify REST API connectivity
  try {
    await questQuery(http, "SELECT 1");
    log.info("QuestDB REST API connected", { http });
  } catch (err) {
    await sender.close();
    throw new Error(
      `QuestDB REST API unreachable at ${http}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  await runMigrations(http);
  log.info("QuestDB schema initialized");

  const instance: QuestDBClient = {
    sender,
    query: <T>(sql: string) => questQuery<T>(http, sql),
  };
  client = instance;

  return instance;
}

/**
 * Read-only QuestDB init: sets up only the HTTP query interface (no ILP sender).
 * Used by processes that need to query market data but don't write to QuestDB.
 * Non-fatal: returns false if QuestDB is unreachable.
 */
export async function initQuestDBReadOnly(httpUrl?: string): Promise<boolean> {
  if (client) return true;

  const http =
    httpUrl ?? process.env.QUESTDB_HTTP_URL ?? "http://127.0.0.1:9000";

  try {
    await questQuery(http, "SELECT 1");
  } catch (err) {
    log.warn(
      "QuestDB REST API unreachable — market query tools will be unavailable",
      {
        url: http,
        error: err,
      },
    );
    return false;
  }

  // Stub sender that throws on write attempts
  const stubSender = {
    close: async () => {},
  } as unknown as Sender;

  const instance: QuestDBClient = {
    sender: stubSender,
    query: <T>(sql: string) => questQuery<T>(http, sql),
  };
  client = instance;
  log.info("QuestDB read-only query client initialized", { http });

  return true;
}

export async function closeQuestDB(): Promise<void> {
  if (client) {
    await client.sender.close();
    client = null;
    log.info("QuestDB connection closed");
  }
}

async function runMigrations(httpUrl: string): Promise<void> {
  // One-time migration: drop backfill_progress if it has the old broken dedup key
  // (old key included updated_at, causing duplicate spam)
  await migrateBackfillProgress(httpUrl);

  for (let i = 0; i < MIGRATIONS.length; i++) {
    const migration = MIGRATIONS[i]!;
    try {
      await questExec(httpUrl, migration);
    } catch (err) {
      const name =
        migration.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i)?.[1] ??
        `migration[${i}]`;
      log.error("QuestDB migration failed", {
        migration: name,
        index: i,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

async function migrateBackfillProgress(httpUrl: string): Promise<void> {
  try {
    // Drop old table if it has dedup keys (which caused duplicate spam).
    // New schema has no dedup — rows accumulate, queried via ORDER BY DESC LIMIT 1.
    const result = await questQuery<{ dedupKeyCount: number }>(
      httpUrl,
      `SELECT count() AS dedupKeyCount FROM table_columns('backfill_progress') WHERE upsertKey = true`,
    );
    if (result.length > 0 && result[0]!.dedupKeyCount > 0) {
      log.info("Dropping backfill_progress with old dedup keys");
      await questExec(httpUrl, "DROP TABLE IF EXISTS backfill_progress");
    }
  } catch {
    // Table doesn't exist or metadata query not supported — safe to proceed
  }
}

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS klines (
    open_time TIMESTAMP,
    symbol SYMBOL,
    market_type SYMBOL,
    timeframe SYMBOL,
    open DOUBLE,
    high DOUBLE,
    low DOUBLE,
    close DOUBLE,
    volume DOUBLE,
    close_time TIMESTAMP,
    quote_volume DOUBLE,
    trades INT
  ) TIMESTAMP(open_time) PARTITION BY MONTH
  DEDUP UPSERT KEYS(symbol, market_type, timeframe, open_time)`,

  `CREATE TABLE IF NOT EXISTS futures_metrics (
    create_time TIMESTAMP,
    symbol SYMBOL,
    sum_open_interest DOUBLE,
    sum_open_interest_value DOUBLE,
    count_toptrader_long_short_ratio DOUBLE,
    sum_toptrader_long_short_ratio DOUBLE,
    count_long_short_ratio DOUBLE,
    sum_taker_long_short_vol_ratio DOUBLE
  ) TIMESTAMP(create_time) PARTITION BY MONTH
  DEDUP UPSERT KEYS(symbol, create_time)`,

  `CREATE TABLE IF NOT EXISTS funding_rates (
    funding_time TIMESTAMP,
    symbol SYMBOL,
    funding_rate DOUBLE,
    mark_price DOUBLE
  ) TIMESTAMP(funding_time) PARTITION BY MONTH
  DEDUP UPSERT KEYS(symbol, funding_time)`,

  `CREATE TABLE IF NOT EXISTS liquidations (
    trade_time TIMESTAMP,
    symbol SYMBOL,
    side SYMBOL,
    order_type SYMBOL,
    time_in_force SYMBOL,
    quantity DOUBLE,
    price DOUBLE,
    avg_price DOUBLE,
    status SYMBOL,
    last_filled_qty DOUBLE,
    filled_accumulated_qty DOUBLE
  ) TIMESTAMP(trade_time) PARTITION BY MONTH`,

  `CREATE TABLE IF NOT EXISTS backfill_progress (
    updated_at TIMESTAMP,
    symbol SYMBOL,
    market_type SYMBOL,
    timeframe SYMBOL,
    oldest_ts TIMESTAMP,
    newest_ts TIMESTAMP,
    total LONG,
    status SYMBOL,
    error VARCHAR
  ) TIMESTAMP(updated_at) PARTITION BY YEAR`,

  `CREATE TABLE IF NOT EXISTS mark_price_klines (
    open_time TIMESTAMP,
    symbol SYMBOL,
    timeframe SYMBOL,
    mark_open DOUBLE,
    mark_high DOUBLE,
    mark_low DOUBLE,
    mark_close DOUBLE,
    index_open DOUBLE,
    index_high DOUBLE,
    index_low DOUBLE,
    index_close DOUBLE,
    close_time TIMESTAMP
  ) TIMESTAMP(open_time) PARTITION BY MONTH
  DEDUP UPSERT KEYS(symbol, timeframe, open_time)`,

  `CREATE TABLE IF NOT EXISTS taker_volume (
    ts TIMESTAMP,
    symbol SYMBOL,
    period SYMBOL,
    buy_vol DOUBLE,
    sell_vol DOUBLE,
    buy_sell_ratio DOUBLE
  ) TIMESTAMP(ts) PARTITION BY MONTH
  DEDUP UPSERT KEYS(symbol, period, ts)`,

  // --- Multi-period derivatives tables ---

  `CREATE TABLE IF NOT EXISTS open_interest_hist (
    ts TIMESTAMP,
    symbol SYMBOL,
    period SYMBOL,
    oi DOUBLE,
    oi_value DOUBLE
  ) TIMESTAMP(ts) PARTITION BY MONTH
  DEDUP UPSERT KEYS(symbol, period, ts)`,

  `CREATE TABLE IF NOT EXISTS top_trader_position_ratio (
    ts TIMESTAMP,
    symbol SYMBOL,
    period SYMBOL,
    long_short_ratio DOUBLE,
    long_account DOUBLE,
    short_account DOUBLE
  ) TIMESTAMP(ts) PARTITION BY MONTH
  DEDUP UPSERT KEYS(symbol, period, ts)`,

  `CREATE TABLE IF NOT EXISTS top_trader_account_ratio (
    ts TIMESTAMP,
    symbol SYMBOL,
    period SYMBOL,
    long_short_ratio DOUBLE,
    long_account DOUBLE,
    short_account DOUBLE
  ) TIMESTAMP(ts) PARTITION BY MONTH
  DEDUP UPSERT KEYS(symbol, period, ts)`,

  `CREATE TABLE IF NOT EXISTS global_long_short_ratio (
    ts TIMESTAMP,
    symbol SYMBOL,
    period SYMBOL,
    long_short_ratio DOUBLE,
    long_account DOUBLE,
    short_account DOUBLE
  ) TIMESTAMP(ts) PARTITION BY MONTH
  DEDUP UPSERT KEYS(symbol, period, ts)`,
];
