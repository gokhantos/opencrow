import { useState } from "react";
import MiniPanel from "./MiniPanel";
import OpenInterestChart from "./OpenInterestChart";
import LongShortChart from "./LongShortChart";
import FundingRateChart from "./FundingRateChart";
import LiquidationsPanel from "./LiquidationsPanel";
import {
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
import {
  formatCompactNumber,
  formatFundingRate,
  formatRatio,
  formatVolume,
} from "./format";

interface Props {
  readonly symbol: string;
}

export default function FuturesSidebar({ symbol }: Props) {
  const [metricsHours, setMetricsHours] = useState(72);
  const [fundingHours, setFundingHours] = useState(168);
  const [liqHours, setLiqHours] = useState(24);

  const metrics = useMetricsHistory(symbol, metricsHours, true);
  const funding = useFunding(symbol, fundingHours, true);
  const liquidations = useLiquidations(symbol, true);
  const liqBuckets = useLiquidationBuckets(symbol, liqHours, true);

  const latestMetric =
    metrics.data && metrics.data.length > 0
      ? metrics.data[metrics.data.length - 1]
      : null;

  const latestFunding =
    funding.data && funding.data.history.length > 0
      ? funding.data.history[funding.data.history.length - 1]
      : null;

  const totalLongUsd =
    liquidations.data?.summary
      .filter((s) => s.side === "SELL")
      .reduce((acc, s) => acc + s.total_usd, 0) ?? 0;

  const totalShortUsd =
    liquidations.data?.summary
      .filter((s) => s.side === "BUY")
      .reduce((acc, s) => acc + s.total_usd, 0) ?? 0;

  return (
    <div className="flex flex-col gap-px overflow-y-auto border-l border-border bg-bg max-[1024px]:hidden">
      {/* Open Interest */}
      <MiniPanel
        title="Open Interest"
        value={
          latestMetric
            ? `$${formatCompactNumber(latestMetric.sumOpenInterestValue)}`
            : "--"
        }
        accentColor="var(--color-info)"
        timeRangeOptions={METRICS_RANGES}
        timeRangeValue={metricsHours}
        onTimeRangeChange={setMetricsHours}
        loading={metrics.loading}
      >
        {metrics.data && metrics.data.length > 0 ? (
          <OpenInterestChart data={metrics.data} compact />
        ) : (
          <div className="flex items-center justify-center p-8 text-faint text-sm font-mono">
            No data
          </div>
        )}
      </MiniPanel>

      {/* Long/Short Ratio */}
      <MiniPanel
        title="Long/Short"
        value={
          latestMetric ? formatRatio(latestMetric.countLongShortRatio) : "--"
        }
        subtitle="ratio"
        accentColor="var(--color-purple)"
        timeRangeOptions={METRICS_RANGES}
        timeRangeValue={metricsHours}
        onTimeRangeChange={setMetricsHours}
        loading={metrics.loading}
      >
        {metrics.data && metrics.data.length > 0 ? (
          <LongShortChart data={metrics.data} compact />
        ) : (
          <div className="flex items-center justify-center p-8 text-faint text-sm font-mono">
            No data
          </div>
        )}
      </MiniPanel>

      {/* Funding Rate */}
      <MiniPanel
        title="Funding Rate"
        value={
          latestFunding ? formatFundingRate(latestFunding.fundingRate) : "--"
        }
        accentColor={
          latestFunding && latestFunding.fundingRate >= 0
            ? "var(--color-success)"
            : "var(--color-danger)"
        }
        timeRangeOptions={FUNDING_RANGES}
        timeRangeValue={fundingHours}
        onTimeRangeChange={setFundingHours}
        loading={funding.loading}
      >
        {funding.data && funding.data.history.length > 0 ? (
          <FundingRateChart data={funding.data.history} compact />
        ) : (
          <div className="flex items-center justify-center p-8 text-faint text-sm font-mono">
            No data
          </div>
        )}
      </MiniPanel>

      {/* Liquidations */}
      <MiniPanel
        title="Liquidations"
        value={`L: ${formatVolume(totalLongUsd)} S: ${formatVolume(totalShortUsd)}`}
        accentColor="var(--color-warning)"
        timeRangeOptions={LIQUIDATION_RANGES}
        timeRangeValue={liqHours}
        onTimeRangeChange={setLiqHours}
        loading={liquidations.loading}
      >
        <LiquidationsPanel
          buckets={liqBuckets.data ?? []}
          recent={liquidations.data?.recent ?? []}
          totalLongUsd={totalLongUsd}
          totalShortUsd={totalShortUsd}
          compact
        />
      </MiniPanel>
    </div>
  );
}
