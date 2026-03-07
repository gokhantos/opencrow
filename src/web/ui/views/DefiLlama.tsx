import React, { useState, useEffect, lazy, Suspense } from "react";
import { apiFetch } from "../api";
import { cn } from "../lib/cn";
import { PageHeader, FilterTabs, LoadingState } from "../components";
import {
  Activity,
  Link,
  TrendingUp,
  DollarSign,
  BarChart2,
  Layers,
} from "lucide-react";

const DefiOverviewTab = lazy(() => import("./defi/DefiOverviewTab"));
const ProtocolsTab = lazy(() => import("./defi/ProtocolsTab"));
const YieldsTab = lazy(() => import("./defi/YieldsTab"));
const BridgesTab = lazy(() => import("./defi/BridgesTab"));
const StablecoinsTab = lazy(() => import("./defi/StablecoinsTab"));
const HacksTab = lazy(() => import("./defi/HacksTab"));
const EmissionsTab = lazy(() => import("./defi/EmissionsTab"));
const TreasuryTab = lazy(() => import("./defi/TreasuryTab"));

interface StatsData {
  readonly total_protocols: number;
  readonly last_updated_at: number | null;
  readonly chains: number;
  readonly categories: number;
}

interface GlobalMetric {
  readonly metric_type: string;
  readonly metric_date: number;
  readonly total_24h: number | null;
  readonly total_7d: number | null;
  readonly change_1d: number | null;
  readonly extra_json: string;
  readonly updated_at: number;
}

type TabId =
  | "overview"
  | "protocols"
  | "yields"
  | "bridges"
  | "stablecoins"
  | "hacks"
  | "emissions"
  | "treasury";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "protocols", label: "Protocols" },
  { id: "yields", label: "Yields" },
  { id: "bridges", label: "Bridges" },
  { id: "stablecoins", label: "Stablecoins" },
  { id: "hacks", label: "Hacks" },
  { id: "emissions", label: "Emissions" },
  { id: "treasury", label: "Treasury" },
] as const;

function formatCompact(raw: number | string | null | undefined): string {
  const value = Number(raw);
  if (raw == null || !isFinite(value) || value === 0) return "—";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function StatCard({
  icon,
  label,
  value,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-4 rounded-lg bg-bg-1 border border-border transition-colors hover:border-border-2">
      <div className="w-9 h-9 rounded-md flex items-center justify-center shrink-0 bg-bg-2 text-muted border border-border">
        {icon}
      </div>
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">
          {label}
        </span>
        <span className="font-mono text-sm text-strong">{value}</span>
      </div>
    </div>
  );
}

export default function DefiLlama() {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [stats, setStats] = useState<StatsData | null>(null);
  const [metrics, setMetrics] = useState<GlobalMetric[]>([]);

  useEffect(() => {
    fetchGlobalData();
    const interval = setInterval(fetchGlobalData, 60_000);
    return () => clearInterval(interval);
  }, []);

  async function fetchGlobalData() {
    try {
      const [statsRes, metricsRes] = await Promise.all([
        apiFetch<{ success: boolean; data: StatsData }>("/api/defi/stats"),
        apiFetch<{ success: boolean; data: GlobalMetric[] }>(
          "/api/defi/global-metrics",
        ),
      ]);
      if (statsRes.success) setStats(statsRes.data);
      if (metricsRes.success) setMetrics(metricsRes.data);
    } catch {
      // non-fatal — stats bar just shows dashes
    }
  }

  function getMetric(type: string): number | null {
    return metrics.find((m) => m.metric_type === type)?.total_24h ?? null;
  }

  const fees = getMetric("fees");
  const dexVol = getMetric("dex_volume");
  const optionsVol = getMetric("options_premium");
  const derivsVol = getMetric("derivatives_volume");

  return (
    <div>
      <PageHeader
        title="DeFiLlama"
        subtitle={
          stats
            ? `${stats.total_protocols.toLocaleString()} protocols · ${stats.chains} chains`
            : undefined
        }
      />

      {/* Global Stats Bar */}
      <div className="grid grid-cols-6 max-lg:grid-cols-3 max-sm:grid-cols-2 gap-3 mb-6">
        <StatCard
          icon={<Layers size={16} />}
          label="Protocols"
          value={stats ? stats.total_protocols.toLocaleString() : "—"}
        />
        <StatCard
          icon={<Activity size={16} />}
          label="Chains"
          value={stats ? String(stats.chains) : "—"}
        />
        <StatCard
          icon={<DollarSign size={16} />}
          label="Fees 24h"
          value={formatCompact(fees)}
        />
        <StatCard
          icon={<BarChart2 size={16} />}
          label="DEX Volume 24h"
          value={formatCompact(dexVol)}
        />
        <StatCard
          icon={<TrendingUp size={16} />}
          label="Options Vol 24h"
          value={formatCompact(optionsVol)}
        />
        <StatCard
          icon={<Link size={16} />}
          label="Derivatives Vol 24h"
          value={formatCompact(derivsVol)}
        />
      </div>

      {/* Tab Navigation */}
      <FilterTabs
        tabs={TABS.map((t) => ({ id: t.id, label: t.label }))}
        active={activeTab}
        onChange={(id) => setActiveTab(id as TabId)}
      />

      {/* Tab Content */}
      <Suspense fallback={<LoadingState />}>
        {activeTab === "overview" && <DefiOverviewTab />}
        {activeTab === "protocols" && <ProtocolsTab />}
        {activeTab === "yields" && <YieldsTab />}
        {activeTab === "bridges" && <BridgesTab />}
        {activeTab === "stablecoins" && <StablecoinsTab />}
        {activeTab === "hacks" && <HacksTab />}
        {activeTab === "emissions" && <EmissionsTab />}
        {activeTab === "treasury" && <TreasuryTab />}
      </Suspense>
    </div>
  );
}
