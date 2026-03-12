import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { cn } from "../lib/cn";
import type { TimeFrame, MarketType } from "./market/types";
import {
  OVERLAY_INDICATORS,
  OSCILLATOR_GROUPS,
  TIMEFRAME_HOURS,
  SYMBOLS,
  TIMEFRAMES,
} from "./market/types";
import MarketHeader from "./market/MarketHeader";
import CandlestickChart from "./market/CandlestickChart";
import IndicatorToggles from "./market/IndicatorToggles";
import IndicatorMatrix from "./market/IndicatorMatrix";
import FuturesSidebar from "./market/FuturesSidebar";
import FuturesTabs from "./market/FuturesTabs";
import {
  useSummaries,
  useIndicators,
  useLatestMetrics,
  useLatestFunding,
  usePipelineStatus,
} from "./market/hooks";
import { useLiveKline } from "./market/useLiveKline";
import { useDocumentTitle } from "./market/useDocumentTitle";
import { formatPrice } from "./market/format";
import { useToast } from "../components/Toast";

interface PriceAlert {
  readonly id: string;
  readonly symbol: string;
  readonly targetPrice: number;
  readonly direction: "above" | "below";
}

function loadAlerts(): PriceAlert[] {
  try {
    return JSON.parse(localStorage.getItem("markets:alerts") ?? "[]");
  } catch {
    return [];
  }
}

