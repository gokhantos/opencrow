type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";
let processName: string = "unknown";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function setProcessName(name: string): void {
  processName = name;
}

export function getProcessName(): string {
  return processName;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function serializeData(data: unknown): string {
  // Handle Error passed directly as data (top-level)
  if (data instanceof Error) {
    return JSON.stringify({
      message: data.message,
      name: data.name,
      stack: data.stack,
    });
  }
  // Handle non-Error thrown values (e.g. fetch rejections, plain objects)
  if (data !== null && typeof data === "object") {
    const serialized = JSON.stringify(data, (_key, value) => {
      if (value instanceof Error) {
        return {
          message: value.message,
          name: value.name,
          stack: value.stack,
        };
      }
      return value;
    });
    // If the object serialized to "{}", try to extract something useful
    if (serialized === "{}") {
      const str = String(data);
      return str === "[object Object]" ? "{}" : JSON.stringify(str);
    }
    return serialized;
  }
  return JSON.stringify(data);
}

function formatMessage(
  level: LogLevel,
  context: string,
  message: string,
  data?: unknown,
): string {
  const timestamp = formatTimestamp();
  const prefix = `${timestamp} [${level.toUpperCase()}] [${context}]`;
  if (data !== undefined) {
    return `${prefix} ${message} ${serializeData(data)}`;
  }
  return `${prefix} ${message}`;
}

export interface LogEntry {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly context: string;
  readonly message: string;
  readonly data?: unknown;
}

export interface StoredLogEntry extends LogEntry {
  readonly processName: string;
}

const RING_BUFFER_SIZE = 200;
const ringBuffer: LogEntry[] = [];

// Track consecutive flush failures for alerting
let consecutiveFlushFailures = 0;
const MAX_CONSECUTIVE_FAILURES_BEFORE_ALERT = 5;
let lastFailureAlertTime = 0;
const FAILURE_ALERT_COOLDOWN_MS = 60_000; // 1 minute

function addToRingBuffer(entry: LogEntry): void {
  if (ringBuffer.length >= RING_BUFFER_SIZE) {
    ringBuffer.shift();
  }
  ringBuffer.push(entry);
}

export function getRecentLogs(limit: number = 100): readonly LogEntry[] {
  const start = Math.max(0, ringBuffer.length - limit);
  return ringBuffer.slice(start);
}

export function getLogPersistenceStatus(): {
  readonly isConnected: boolean;
  readonly consecutiveFailures: number;
  readonly pendingBatchSize: number;
  readonly isHealthy: boolean;
} {
  return {
    isConnected: dbRef !== null,
    consecutiveFailures: consecutiveFlushFailures,
    pendingBatchSize: pendingBatch.length,
    isHealthy: dbRef !== null && consecutiveFlushFailures < MAX_CONSECUTIVE_FAILURES_BEFORE_ALERT,
  };
}

// --- PostgreSQL persistence (batched writes) ---

interface PendingLog {
  readonly processName: string;
  readonly level: string;
  readonly context: string;
  readonly message: string;
  readonly dataJson: string | null;
  readonly createdAt: number;
}

let dbRef: { unsafe: (sql: string, params?: unknown[]) => Promise<unknown> } | null = null;
const pendingBatch: PendingLog[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

const FLUSH_INTERVAL_MS = 2_000;
const CLEANUP_INTERVAL_MS = 300_000; // 5 min
const LOG_RETENTION_SECONDS = 86_400; // 24h
const MAX_BATCH_SIZE = 200;

function addToPendingBatch(entry: LogEntry): void {
  const dataJson =
    entry.data !== undefined ? serializeData(entry.data) : null;
  const createdAt = Math.floor(Date.now() / 1000);
  pendingBatch.push({
    processName,
    level: entry.level,
    context: entry.context,
    message: entry.message,
    dataJson,
    createdAt,
  });
  // Prevent unbounded growth if flush is slow
  if (pendingBatch.length > MAX_BATCH_SIZE * 3) {
    pendingBatch.splice(0, pendingBatch.length - MAX_BATCH_SIZE);
  }
}

async function flushLogs(): Promise<void> {
  if (!dbRef || pendingBatch.length === 0) return;

  const batch = pendingBatch.splice(0, MAX_BATCH_SIZE);
  const values: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  for (const log of batch) {
    values.push(
      `($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5})`,
    );
    params.push(
      log.processName,
      log.level,
      log.context,
      log.message,
      log.dataJson,
      log.createdAt,
    );
    idx += 6;
  }

  try {
    await dbRef.unsafe(
      `INSERT INTO process_logs (process_name, level, context, message, data_json, created_at)
       VALUES ${values.join(", ")}`,
      params,
    );
    consecutiveFlushFailures = 0; // Reset on success
  } catch (err) {
    consecutiveFlushFailures++;

    // Always log to stderr - this is critical visibility
    const errorMsg = `[LOGGER] Database flush failed: ${err instanceof Error ? err.message : String(err)}`;
    process.stderr.write(`${new Date().toISOString()} [error] [logger] ${errorMsg}\n`);

    // Alert if failures exceed threshold and cooldown has passed
    const now = Date.now();
    if (consecutiveFlushFailures >= MAX_CONSECUTIVE_FAILURES_BEFORE_ALERT &&
        now - lastFailureAlertTime > FAILURE_ALERT_COOLDOWN_MS) {
      const criticalMsg = `[LOGGER] CRITICAL: ${consecutiveFlushFailures} consecutive database flush failures. Logs are NOT being persisted. Check database connection.`;
      process.stderr.write(`${new Date().toISOString()} [error] [logger] ${criticalMsg}\n`);
      lastFailureAlertTime = now;
    }

    // Re-queue the batch at the front of pendingBatch for retry
    pendingBatch.unshift(...batch);
    // Prevent unbounded growth on repeated failures
    if (pendingBatch.length > MAX_BATCH_SIZE * 3) {
      pendingBatch.splice(MAX_BATCH_SIZE * 2);
    }
  }
}

async function cleanupOldLogs(): Promise<void> {
  if (!dbRef) return;
  const cutoff = Math.floor(Date.now() / 1000) - LOG_RETENTION_SECONDS;
  try {
    await dbRef.unsafe(
      `DELETE FROM process_logs WHERE created_at < $1`,
      [cutoff],
    );
  } catch (err) {
    // Log cleanup failures to stderr - non-fatal but should be visible
    process.stderr.write(`${new Date().toISOString()} [warn] [logger] Cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/**
 * Start persisting logs to PostgreSQL. Call after initDb().
 * Pass the db instance (Bun.sql) which has an .unsafe() method.
 */
export function startLogPersistence(
  db: { unsafe: (sql: string, params?: unknown[]) => Promise<unknown> },
): void {
  if (flushTimer) return; // Already started
  dbRef = db;
  flushTimer = setInterval(() => {
    flushLogs().catch((err) => {
      // This should never happen since flushLogs catches errors, but guard anyway
      process.stderr.write(`${new Date().toISOString()} [error] [logger] Unexpected flush error: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  }, FLUSH_INTERVAL_MS);
  cleanupTimer = setInterval(() => {
    cleanupOldLogs().catch((err) => {
      process.stderr.write(`${new Date().toISOString()} [error] [logger] Unexpected cleanup error: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  }, CLEANUP_INTERVAL_MS);
}

export function stopLogPersistence(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  // Final flush attempt with error logging
  flushLogs().catch((err) => {
    process.stderr.write(`${new Date().toISOString()} [error] [logger] Final flush failed: ${err instanceof Error ? err.message : String(err)}\n`);
  });
  dbRef = null;
}

// --- Logger factory ---

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export function createLogger(context: string): Logger {
  return {
    debug(message: string, data?: unknown) {
      if (shouldLog("debug")) {
        const timestamp = formatTimestamp();
        const entry: LogEntry = { timestamp, level: "debug", context, message, data };
        addToRingBuffer(entry);
        addToPendingBatch(entry);
        process.stderr.write(
          formatMessage("debug", context, message, data) + "\n",
        );
      }
    },
    info(message: string, data?: unknown) {
      if (shouldLog("info")) {
        const timestamp = formatTimestamp();
        const entry: LogEntry = { timestamp, level: "info", context, message, data };
        addToRingBuffer(entry);
        addToPendingBatch(entry);
        process.stderr.write(
          formatMessage("info", context, message, data) + "\n",
        );
      }
    },
    warn(message: string, data?: unknown) {
      if (shouldLog("warn")) {
        const timestamp = formatTimestamp();
        const entry: LogEntry = { timestamp, level: "warn", context, message, data };
        addToRingBuffer(entry);
        addToPendingBatch(entry);
        process.stderr.write(
          formatMessage("warn", context, message, data) + "\n",
        );
      }
    },
    error(message: string, data?: unknown) {
      if (shouldLog("error")) {
        const timestamp = formatTimestamp();
        const entry: LogEntry = { timestamp, level: "error", context, message, data };
        addToRingBuffer(entry);
        addToPendingBatch(entry);
        process.stderr.write(
          formatMessage("error", context, message, data) + "\n",
        );
      }
    },
  };
}
