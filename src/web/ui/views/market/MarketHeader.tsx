import { useState, useRef, useEffect } from "react";
import { cn } from "../../lib/cn";
import type {
  TimeFrame,
  MarketType,
  MarketSummary,
  FuturesMetrics,
  FundingData,
  PipelineStatus,
} from "./types";
import { SYMBOLS, TIMEFRAMES } from "./types";
import {
  formatPrice,
  formatFundingRate,
  formatRatio,
  formatCompactNumber,
} from "./format";
import CoinIcon from "./CoinIcon";

interface Props {
  readonly symbol: string;
  readonly timeframe: TimeFrame;
  readonly marketType: MarketType;
  readonly onSymbolChange: (s: string) => void;
  readonly onTimeframeChange: (tf: TimeFrame) => void;
  readonly onMarketTypeChange: (mt: MarketType) => void;
  readonly summaries: readonly MarketSummary[];
  readonly metrics: FuturesMetrics | null;
  readonly funding: FundingData | null;
  readonly pipeline: PipelineStatus | null;
  readonly livePrice?: number | null;
  readonly onAlertsClick?: () => void;
  readonly alertCount?: number;
}

function SymbolDropdown({
  symbol,
  marketType,
  summaries,
  onSelect,
}: {
  symbol: string;
  marketType: MarketType;
  summaries: readonly MarketSummary[];
  onSelect: (s: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const ticker = symbol.split("/")[0] ?? "";

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        className="flex items-center gap-1.5 py-[3px] pr-2 pl-[3px] border-none rounded-md bg-transparent text-strong cursor-pointer transition-colors duration-150 ease-in-out hover:bg-bg-3"
        onClick={() => setOpen((p) => !p)}
      >
        <CoinIcon symbol={symbol} size={24} />
        <span className="font-heading text-[1.2rem] font-bold text-strong tracking-tight">
          {ticker}
        </span>
        <span className="font-heading text-lg font-normal text-faint">
          /USDT
        </span>
        <span className="text-[0.45rem] text-faint ml-0.5">&#x25BC;</span>
      </button>

      {open && (
        <div className="absolute top-[calc(100%+4px)] left-0 w-80 bg-bg-1 border border-border-2 rounded-lg p-1.5 z-[100] animate-[menuDrop_0.15s_ease-out]">
          {SYMBOLS.map((s) => {
            const t = s.split("/")[0] ?? "";
            const sum = summaries.find(
              (sm) => sm.symbol === s && sm.marketType === marketType,
            );
            const isActive = symbol === s;
            const pctChange = sum?.changePercent24h ?? 0;
            const isUp = pctChange >= 0;
            return (
              <button
                key={s}
                className={cn(
                  "flex items-center gap-3 w-full py-2.5 px-3 border-none rounded-md bg-transparent text-foreground text-sm cursor-pointer text-left transition-colors duration-150 ease-in-out hover:bg-bg-3",
                  isActive && "bg-accent-subtle",
                )}
                onClick={() => {
                  onSelect(s);
                  setOpen(false);
                }}
              >
                <CoinIcon symbol={s} size={22} />
                <span className="font-heading font-semibold min-w-[80px]">
                  {t}/USDT
                </span>
                {sum && (
                  <>
                    <span className="font-mono text-sm text-foreground ml-auto">
                      ${formatPrice(sum.price)}
                    </span>
                    <span
                      className={cn(
                        "font-mono text-sm font-semibold min-w-[60px] text-right",
                        isUp ? "text-success" : "text-danger",
                      )}
                    >
                      {isUp ? "+" : ""}
                      {pctChange.toFixed(2)}%
                    </span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatChip({
  label,
  value,
  color,
  accent,
}: {
  label: string;
  value: string;
  color?: string;
  accent?: string;
}) {
  return (
    <div
      className="flex flex-col shrink-0 pl-2.5 border-l-2"
      style={{ borderLeftColor: accent ?? "var(--color-border)" }}
    >
      <span className="text-xs font-medium text-muted whitespace-nowrap leading-tight max-[1200px]:text-[0.68rem]">
        {label}
      </span>
      <span
        className="font-mono text-sm font-semibold whitespace-nowrap leading-tight max-[1200px]:text-sm rounded px-1 -ml-1"
        style={{
          color: color ?? "var(--color-strong)",
          backgroundColor: accent
            ? `color-mix(in srgb, ${accent} 8%, transparent)`
            : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}

export default function MarketHeader({
  symbol,
  timeframe,
  marketType,
  onSymbolChange,
  onTimeframeChange,
  onMarketTypeChange,
  summaries,
  metrics,
  funding,
  pipeline,
  livePrice,
  onAlertsClick,
  alertCount,
}: Props) {
  const summary = summaries.find(
    (s) => s.symbol === symbol && s.marketType === marketType,
  );

  const displayPrice = livePrice ?? summary?.price ?? null;
  const isUp = summary ? summary.changePercent24h >= 0 : true;
  const changeStr = summary
    ? `${isUp ? "+" : ""}${summary.changePercent24h.toFixed(2)}%`
    : "";

  const isFutures = marketType === "futures";
  const fr = funding?.latest;

  return (
    <div className="flex flex-col bg-bg-1 border-b border-border shrink-0 relative z-20">
      <div className="flex items-center gap-3 px-5 py-2 min-h-[50px] max-[900px]:flex-wrap max-[900px]:gap-2 max-[900px]:px-4">
        {/* Left: Symbol + Price + Change */}
        <div className="flex items-center gap-2.5 shrink-0">
          <SymbolDropdown
            symbol={symbol}
            marketType={marketType}
            summaries={summaries}
            onSelect={onSymbolChange}
          />

          <div className="w-px h-7 bg-border shrink-0 max-[900px]:hidden" />

          <div className="flex items-baseline gap-1 shrink-0">
            {displayPrice !== null ? (
              <span
                className={cn(
                  "font-mono text-[1.4rem] font-bold tracking-tight leading-none",
                  isUp ? "text-success" : "text-danger",
                )}
              >
                {formatPrice(displayPrice)}
              </span>
            ) : (
              <span className="font-mono text-[1.4rem] font-bold tracking-tight leading-none">
                --
              </span>
            )}
          </div>

          {summary && (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 py-1 px-3 rounded-full font-mono text-sm font-bold tracking-tight",
                isUp
                  ? "bg-success-subtle text-success"
                  : "bg-danger-subtle text-danger",
              )}
            >
              <span className="text-[0.6rem] leading-none">
                {isUp ? "\u25B2" : "\u25BC"}
              </span>
              {changeStr}
            </span>
          )}
        </div>

        {/* Center: Stats */}
        <div className="flex gap-5 items-center flex-1 overflow-x-auto mx-4 max-[1200px]:gap-3 max-[900px]:hidden">
          {summary && (
            <>
              <StatChip
                label="24h High"
                value={formatPrice(summary.high24h)}
                accent="var(--color-success)"
              />
              <StatChip
                label="24h Low"
                value={formatPrice(summary.low24h)}
                accent="var(--color-danger)"
              />
              <StatChip
                label="Volume"
                value={formatCompactNumber(summary.quoteVolume24h)}
                accent="var(--color-accent)"
              />
            </>
          )}
          {isFutures && metrics && (
            <>
              <StatChip
                label="OI"
                value={`$${formatCompactNumber(metrics.sumOpenInterestValue)}`}
                accent="var(--color-purple)"
              />
              {fr && (
                <StatChip
                  label="Funding"
                  value={formatFundingRate(fr.fundingRate)}
                  color={
                    fr.fundingRate > 0
                      ? "var(--color-success)"
                      : fr.fundingRate < 0
                        ? "var(--color-danger)"
                        : undefined
                  }
                  accent={
                    fr.fundingRate >= 0
                      ? "var(--color-success)"
                      : "var(--color-danger)"
                  }
                />
              )}
              <StatChip
                label="L/S"
                value={formatRatio(metrics.countLongShortRatio)}
                accent="var(--color-purple)"
                color={
                  metrics.countLongShortRatio > 1
                    ? "var(--color-success)"
                    : metrics.countLongShortRatio < 1
                      ? "var(--color-danger)"
                      : undefined
                }
              />
            </>
          )}
        </div>

        {/* Right: Timeframe + Spot/Perp + Pipeline */}
        <div className="flex items-center gap-3 ml-auto shrink-0 max-[900px]:ml-0 max-[900px]:w-full">
          <div className="flex gap-px max-[900px]:flex-wrap">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                className={cn(
                  "py-1.5 px-3 border-none rounded-md bg-transparent text-faint font-mono text-sm font-semibold cursor-pointer transition-all duration-150 ease-in-out hover:text-foreground hover:bg-bg-3",
                  timeframe === tf && "text-accent bg-accent-subtle",
                )}
                onClick={() => onTimeframeChange(tf)}
              >
                {tf}
              </button>
            ))}
          </div>

          <div className="flex gap-px bg-bg-2 border border-border rounded-md p-0.5">
            {(["spot", "futures"] as const).map((mt) => (
              <button
                key={mt}
                className={cn(
                  "py-1 px-4 border-none rounded-md bg-transparent text-faint text-sm font-semibold cursor-pointer transition-all duration-150 ease-in-out hover:text-foreground",
                  marketType === mt && "bg-bg-3 text-strong",
                )}
                onClick={() => onMarketTypeChange(mt)}
              >
                {mt === "spot" ? "Spot" : "Perp"}
              </button>
            ))}
          </div>

          {onAlertsClick && (
            <button
              className="relative p-1.5 rounded-md text-faint hover:text-foreground hover:bg-bg-3 transition-colors cursor-pointer"
              onClick={onAlertsClick}
              title="Price alerts"
              aria-label="Price alerts"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              {!!alertCount && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] rounded-full bg-accent text-bg text-[9px] font-bold flex items-center justify-center leading-none">
                  {alertCount}
                </span>
              )}
            </button>
          )}

          {pipeline && (
            <div
              className={cn(
                "w-2 h-2 rounded-full shrink-0",
                pipeline.running && pipeline.questdbConnected
                  ? "bg-success"
                  : "bg-danger",
              )}
              title={`Pipeline: ${pipeline.running ? "Running" : "Stopped"} | QDB: ${pipeline.questdbConnected ? "OK" : "Down"}`}
            />
          )}
        </div>
      </div>
    </div>
  );
}
