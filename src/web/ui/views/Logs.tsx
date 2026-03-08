import React, { useState, useEffect, useRef, useCallback } from "react";
import { useLocalStorage } from "../lib/useLocalStorage";
import { apiFetch } from "../api";
import { formatLogTimestamp } from "../lib/format";
import { cn } from "../lib/cn";
import { useDebounce } from "../lib/use-debounce";

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

function highlightJson(raw: string): React.ReactNode {
  const lines = raw.split("\n");
  return lines.map((line, i) => {
    const colored = line
      .replace(
        /("(?:[^"\\]|\\.)*")(\s*:)/g,
        '<span class="lg-json-key">$1</span>$2',
      )
      .replace(
        /:\s*("(?:[^"\\]|\\.)*")/g,
        ': <span class="lg-json-string">$1</span>',
      )
      .replace(
        /:\s*(\d+\.?\d*)/g,
        ': <span class="lg-json-number">$1</span>',
      )
      .replace(
        /:\s*(true|false|null)/g,
        ': <span class="lg-json-bool">$1</span>',
      );
    return (
      <div key={i} className="lg-data-line">
        <span className="lg-data-linenum">{i + 1}</span>
        <span dangerouslySetInnerHTML={{ __html: colored }} />
      </div>
    );
  });
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
            <span className="lg-expand-hint">{"\u25B8"} data</span>
          )}
          {hasData && isExpanded && (
            <span className="lg-expand-hint lg-collapse-hint">
              {"\u25BE"} hide
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

export default function Logs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useLocalStorage<LogLevel>("logs:level", "info");
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [isPaused, setIsPaused] = useState(false);
  const [processes, setProcesses] = useState<string[]>([]);
  const [selectedProcess, setSelectedProcess] = useLocalStorage<string>("logs:process", "");
  const [contexts, setContexts] = useState<string[]>([]);
  const [selectedContext, setSelectedContext] = useLocalStorage<string>("logs:context", "");
  const [newLogCount, setNewLogCount] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const prevLogCount = useRef(0);

  const debouncedSearch = useDebounce(search, 400);

  useEffect(() => {
    fetchProcesses();
  }, []);

  useEffect(() => {
    setSelectedContext("");
    fetchContexts(selectedProcess);
  }, [selectedProcess]);

  useEffect(() => {
    fetchLogs().finally(() => setLoading(false));
    const interval = setInterval(() => {
      if (!isPaused) fetchLogs();
    }, 3000);
    return () => clearInterval(interval);
  }, [isPaused, selectedProcess, selectedContext, debouncedSearch]);

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

  async function fetchLogs() {
    try {
      const params = new URLSearchParams({ limit: "500" });
      if (selectedProcess) params.set("process", selectedProcess);
      if (selectedContext) params.set("context", selectedContext);
      if (debouncedSearch) params.set("search", debouncedSearch);
      const data = await apiFetch<LogsResponse>(`/api/logs?${params}`);
      if (data.success) setLogs(data.data);
    } catch {
      /* ignore */
    }
  }

  const toggleExpand = useCallback((idx: number) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
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

  const filtered = logs.filter(
    (l) => LEVEL_NUM[l.level] >= LEVEL_NUM[filter],
  );

  if (loading) {
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
          <span className="lg-count">{filtered.length} rows</span>
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
          <span className="lg-search-icon">{"\u2315"}</span>
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
              {"\u2715"}
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
      {filtered.length === 0 ? (
        <div className="lg-container">
          <div className="lg-empty">
            <div className="lg-empty-icon">{"\u2699"}</div>
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
            {filtered.map((entry, i) => (
              <LogEntryRow
                key={i}
                entry={entry}
                isExpanded={expandedRows.has(i)}
                onToggle={() => toggleExpand(i)}
              />
            ))}
          </div>

          {newLogCount > 0 && !autoScroll && (
            <button className="lg-new-logs" onClick={jumpToBottom}>
              {"\u2193"} {newLogCount} new log{newLogCount > 1 ? "s" : ""}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
