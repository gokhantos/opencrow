import React, { useState, useEffect } from "react";
import { apiFetch } from "../api";
import { LoadingState, PageHeader, Toggle, Button } from "../components";
import { useToast } from "../components/Toast";
import {
  Database,
  TrendingUp,
  Rss,
  ChevronRight,
  Circle,
  Settings as SettingsIcon,
} from "lucide-react";

interface ScraperMeta {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

interface FeaturesResponse {
  readonly scrapers: {
    readonly available: readonly ScraperMeta[];
    readonly enabled: readonly string[];
  };
  readonly qdrant: { readonly enabled: boolean };
  readonly market: { readonly enabled: boolean };
}

/* ── Status pill ── */
function StatusPill({ enabled }: { readonly enabled: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full ${
        enabled
          ? "bg-success-subtle text-success"
          : "bg-bg-3 text-muted"
      }`}
    >
      <Circle
        className={`w-1.5 h-1.5 ${enabled ? "fill-success" : "fill-muted"}`}
        strokeWidth={0}
      />
      {enabled ? "Active" : "Off"}
    </span>
  );
}

/* ── Feature card for single-toggle features ── */
function FeatureCard({
  icon: Icon,
  iconColor,
  title,
  description,
  detail,
  enabled,
  saving,
  onToggle,
}: {
  readonly icon: React.ComponentType<{ className?: string }>;
  readonly iconColor: string;
  readonly title: string;
  readonly description: string;
  readonly detail: string;
  readonly enabled: boolean;
  readonly saving: boolean;
  readonly onToggle: (checked: boolean) => void;
}) {
  return (
    <div className="group bg-bg-1 border border-border rounded-xl p-5 transition-all duration-200 hover:border-border-hover">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3.5 min-w-0">
          <div
            className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${iconColor}`}
          >
            <Icon className="w-[18px] h-[18px]" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 mb-1">
              <h3 className="text-sm font-semibold text-strong m-0">
                {title}
              </h3>
              <StatusPill enabled={enabled} />
            </div>
            <p className="text-xs text-muted m-0 leading-relaxed">
              {description}
            </p>
          </div>
        </div>
        <Toggle
          checked={enabled}
          onChange={onToggle}
          disabled={saving}
        />
      </div>
      <div className="mt-3 ml-[50px] text-xs text-faint">
        {detail}
      </div>
    </div>
  );
}

