import { useState } from "react";
import { cn } from "../../lib/cn";
import OpenInterestChart from "./OpenInterestChart";
import LongShortChart from "./LongShortChart";
import FundingRateChart from "./FundingRateChart";
import LiquidationsPanel from "./LiquidationsPanel";
import TimeRangeSelector, {
  METRICS_RANGES,
  FUNDING_RANGES,
  LIQUIDATION_RANGES,
} from "./TimeRangeSelector";
import {
  useMetricsHistory,
  useFunding,
  useLiquidations,
  useLiquidationBuckets,
} from "./hooks";

const TABS = [
  { id: "oi", label: "Open Interest", accent: "var(--color-accent)" },
  { id: "ls", label: "Long/Short", accent: "var(--color-purple)" },
  { id: "funding", label: "Funding", accent: "var(--color-success)" },
  { id: "liquidations", label: "Liquidations", accent: "var(--color-warning)" },
] as const;

type TabId = (typeof TABS)[number]["id"];

interface Props {
  readonly symbol: string;
}

export default function FuturesTabs({ symbol }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>("oi");
  const [metricsHours, setMetricsHours] = useState(72);
  const [fundingHours, setFundingHours] = useState(168);
  const [liqHours, setLiqHours] = useState(24);

  const isMetricsTab = activeTab === "oi" || activeTab === "ls";
  const metrics = useMetricsHistory(symbol, metricsHours, isMetricsTab);
  const funding = useFunding(symbol, fundingHours, activeTab === "funding");
  const liquidations = useLiquidations(symbol, activeTab === "liquidations");
  const liqBuckets = useLiquidationBuckets(
    symbol,
    liqHours,
    activeTab === "liquidations",
  );

  const totalLongUsd =
    liquidations.data?.summary
      .filter((s) => s.side === "SELL")
      .reduce((acc, s) => acc + s.total_usd, 0) ?? 0;

  const totalShortUsd =
    liquidations.data?.summary
      .filter((s) => s.side === "BUY")
      .reduce((acc, s) => acc + s.total_usd, 0) ?? 0;

  return (
    <div className="shrink-0 bg-bg-1 border-t border-border overflow-hidden">
      <div className="flex gap-0 border-b border-border px-5 bg-bg-1">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              className={cn(
                "relative py-2.5 px-5 border-none bg-transparent text-faint font-heading text-xs font-semibold tracking-tight cursor-pointer transition-all duration-150 ease-in-out hover:text-foreground",
                isActive && "text-strong",
              )}
              style={
                isActive
                  ? {
                      backgroundColor: `color-mix(in srgb, ${tab.accent} 8%, transparent)`,
                    }
                  : undefined
              }
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
              {isActive && (
                <span
                  className="absolute bottom-[-1px] left-2 right-2 h-0.5 rounded-t-sm"
                  style={{ backgroundColor: tab.accent }}
                />
              )}
            </button>
          );
        })}
      </div>

      <div className="py-3 px-5 pb-4 min-h-[260px]">
        {activeTab === "oi" && (
          <>
            <TimeRangeSelector
              options={METRICS_RANGES}
              value={metricsHours}
              onChange={setMetricsHours}
            />
            {metrics.loading ? (
              <div className="flex items-center justify-center py-8">
                <span className="w-4 h-4 border-2 border-border-2 border-t-accent rounded-full animate-spin" />
              </div>
            ) : metrics.data && metrics.data.length > 0 ? (
              <OpenInterestChart data={metrics.data} />
            ) : (
              <div className="flex items-center justify-center p-8 text-faint text-sm font-mono">
                No open interest data
              </div>
            )}
          </>
        )}

        {activeTab === "ls" && (
          <>
            <TimeRangeSelector
              options={METRICS_RANGES}
              value={metricsHours}
              onChange={setMetricsHours}
            />
            {metrics.loading ? (
              <div className="flex items-center justify-center py-8">
                <span className="w-4 h-4 border-2 border-border-2 border-t-accent rounded-full animate-spin" />
              </div>
            ) : metrics.data && metrics.data.length > 0 ? (
              <LongShortChart data={metrics.data} />
            ) : (
              <div className="flex items-center justify-center p-8 text-faint text-sm font-mono">
                No long/short data
              </div>
            )}
          </>
        )}

        {activeTab === "funding" && (
          <>
            <TimeRangeSelector
              options={FUNDING_RANGES}
              value={fundingHours}
              onChange={setFundingHours}
            />
            {funding.loading ? (
              <div className="flex items-center justify-center py-8">
                <span className="w-4 h-4 border-2 border-border-2 border-t-accent rounded-full animate-spin" />
              </div>
            ) : funding.data && funding.data.history.length > 0 ? (
              <FundingRateChart data={funding.data.history} />
            ) : (
              <div className="flex items-center justify-center p-8 text-faint text-sm font-mono">
                No funding data
              </div>
            )}
          </>
        )}

        {activeTab === "liquidations" && (
          <>
            <TimeRangeSelector
              options={LIQUIDATION_RANGES}
              value={liqHours}
              onChange={setLiqHours}
            />
            {liquidations.loading ? (
              <div className="flex items-center justify-center py-8">
                <span className="w-4 h-4 border-2 border-border-2 border-t-accent rounded-full animate-spin" />
              </div>
            ) : (
              <LiquidationsPanel
                buckets={liqBuckets.data ?? []}
                recent={liquidations.data?.recent ?? []}
                totalLongUsd={totalLongUsd}
                totalShortUsd={totalShortUsd}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
