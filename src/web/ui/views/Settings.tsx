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
  Settings2,
} from "lucide-react";

interface ScraperMeta {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

interface GithubSearchConfig {
  readonly minStars: number;
  readonly pushedWithinDays: number;
  readonly maxPages: number;
}

/** Scrapers that expose configurable settings */
const CONFIGURABLE_SCRAPERS = new Set(["github-search"]);

const GITHUB_SEARCH_CONFIG_DEFAULTS: GithubSearchConfig = {
  minStars: 500,
  pushedWithinDays: 7,
  maxPages: 4,
};

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

/* ── Config field ── */
function ConfigField({
  label,
  description,
  value,
  min,
  max,
  onChange,
}: {
  readonly label: string;
  readonly description: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">{label}</div>
        <div className="text-xs text-muted mt-0.5">{description}</div>
      </div>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (!isNaN(n)) onChange(n);
        }}
        className="w-20 shrink-0 bg-bg-2 border border-border rounded-md px-2 py-1 text-xs text-foreground text-right focus:outline-none focus:border-accent"
      />
    </div>
  );
}

/* ── Github Search inline config form ── */
function GithubSearchConfigForm({
  scraperId,
  onClose,
}: {
  readonly scraperId: string;
  readonly onClose: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [config, setConfig] = useState<GithubSearchConfig>(GITHUB_SEARCH_CONFIG_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ data: GithubSearchConfig }>(
          `/api/features/scraper-config/${scraperId}`,
        );
        if (!cancelled) setConfig(res.data);
      } catch {
        if (!cancelled) toastError("Failed to load scraper config.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scraperId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    setSaving(true);
    try {
      await apiFetch(`/api/features/scraper-config/${scraperId}`, {
        method: "PUT",
        body: JSON.stringify(config),
      });
      success("Scraper config saved.");
      onClose();
    } catch {
      toastError("Failed to save scraper config.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2 mx-0 bg-bg-2 border border-border rounded-lg p-3">
      {loading ? (
        <p className="text-xs text-muted py-1">Loading config…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <ConfigField
            label="Minimum stars"
            description="Only include repos with at least this many stars"
            value={config.minStars}
            min={1}
            max={100000}
            onChange={(v) => setConfig((prev) => ({ ...prev, minStars: v }))}
          />
          <ConfigField
            label="Pushed within days"
            description="Only include repos pushed within this many days"
            value={config.pushedWithinDays}
            min={1}
            max={90}
            onChange={(v) => setConfig((prev) => ({ ...prev, pushedWithinDays: v }))}
          />
          <ConfigField
            label="Max pages"
            description="Max pages to fetch per scrape run (30 repos per page)"
            value={config.maxPages}
            min={1}
            max={10}
            onChange={(v) => setConfig((prev) => ({ ...prev, maxPages: v }))}
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={saving}
              loading={saving}
            >
              Save
            </Button>
          </div>
        </div>
      )}
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
  const [openConfigId, setOpenConfigId] = useState<string | null>(null);
  const enabledCount = enabledScrapers.size;
  const totalCount = scrapers.length;

  function handleGearClick(e: React.MouseEvent, scraperId: string) {
    e.stopPropagation();
    setOpenConfigId((prev) => (prev === scraperId ? null : scraperId));
  }

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
              {scrapers.map((scraper, i) => {
                const isConfigurable = CONFIGURABLE_SCRAPERS.has(scraper.id);
                const isConfigOpen = openConfigId === scraper.id;
                const isLast = i === scrapers.length - 1;
                return (
                  <div key={scraper.id}>
                    <div
                      className={`flex items-center justify-between py-3 ${
                        !isLast || isConfigOpen ? "border-b border-border" : ""
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
                      <div className="flex items-center gap-2 shrink-0">
                        {isConfigurable && (
                          <button
                            type="button"
                            title="Configure"
                            onClick={(e) => handleGearClick(e, scraper.id)}
                            className={`p-1 rounded-md transition-colors ${
                              isConfigOpen
                                ? "text-accent bg-accent-subtle"
                                : "text-muted hover:text-foreground hover:bg-bg-2"
                            }`}
                          >
                            <Settings2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <Toggle
                          checked={enabledScrapers.has(scraper.id)}
                          onChange={(checked) => onToggle(scraper.id, checked)}
                        />
                      </div>
                    </div>
                    {isConfigOpen && (
                      <GithubSearchConfigForm
                        scraperId={scraper.id}
                        onClose={() => setOpenConfigId(null)}
                      />
                    )}
                  </div>
                );
              })}
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
      window.dispatchEvent(new Event("features-changed"));
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
      window.dispatchEvent(new Event("features-changed"));
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
      window.dispatchEvent(new Event("features-changed"));
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
