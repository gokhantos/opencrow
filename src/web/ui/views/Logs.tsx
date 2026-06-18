import React, { useState, useEffect, useRef, useCallback } from "react";
import { useLocalStorage } from "../lib/useLocalStorage";
import { apiFetch } from "../api";
import { formatLogTimestamp } from "../lib/format";
import { cn } from "../lib/cn";
import { useDebounce } from "../lib/use-debounce";
import { usePolledFetch } from "../hooks/usePolledFetch";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  context: string;
  message: string;
  processName?: string;
  data?: unknown;
}

interface LogsResponse {
  success: boolean;
  data: LogEntry[];
}

interface ProcessesResponse {
  success: boolean;
  data: string[];
}

interface ContextsResponse {
  success: boolean;
  data: string[];
}

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
const LEVEL_NUM: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

type JsonTokenType = "key" | "string" | "number" | "bool" | "plain";
interface JsonToken { type: JsonTokenType; text: string }

/** Tokenizes a single JSON line into typed segments (no HTML injection). */
function tokenizeLine(line: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  // Priority-ordered regex: key (quoted+colon), string value, bool/null value, number value
  const re = /("(?:[^"\\]|\\.)*")(\s*:)|(:[ \t]*)("(?:[^"\\]|\\.)*")|(:[ \t]*)(true|false|null\b)|(:[ \t]*)(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(line)) !== null) {
    if (m.index > lastIndex) {
      tokens.push({ type: "plain", text: line.slice(lastIndex, m.index) });
    }
    if (m[1] !== undefined && m[2] !== undefined) {
      tokens.push({ type: "key", text: m[1] });
      tokens.push({ type: "plain", text: m[2] });
    } else if (m[3] !== undefined && m[4] !== undefined) {
      tokens.push({ type: "plain", text: m[3] });
      tokens.push({ type: "string", text: m[4] });
    } else if (m[5] !== undefined && m[6] !== undefined) {
      tokens.push({ type: "plain", text: m[5] });
      tokens.push({ type: "bool", text: m[6] });
    } else if (m[7] !== undefined && m[8] !== undefined) {
      tokens.push({ type: "plain", text: m[7] });
      tokens.push({ type: "number", text: m[8] });
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < line.length) {
    tokens.push({ type: "plain", text: line.slice(lastIndex) });
  }
  return tokens;
}

const JSON_TOKEN_CLASS: Record<JsonTokenType, string | null> = {
  key: "lg-json-key",
  string: "lg-json-string",
  number: "lg-json-number",
  bool: "lg-json-bool",
  plain: null,
};

function highlightJson(raw: string): React.ReactNode {
  return raw.split("\n").map((line, i) => (
    <div key={i} className="lg-data-line">
      <span className="lg-data-linenum">{i + 1}</span>
      <span>
        {tokenizeLine(line).map((tok, j) => {
          const cls = JSON_TOKEN_CLASS[tok.type];
          return cls ? (
            <span key={j} className={cls}>{tok.text}</span>
          ) : (
            tok.text
          );
        })}
      </span>
    </div>
  ));
}

function LogEntryRow({
  entry,
  isExpanded,
  onToggle,
}: {
  entry: LogEntry;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const hasData = entry.data !== undefined && entry.data !== null;
  const dataStr =
    hasData && typeof entry.data === "string"
      ? entry.data
      : hasData
        ? JSON.stringify(entry.data, null, 2)
        : "";

  return (
    <div
      className={cn("lg-entry", entry.level, hasData && "clickable")}
      onClick={hasData ? onToggle : undefined}
      {...(hasData
        ? {
            role: "button",
            tabIndex: 0,
            "aria-expanded": isExpanded,
            onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onToggle();
              }
            },
          }
        : {})}
    >
      <span className="lg-time">{formatLogTimestamp(entry.timestamp)}</span>

      <span className={cn("lg-level-badge", entry.level)}>
        {entry.level.toUpperCase()}
      </span>

      <div className="lg-message-area">
        {(entry.processName || entry.context) && (
          <div className="lg-message-meta">
            {entry.processName && (
              <span className="lg-tag lg-tag-process">
                {entry.processName}
              </span>
            )}
            {entry.context && (
              <span className="lg-tag lg-tag-context">{entry.context}</span>
            )}
          </div>
        )}
        <span className="lg-message-text">
          {entry.message}
          {hasData && !isExpanded && (
            <span className="lg-expand-hint">{"▸"} data</span>
          )}
          {hasData && isExpanded && (
            <span className="lg-expand-hint lg-collapse-hint">
              {"▾"} hide
            </span>
          )}
        </span>
      </div>

      {hasData && isExpanded && (
        <div className="lg-data">
          <pre>{highlightJson(dataStr)}</pre>
        </div>
      )}
    </div>
  );
}