/* ── Scrapers section (expandable) ── */
function ScrapersSection({
  scrapers,
  enabledScrapers,
  dirty,
  saving,
  onToggle,
  onSave,
}: {
  readonly scrapers: readonly ScraperMeta[];
  readonly enabledScrapers: ReadonlySet<string>;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly onToggle: (id: string, checked: boolean) => void;
  readonly onSave: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const enabledCount = enabledScrapers.size;
  const totalCount = scrapers.length;

  return (
    <div className="bg-bg-1 border border-border rounded-xl transition-all duration-200 hover:border-border-hover">
      {/* Header — always visible */}
      <button
        type="button"
        className="w-full flex items-center justify-between gap-4 p-5 bg-transparent border-none cursor-pointer text-left"
        onClick={() => setExpanded((p) => !p)}
      >
        <div className="flex items-center gap-3.5 min-w-0">
          <div className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center bg-pink-subtle text-pink">
            <Rss className="w-[18px] h-[18px]" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 mb-1">
              <h3 className="text-sm font-semibold text-strong m-0">
                Scrapers
              </h3>
              <span className="text-xs font-medium text-muted bg-bg-2 px-2 py-0.5 rounded-md font-mono">
                {enabledCount}/{totalCount}
              </span>
              {dirty && (
                <span className="text-xs font-medium text-warning bg-warning-subtle px-2 py-0.5 rounded-full">
                  Unsaved
                </span>
              )}
            </div>
            <p className="text-xs text-muted m-0">
              Data scrapers for feeds, social, and market intelligence
            </p>
          </div>
        </div>
        <ChevronRight
          className={`w-4 h-4 text-muted shrink-0 transition-transform duration-200 ${
            expanded ? "rotate-90" : ""
          }`}
        />
      </button>

      {/* Expandable body */}
      {expanded && (
        <div className="border-t border-border px-5 pb-5">
          {scrapers.length === 0 ? (
            <p className="text-sm text-muted py-4">
              No scrapers available.
            </p>
          ) : (
            <div className="flex flex-col">
              {scrapers.map((scraper, i) => (
                <div
                  key={scraper.id}
                  className={`flex items-center justify-between py-3 ${
                    i < scrapers.length - 1
                      ? "border-b border-border"
                      : ""
                  }`}
                >
                  <div className="min-w-0 pr-4">
                    <div className="text-sm font-medium text-foreground">
                      {scraper.name}
                    </div>
                    {scraper.description && (
                      <div className="text-xs text-muted mt-0.5">
                        {scraper.description}
                      </div>
                    )}
                  </div>
                  <Toggle
                    checked={enabledScrapers.has(scraper.id)}
                    onChange={(checked) => onToggle(scraper.id, checked)}
                  />
                </div>
              ))}
            </div>
          )}

          {dirty && (
            <div className="mt-4 flex justify-end">
              <Button
                variant="primary"
                size="sm"
                onClick={onSave}
                disabled={saving}
                loading={saving}
              >
                Save Changes
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Main ── */
export default function Settings() {
  const { success, error: toastError } = useToast();

  const [features, setFeatures] = useState<FeaturesResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const [enabledScrapers, setEnabledScrapers] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [scrapersDirty, setScrapersDirty] = useState(false);
  const [scrapersSaving, setScrapersSaving] = useState(false);
  const [qdrantSaving, setQdrantSaving] = useState(false);
  const [marketSaving, setMarketSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ data: FeaturesResponse }>("/api/features");
        if (cancelled) return;
        setFeatures(res.data);
        setEnabledScrapers(new Set(res.data.scrapers.enabled));
        setScrapersDirty(false);
      } catch {
        if (!cancelled) toastError("Failed to load feature settings.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleScraperToggle(id: string, checked: boolean) {
    setEnabledScrapers((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
    setScrapersDirty(true);
  }

  async function handleSaveScrapers() {
    setScrapersSaving(true);
    try {
      await apiFetch("/api/features/scrapers", {
        method: "PUT",
        body: JSON.stringify({ enabled: [...enabledScrapers] }),
      });
      setScrapersDirty(false);
      success("Scraper settings saved.");
    } catch {
      toastError("Failed to save scraper settings.");
    } finally {
      setScrapersSaving(false);
    }
  }

  async function handleQdrantToggle(checked: boolean) {
    if (!features) return;
    setQdrantSaving(true);
    try {
      await apiFetch("/api/features/qdrant", {
        method: "PUT",
        body: JSON.stringify({ enabled: checked }),
      });
      setFeatures((prev) =>
        prev ? { ...prev, qdrant: { enabled: checked } } : prev,
      );
      success(`Qdrant ${checked ? "enabled" : "disabled"}.`);
    } catch {
      toastError("Failed to update Qdrant setting.");
    } finally {
      setQdrantSaving(false);
    }
  }

  async function handleMarketToggle(checked: boolean) {
    if (!features) return;
    setMarketSaving(true);
    try {
      await apiFetch("/api/features/market", {
        method: "PUT",
        body: JSON.stringify({ enabled: checked }),
      });
      setFeatures((prev) =>
        prev ? { ...prev, market: { enabled: checked } } : prev,
      );
      success(`Market data ${checked ? "enabled" : "disabled"}.`);
    } catch {
      toastError("Failed to update market data setting.");
    } finally {
      setMarketSaving(false);
    }
  }

  if (loading) return <LoadingState message="Loading settings..." />;
  if (!features) return null;

  return (
    <div className="max-w-[760px]">
      <PageHeader
        title="Settings"
        subtitle="Manage infrastructure features and integrations"
        actions={
          <div className="flex items-center gap-2 text-xs text-muted">
            <SettingsIcon className="w-3.5 h-3.5" />
            <span>
              {[
                features.qdrant.enabled && "Qdrant",
                features.market.enabled && "Market",
                enabledScrapers.size > 0 &&
                  `${enabledScrapers.size} scraper${enabledScrapers.size === 1 ? "" : "s"}`,
              ]
                .filter(Boolean)
                .join(" + ") || "All features disabled"}
            </span>
          </div>
        }
      />

      <div className="flex flex-col gap-3">
        {/* Qdrant */}
        <FeatureCard
          icon={Database}
          iconColor="bg-accent-subtle text-accent"
          title="Qdrant (RAG Memory)"
          description="Vector database for agent long-term memory and semantic search."
          detail={
            features.qdrant.enabled
              ? "Agents can read and write memory via RAG retrieval."
              : "RAG memory is unavailable for all agents."
          }
          enabled={features.qdrant.enabled}
          saving={qdrantSaving}
          onToggle={handleQdrantToggle}
        />

        {/* Market Data */}
        <FeatureCard
          icon={TrendingUp}
          iconColor="bg-cyan-subtle text-cyan"
          title="Market Data (QuestDB)"
          description="Time-series market data pipeline for candlestick and futures data."
          detail={
            features.market.enabled
              ? "Candlestick and futures data are live."
              : "The Markets view will be empty."
          }
          enabled={features.market.enabled}
          saving={marketSaving}
          onToggle={handleMarketToggle}
        />

        {/* Scrapers */}
        <ScrapersSection
          scrapers={features.scrapers.available}
          enabledScrapers={enabledScrapers}
          dirty={scrapersDirty}
          saving={scrapersSaving}
          onToggle={handleScraperToggle}
          onSave={handleSaveScrapers}
        />
      </div>
    </div>
  );
}