function AlertPanel({
  symbol,
  currentPrice,
  alerts,
  onAdd,
  onRemove,
  onClose,
}: {
  symbol: string;
  currentPrice: number | null;
  alerts: PriceAlert[];
  onAdd: (a: PriceAlert) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const [direction, setDirection] = useState<"above" | "below">("above");
  const panelRef = useRef<HTMLDivElement>(null);
  const symbolAlerts = alerts.filter((a) => a.symbol === symbol);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  function handleAdd() {
    const price = parseFloat(input);
    if (isNaN(price) || price <= 0) return;
    onAdd({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      symbol,
      targetPrice: price,
      direction,
    });
    setInput("");
  }

  const ticker = symbol.split("/")[0] ?? symbol;

  return (
    <div
      ref={panelRef}
      className="absolute top-[50px] right-0 w-72 bg-bg-1 border border-border-2 rounded-xl shadow-xl shadow-black/30 z-30 overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <span className="text-sm font-semibold text-strong">
          Price Alerts · {ticker}
        </span>
        {currentPrice !== null && (
          <span className="font-mono text-xs text-muted">
            {formatPrice(currentPrice)}
          </span>
        )}
      </div>

      {/* Add row */}
      <div className="px-4 py-3 border-b border-border flex flex-col gap-2">
        <div className="flex gap-1">
          {(["above", "below"] as const).map((d) => (
            <button
              key={d}
              className={cn(
                "flex-1 py-1 rounded-md text-xs font-semibold border transition-colors duration-150",
                direction === d
                  ? d === "above"
                    ? "bg-success-subtle text-success border-success/30"
                    : "bg-danger-subtle text-danger border-danger/30"
                  : "bg-transparent text-faint border-border hover:text-foreground hover:bg-bg-3",
              )}
              onClick={() => setDirection(d)}
            >
              {d === "above" ? "≥ Above" : "≤ Below"}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            type="number"
            step="any"
            placeholder="Target price"
            aria-label="Target price"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            className="flex-1 bg-bg-2 border border-border rounded-md px-3 py-1.5 text-sm font-mono text-foreground placeholder:text-faint outline-none focus:border-accent/60 transition-colors"
          />
          <button
            className="px-3 py-1.5 rounded-md bg-accent text-bg text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-40"
            disabled={!input || isNaN(parseFloat(input))}
            onClick={handleAdd}
          >
            Add
          </button>
        </div>
      </div>

      {/* Alert list */}
      <div className="max-h-52 overflow-y-auto">
        {symbolAlerts.length === 0 ? (
          <div className="px-4 py-5 text-center text-sm text-faint">
            No alerts for {ticker}
          </div>
        ) : (
          symbolAlerts.map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between px-4 py-2.5 border-b border-border last:border-0 hover:bg-bg-2 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "text-xs font-semibold px-1.5 py-0.5 rounded",
                    a.direction === "above"
                      ? "bg-success-subtle text-success"
                      : "bg-danger-subtle text-danger",
                  )}
                >
                  {a.direction === "above" ? "≥" : "≤"}
                </span>
                <span className="font-mono text-sm text-foreground">
                  {formatPrice(a.targetPrice)}
                </span>
              </div>
              <button
                className="text-faint hover:text-danger transition-colors p-1 rounded"
                onClick={() => onRemove(a.id)}
                title="Remove alert"
                aria-label={`Remove alert for ${formatPrice(a.targetPrice)}`}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function buildDefaultSet(
  items: readonly { key?: string; id?: string; defaultEnabled: boolean }[],
): Set<string> {
  const set = new Set<string>();
  for (const item of items) {
    if (item.defaultEnabled) {
      set.add(item.key ?? item.id ?? "");
    }
  }
  return set;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

export default function Markets() {
  const [symbol, setSymbol] = useState<string>(() => {
    const stored = localStorage.getItem("markets:symbol");
    return stored && (SYMBOLS as readonly string[]).includes(stored) ? stored : "BTC/USDT";
  });
  const [timeframe, setTimeframe] = useState<TimeFrame>(() => {
    const stored = localStorage.getItem("markets:timeframe") as TimeFrame | null;
    return stored && TIMEFRAMES.includes(stored) ? stored : "1h";
  });
  const [marketType, setMarketType] = useState<MarketType>(() => {
    const stored = localStorage.getItem("markets:marketType");
    return stored === "spot" || stored === "futures" ? stored : "futures";
  });
  const [enabledOverlays, setEnabledOverlays] = useState<Set<string>>(() =>
    buildDefaultSet(OVERLAY_INDICATORS),
  );
  const [enabledOscillators, setEnabledOscillators] = useState<Set<string>>(
    () => buildDefaultSet(OSCILLATOR_GROUPS),
  );
  const [hoursMultiplier, setHoursMultiplier] = useState(1);

  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const toast = useToast();

  useEffect(() => { localStorage.setItem("markets:symbol", symbol); }, [symbol]);
  useEffect(() => { localStorage.setItem("markets:timeframe", timeframe); }, [timeframe]);
  useEffect(() => { localStorage.setItem("markets:marketType", marketType); }, [marketType]);

  const [alerts, setAlerts] = useState<PriceAlert[]>(loadAlerts);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const triggeredIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    localStorage.setItem("markets:alerts", JSON.stringify(alerts));
  }, [alerts]);

  useEffect(() => {
    setHoursMultiplier(1);
  }, [symbol, timeframe, marketType]);

  // Keyboard navigation: ← / → to cycle timeframes, Escape to close alert panel
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't fire when typing in an input
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "Escape") {
        setAlertsOpen(false);
        return;
      }

      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const idx = TIMEFRAMES.indexOf(timeframe);
        if (e.key === "ArrowLeft" && idx > 0) {
          setTimeframe(TIMEFRAMES[idx - 1]!);
        } else if (e.key === "ArrowRight" && idx < TIMEFRAMES.length - 1) {
          setTimeframe(TIMEFRAMES[idx + 1]!);
        }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [timeframe]);

  const baseHours = TIMEFRAME_HOURS[timeframe];
  const hours = baseHours * hoursMultiplier;
  const isFutures = marketType === "futures";

  const summaries = useSummaries();
  const indicators = useIndicators(symbol, timeframe, marketType, hours);
  const latestMetrics = useLatestMetrics(symbol, isFutures);
  const latestFunding = useLatestFunding(symbol, isFutures);
  const pipeline = usePipelineStatus();
  const { liveCandle } = useLiveKline(symbol, timeframe, marketType);

  const summary = summaries.data?.find(
    (s) => s.symbol === symbol && s.marketType === marketType,
  );
  const matchedLive =
    liveCandle && liveCandle.symbol === symbol ? liveCandle : null;
  const currentPrice = matchedLive?.close ?? summary?.price ?? null;

  // Check price alerts on every tick (must be after currentPrice is declared)
  useEffect(() => {
    if (currentPrice === null) return;
    const toTrigger = alerts.filter((a) => {
      if (a.symbol !== symbol) return false;
      if (triggeredIds.current.has(a.id)) return false;
      return a.direction === "above"
        ? currentPrice >= a.targetPrice
        : currentPrice <= a.targetPrice;
    });
    if (toTrigger.length === 0) return;
    for (const a of toTrigger) {
      triggeredIds.current.add(a.id);
      const ticker = a.symbol.split("/")[0] ?? a.symbol;
      toast.success(
        `${ticker} alert: price ${a.direction === "above" ? "≥" : "≤"} ${formatPrice(a.targetPrice)}`,
      );
    }
    const triggeredSet = new Set(toTrigger.map((a) => a.id));
    setAlerts((prev) => prev.filter((a) => !triggeredSet.has(a.id)));
  }, [currentPrice, symbol, alerts]);

  const titleSymbol = symbol.replace("/", "");
  const docTitle =
    currentPrice !== null
      ? `${formatPrice(currentPrice)} | ${titleSymbol}`
      : `${titleSymbol} | OpenCrow`;
  useDocumentTitle(docTitle);

  const handleToggleOverlay = useCallback((key: string) => {
    setEnabledOverlays((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleToggleOscillator = useCallback((id: string) => {
    setEnabledOscillators((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleLoadMore = useCallback(() => {
    setHoursMultiplier((prev) => Math.min(prev * 2, 16));
  }, []);

  const closedCandles = indicators.data?.candles ?? [];

  const candleData = useMemo(() => {
    if (!matchedLive || closedCandles.length === 0) return closedCandles;

    const lastClosed = closedCandles[closedCandles.length - 1]!;

    if (matchedLive.open_time > lastClosed.open_time) {
      return [...closedCandles, matchedLive];
    } else if (matchedLive.open_time === lastClosed.open_time) {
      return [...closedCandles.slice(0, -1), matchedLive];
    }
    return closedCandles;
  }, [closedCandles, matchedLive]);

  const isLoading = summaries.loading || indicators.loading;
  const hasError = summaries.error || indicators.error;

  if (isLoading) {
    return (
      <div className="flex flex-col h-screen max-md:h-[calc(100dvh-46px)] overflow-y-auto overflow-x-hidden relative bg-bg">
        {/* Shimmer skeleton header */}
        <div className="flex items-center gap-3 px-5 py-2 min-h-[50px] bg-bg-1 border-b border-border">
          <div className="w-6 h-6 rounded-full bg-bg-3 animate-pulse" />
          <div className="w-24 h-5 rounded bg-bg-3 animate-pulse" />
          <div className="w-px h-7 bg-border" />
          <div className="w-32 h-7 rounded bg-bg-3 animate-pulse" />
          <div className="w-16 h-6 rounded-full bg-bg-3 animate-pulse" />
          <div className="flex-1" />
          <div className="flex gap-1">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="w-10 h-7 rounded bg-bg-3 animate-pulse" />
            ))}
          </div>
        </div>
        <div className="flex items-center justify-center flex-1">
          <span className="w-5 h-5 border-2 border-border-2 border-t-accent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  if (hasError) {
    return (
      <div className="flex flex-col h-screen max-md:h-[calc(100dvh-46px)] overflow-y-auto overflow-x-hidden relative bg-bg">
        <div className="flex flex-col items-center justify-center flex-1 gap-4">
          <div className="w-14 h-14 rounded-xl bg-danger-subtle border border-danger/20 flex items-center justify-center text-2xl">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-danger"
            >
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div className="text-center">
            <div className="text-base font-semibold text-strong mb-1">
              Market pipeline offline
            </div>
            <div className="text-sm text-muted">
              Unable to connect to market data feed
            </div>
          </div>
          <button
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-bg-2 border border-border-2 text-sm font-medium text-foreground cursor-pointer transition-colors duration-150 hover:bg-bg-3"
            onClick={() => window.location.reload()}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const hasCandles = candleData.length > 0;

  const isLastCandleLive =
    matchedLive !== null &&
    candleData.length > 0 &&
    candleData[candleData.length - 1]!.open_time === matchedLive.open_time;

  const chartResetKey = `${symbol}-${timeframe}-${marketType}`;

  const symbolAlertCount = alerts.filter((a) => a.symbol === symbol).length;

  return (
    <div className="flex flex-col h-screen max-md:h-[calc(100dvh-46px)] overflow-y-auto overflow-x-hidden relative bg-bg">
      <MarketHeader
        symbol={symbol}
        timeframe={timeframe}
        marketType={marketType}
        onSymbolChange={setSymbol}
        onTimeframeChange={setTimeframe}
        onMarketTypeChange={setMarketType}
        summaries={summaries.data ?? []}
        metrics={isFutures ? latestMetrics.data : null}
        funding={isFutures ? latestFunding.data : null}
        pipeline={pipeline.data}
        livePrice={matchedLive?.close ?? null}
        onAlertsClick={() => setAlertsOpen((v) => !v)}
        alertCount={symbolAlertCount}
      />
      {alertsOpen && (
        <AlertPanel
          symbol={symbol}
          currentPrice={currentPrice}
          alerts={alerts}
          onAdd={(a) => setAlerts((prev) => [...prev, a])}
          onRemove={(id) => setAlerts((prev) => prev.filter((a) => a.id !== id))}
          onClose={() => setAlertsOpen(false)}
        />
      )}

      {/* 2-column grid: chart left, sidebar right (only with futures on desktop) */}
      <div
        className={cn(
          "grid grid-cols-1 h-[calc(100vh-56px)] min-h-[400px] overflow-hidden border-b border-border",
          isFutures && isDesktop && "grid-cols-[1fr_320px]",
        )}
      >
        <div className="min-w-0 flex flex-col border-r border-border z-[1]">
          {hasCandles && (
            <div className="flex-1 w-full flex flex-col relative bg-bg-1">
              <IndicatorToggles
                enabledOverlays={enabledOverlays}
                enabledOscillators={enabledOscillators}
                onToggleOverlay={handleToggleOverlay}
                onToggleOscillator={handleToggleOscillator}
              />
              <CandlestickChart
                data={candleData}
                overlays={indicators.data?.overlays}
                enabledOverlays={enabledOverlays}
                oscillators={indicators.data?.oscillators}
                enabledOscillators={enabledOscillators}
                isLastCandleLive={isLastCandleLive}
                resetKey={chartResetKey}
                onLoadMore={handleLoadMore}
              />
            </div>
          )}
        </div>

        {/* Desktop: sidebar with all 4 panels. Mobile: tabs below */}
        {isFutures && isDesktop && <FuturesSidebar symbol={symbol} />}
      </div>

      {/* Mobile: tabbed futures below chart */}
      {isFutures && !isDesktop && <FuturesTabs symbol={symbol} />}

      {/* Multi-timeframe indicator matrix */}
      <IndicatorMatrix symbol={symbol} marketType={marketType} />
    </div>
  );
}