const selectClass =
  "px-3 py-2 bg-bg-1 border border-border-2 rounded-lg text-foreground text-xs font-mono outline-none transition-colors duration-150 focus:border-accent cursor-pointer min-w-0";

/**
 * Derive a stable string id for a log entry so React keys and expanded-row
 * state are tied to the entry itself rather than its positional index.
 * An occurrence counter suffix is appended to handle true duplicates within
 * the same batch.
 */
function buildLogId(entry: LogEntry, occurrenceIdx: number): string {
  return `${entry.timestamp}|${entry.context}|${entry.processName ?? ""}|${entry.message}|${occurrenceIdx}`;
}

export default function Logs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useLocalStorage<LogLevel>("logs:level", "info");
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(new Set());
  const [isPaused, setIsPaused] = useState(false);
  const [processes, setProcesses] = useState<string[]>([]);
  const [selectedProcess, setSelectedProcess] = useLocalStorage<string>("logs:process", "");
  const [contexts, setContexts] = useState<string[]>([]);
  // selectedContext is tracked in a ref so it can be read synchronously in
  // the process-change handler before React flushes the state update.
  const [selectedContext, setSelectedContextState] = useLocalStorage<string>("logs:context", "");
  const selectedContextRef = useRef(selectedContext);
  const [newLogCount, setNewLogCount] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const prevLogCount = useRef(0);

  const debouncedSearch = useDebounce(search, 400);

  function setSelectedContext(value: string) {
    selectedContextRef.current = value;
    setSelectedContextState(value);
  }

  // Build the polling URL from current filters so usePolledFetch re-fetches
  // whenever any filter changes (path dependency triggers the hook).
  const logsParams = new URLSearchParams({ limit: "500" });
  if (selectedProcess) logsParams.set("process", selectedProcess);
  if (selectedContext) logsParams.set("context", selectedContext);
  if (debouncedSearch) logsParams.set("search", debouncedSearch);
  const logsPath = `/api/logs?${logsParams}`;

  const { data: logsData, loading } = usePolledFetch<LogsResponse>(logsPath, {
    intervalMs: 3000,
    enabled: !isPaused,
  });

  // Drive local logs state from the hook result so autoscroll/newLogCount
  // effects keep working unchanged.
  useEffect(() => {
    if (logsData?.success) setLogs(logsData.data);
  }, [logsData]);

  useEffect(() => {
    fetchProcesses();
  }, []);

  // When selectedProcess changes: reset context to "" first (synchronously via
  // ref so the next fetch uses the correct value), then load new contexts.
  useEffect(() => {
    setSelectedContext("");
    fetchContexts(selectedProcess);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProcess]);

  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
      setNewLogCount(0);
    }
  }, [logs, autoScroll]);

  useEffect(() => {
    if (!autoScroll && logs.length > prevLogCount.current) {
      setNewLogCount((c) => c + (logs.length - prevLogCount.current));
    }
    prevLogCount.current = logs.length;
  }, [logs, autoScroll]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (
        e.key === "/" &&
        !e.metaKey &&
        !e.ctrlKey &&
        document.activeElement?.tagName !== "INPUT" &&
        document.activeElement?.tagName !== "SELECT"
      ) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  async function fetchProcesses() {
    try {
      const data = await apiFetch<ProcessesResponse>("/api/logs/processes");
      if (data.success) setProcesses(data.data);
    } catch {
      /* ignore */
    }
  }

  async function fetchContexts(process: string) {
    try {
      const params = new URLSearchParams();
      if (process) params.set("process", process);
      const data = await apiFetch<ContextsResponse>(
        `/api/logs/contexts?${params}`,
      );
      if (data.success) setContexts(data.data);
    } catch {
      /* ignore */
    }
  }

  // Build stable ids for the current log batch, counting occurrences so
  // duplicate entries still get unique keys.
  const logsWithIds = (() => {
    const seen = new Map<string, number>();
    return logs.map((entry) => {
      const base = `${entry.timestamp}|${entry.context}|${entry.processName ?? ""}|${entry.message}`;
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return { entry, id: buildLogId(entry, count) };
    });
  })();

  const toggleExpand = useCallback((id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  function jumpToBottom() {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    setAutoScroll(true);
    setNewLogCount(0);
  }

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (!atBottom && autoScroll) {
      setAutoScroll(false);
    } else if (atBottom && !autoScroll) {
      setAutoScroll(true);
      setNewLogCount(0);
    }
  }

  const counts: Record<LogLevel, number> = {
    debug: 0,
    info: 0,
    warn: 0,
    error: 0,
  };
  for (const l of logs) counts[l.level]++;

  const filteredWithIds = logsWithIds.filter(
    ({ entry }) => LEVEL_NUM[entry.level] >= LEVEL_NUM[filter],
  );

  if (loading && logs.length === 0) {
    return (
      <div className="lg-page">
        <div className="lg-loading">
          <div
            className="w-8 h-8 border-2 border-border-2 border-t-accent rounded-full"
            style={{ animation: "spinSlow 1s linear infinite" }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="lg-page">
      {/* Compact header */}
      <div className="lg-header">
        <div className="lg-header-left">
          <h1 className="lg-title">Logs</h1>
        </div>
        <div className="flex items-center gap-2">
          <span className="lg-count">{filteredWithIds.length} rows</span>
          <button
            className={cn("lg-live-badge", isPaused ? "paused" : "live")}
            onClick={() => setIsPaused((p) => !p)}
          >
            <span className="lg-live-dot" />
            {isPaused ? "Paused" : "Live"}
          </button>
        </div>
      </div>

      {/* Level pills — compact inline row */}
      <div className="lg-levels">
        {LEVELS.map((lv) => (
          <button
            key={lv}
            className={cn("lg-level-pill", lv, filter === lv && "active")}
            onClick={() => setFilter(lv)}
          >
            <span className="lg-level-pill-dot" />
            {lv.charAt(0).toUpperCase() + lv.slice(1)}
            <span className="lg-level-pill-count">{counts[lv]}</span>
          </button>
        ))}
      </div>

      {/* Toolbar: search + dropdowns on one row */}
      <div className="lg-toolbar">
        <div
          className={cn("lg-search", debouncedSearch && "lg-search-active")}
        >
          <span className="lg-search-icon">{"⌕"}</span>
          <input
            ref={searchRef}
            type="text"
            placeholder="Search...  /"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              className="lg-search-clear"
              onClick={() => setSearch("")}
            >
              {"✕"}
            </button>
          )}
        </div>

        {processes.length > 1 && (
          <select
            className={selectClass}
            value={selectedProcess}
            onChange={(e) => setSelectedProcess(e.target.value)}
          >
            <option value="">All processes</option>
            {processes.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}

        {contexts.length > 0 && (
          <select
            className={selectClass}
            value={selectedContext}
            onChange={(e) => setSelectedContext(e.target.value)}
          >
            <option value="">All contexts</option>
            {contexts.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}

        <label className="lg-scroll-toggle">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => {
              setAutoScroll(e.target.checked);
              if (e.target.checked) setNewLogCount(0);
            }}
          />
          Auto-scroll
        </label>
      </div>

      {/* Log entries */}
      {filteredWithIds.length === 0 ? (
        <div className="lg-container">
          <div className="lg-empty">
            <div className="lg-empty-icon">{"⚙"}</div>
            <div className="lg-empty-text">
              {debouncedSearch
                ? `No logs matching "${debouncedSearch}"`
                : "No log entries at this level"}
            </div>
          </div>
        </div>
      ) : (
        <div className="lg-container">
          <div className="lg-col-header">
            <span>Time</span>
            <span>Level</span>
            <span>Message</span>
          </div>
          <div
            className="lg-scroll-area"
            ref={listRef}
            onScroll={handleScroll}
          >
            {filteredWithIds.map(({ entry, id }) => (
              <LogEntryRow
                key={id}
                entry={entry}
                isExpanded={expandedRows.has(id)}
                onToggle={() => toggleExpand(id)}
              />
            ))}
          </div>

          {newLogCount > 0 && !autoScroll && (
            <button className="lg-new-logs" onClick={jumpToBottom}>
              {"↓"} {newLogCount} new log{newLogCount > 1 ? "s" : ""}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
