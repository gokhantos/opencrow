import React, { useState, useEffect } from "react";
import { apiFetch } from "../api";
import { LoadingState, PageHeader, Toggle, Button } from "../components";
import { useToast } from "../components/Toast";
import {
  Database,
  TrendingUp,
  Rss,
  ChevronRight,
  ChevronDown,
  Circle,
  Settings as SettingsIcon,
  Settings2,
} from "lucide-react";

interface ScraperMeta {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

interface FieldDef {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly min: number;
  readonly max: number;
  readonly defaultValue: number;
}

const SCRAPER_FIELDS: Readonly<Record<string, readonly FieldDef[]>> = {
  hackernews: [
    { key: "intervalMinutes", label: "Scrape interval (min)", description: "How often to scrape", min: 1, max: 1440, defaultValue: 10 },
    { key: "maxStories", label: "Max stories", description: "Number of top stories to fetch", min: 10, max: 200, defaultValue: 60 },
    { key: "commentLimit", label: "Comments per story", description: "Top comments to fetch per story", min: 0, max: 10, defaultValue: 3 },
  ],
  "github-search": [
    { key: "intervalMinutes", label: "Scrape interval (min)", description: "How often to scrape", min: 1, max: 1440, defaultValue: 360 },
    { key: "minStars", label: "Minimum stars", description: "Only include repos with at least this many stars", min: 1, max: 100000, defaultValue: 500 },
    { key: "pushedWithinDays", label: "Pushed within days", description: "Only include repos pushed within this many days", min: 1, max: 90, defaultValue: 7 },
    { key: "maxPages", label: "Max pages", description: "Max pages to fetch (30 repos per page)", min: 1, max: 10, defaultValue: 4 },
  ],
  github: [
    { key: "intervalMinutes", label: "Scrape interval (min)", description: "How often to scrape", min: 10, max: 1440, defaultValue: 720 },
  ],
  reddit: [
    { key: "intervalMinutes", label: "Scrape interval (min)", description: "How often to scrape", min: 5, max: 1440, defaultValue: 30 },
  ],
  producthunt: [
    { key: "intervalMinutes", label: "Scrape interval (min)", description: "How often to scrape", min: 5, max: 1440, defaultValue: 10 },
  ],
  appstore: [
    { key: "intervalMinutes", label: "Scrape interval (min)", description: "How often to scrape", min: 10, max: 1440, defaultValue: 60 },
  ],
  playstore: [
    { key: "intervalMinutes", label: "Scrape interval (min)", description: "How often to scrape", min: 10, max: 1440, defaultValue: 60 },
  ],
  cryptopanic: [
    { key: "intervalMinutes", label: "Scrape interval (min)", description: "How often to scrape", min: 5, max: 1440, defaultValue: 15 },
  ],
  cointelegraph: [
    { key: "intervalMinutes", label: "Scrape interval (min)", description: "How often to scrape", min: 10, max: 1440, defaultValue: 30 },
  ],
  reuters: [
    { key: "intervalMinutes", label: "Scrape interval (min)", description: "How often to scrape", min: 10, max: 1440, defaultValue: 60 },
  ],
  investing_news: [
    { key: "intervalMinutes", label: "Scrape interval (min)", description: "How often to scrape", min: 10, max: 1440, defaultValue: 60 },
  ],
  investing_calendar: [
    { key: "intervalMinutes", label: "Scrape interval (min)", description: "How often to scrape", min: 30, max: 1440, defaultValue: 120 },
  ],
};

const CONFIGURABLE_SCRAPERS = new Set(Object.keys(SCRAPER_FIELDS));

// Maps scraper ID → the memory source kind(s) for chunk profile config
// Only include kinds that benefit from content-limit tuning
const SCRAPER_TO_CHUNK_KINDS: Readonly<Record<string, readonly string[]>> = {
  hackernews: ["hackernews_story"],
  "github-search": ["github_repo"],
  github: ["github_repo"],
  reddit: ["reddit_post"],
  producthunt: ["producthunt_product"],
  appstore: ["appstore_review", "appstore_app"],
  playstore: ["playstore_review", "playstore_app"],
  cryptopanic: ["cryptopanic_news"],
  cointelegraph: ["cointelegraph_news"],
  reuters: ["reuters_news"],
  investing_news: ["investingnews_news"],
};

// Which kinds have contentMaxChars / commentMaxChars fields
const KINDS_WITH_CONTENT_MAX = new Set([
  "hackernews_story",
  "reddit_post",
  "github_repo",
  "reuters_news",
  "cointelegraph_news",
  "cryptopanic_news",
  "investingnews_news",
  "idea",
]);
const KINDS_WITH_COMMENT_MAX = new Set(["hackernews_story", "reddit_post"]);

interface ChunkProfile {
  readonly maxTokens: number;
  readonly overlap: number;
  readonly contentMaxChars?: number;
  readonly commentMaxChars?: number;
}

function getDefaults(scraperId: string): Record<string, number> {
  const fields = SCRAPER_FIELDS[scraperId] ?? [];
  return Object.fromEntries(fields.map((f) => [f.key, f.defaultValue]));
}

interface EmbeddingsConfig {
  readonly provider: "openrouter";
  readonly dimensions: number;
  readonly openrouterModel: string;
  readonly batchSize: number;
}

interface FeaturesResponse {
  readonly scrapers: {
    readonly available: readonly ScraperMeta[];
    readonly enabled: readonly string[];
  };
  readonly qdrant: { readonly enabled: boolean };
  readonly market: { readonly enabled: boolean };
  readonly embeddings: EmbeddingsConfig;
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

/* ── Chunk profile form for a single kind ── */
function ChunkProfileForm({
  kind,
}: {
  readonly kind: string;
}) {
  const { success, error: toastError } = useToast();
  const [profile, setProfile] = useState<ChunkProfile | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ data: ChunkProfile }>(`/api/features/chunk-profiles/${kind}`)
      .then((res) => { if (!cancelled) setProfile(res.data); })
      .catch(() => { if (!cancelled) toastError(`Failed to load chunk profile for ${kind}.`); });
    return () => { cancelled = true; };
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    if (!profile) return;
    setSaving(true);
    try {
      await apiFetch(`/api/features/chunk-profiles/${kind}`, {
        method: "PUT",
        body: JSON.stringify(profile),
      });
      success("Chunk profile saved.");
    } catch {
      toastError("Failed to save chunk profile.");
    } finally {
      setSaving(false);
    }
  }

  if (!profile) return <p className="text-xs text-muted py-1">Loading…</p>;

  const hasContent = KINDS_WITH_CONTENT_MAX.has(kind);
  const hasComment = KINDS_WITH_COMMENT_MAX.has(kind);

  return (
    <div className="flex flex-col gap-2 pt-1">
      <div className="text-xs font-medium text-muted uppercase tracking-wide mb-1">
        {kind.replace(/_/g, " ")} — Embedding Profile
      </div>
      <ConfigField
        label="Chunk size (tokens)"
        description="Max tokens per text chunk sent to embedder"
        value={profile.maxTokens}
        min={50}
        max={2000}
        onChange={(v) => setProfile((p) => p ? { ...p, maxTokens: v } : p)}
      />
      <ConfigField
        label="Chunk overlap (tokens)"
        description="Token overlap between adjacent chunks"
        value={profile.overlap}
        min={0}
        max={Math.floor(profile.maxTokens / 2)}
        onChange={(v) => setProfile((p) => p ? { ...p, overlap: v } : p)}
      />
      {hasContent && (
        <ConfigField
          label="Max content length (chars)"
          description="Truncate content body before chunking"
          value={profile.contentMaxChars ?? 400}
          min={100}
          max={20000}
          onChange={(v) => setProfile((p) => p ? { ...p, contentMaxChars: v } : p)}
        />
      )}
      {hasComment && (
        <ConfigField
          label="Max comment length (chars)"
          description="Truncate each comment before chunking"
          value={profile.commentMaxChars ?? 800}
          min={50}
          max={5000}
          onChange={(v) => setProfile((p) => p ? { ...p, commentMaxChars: v } : p)}
        />
      )}
      <div className="flex justify-end pt-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSave}
          disabled={saving}
          loading={saving}
        >
          Save profile
        </Button>
      </div>
    </div>
  );
}

/* ── Generic scraper config form ── */
function ScraperConfigForm({
  scraperId,
  onClose,
}: {
  readonly scraperId: string;
  readonly onClose: () => void;
}) {
  const { success, error: toastError } = useToast();
  const fields = SCRAPER_FIELDS[scraperId] ?? [];
  const chunkKinds = SCRAPER_TO_CHUNK_KINDS[scraperId] ?? [];
  const [config, setConfig] = useState<Record<string, number>>(getDefaults(scraperId));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ data: Record<string, number> }>(
          `/api/features/scraper-config/${scraperId}`,
        );
        if (!cancelled) setConfig(res.data);
      } catch {
        if (!cancelled) toastError("Failed to load scraper config.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
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
          {fields.map((f) => (
            <ConfigField
              key={f.key}
              label={f.label}
              description={f.description}
              value={config[f.key] ?? f.defaultValue}
              min={f.min}
              max={f.max}
              onChange={(v) => setConfig((prev) => ({ ...prev, [f.key]: v }))}
            />
          ))}
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

          {chunkKinds.length > 0 && (
            <div className="border-t border-border pt-3 flex flex-col gap-4">
              {chunkKinds.map((kind) => (
                <ChunkProfileForm key={kind} kind={kind} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


/* ── Text config field ── */
function TextConfigField({
  label,
  description,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly placeholder?: string;
  readonly type?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">{label}</div>
        <div className="text-xs text-muted mt-0.5">{description}</div>
      </div>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-56 shrink-0 bg-bg-2 border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:border-accent"
      />
    </div>
  );
}


/* ── Embeddings config section (shown under Qdrant card when expanded) ── */
function EmbeddingsSection({
  config,
  onSave,
}: {
  readonly config: EmbeddingsConfig;
  readonly onSave: (config: EmbeddingsConfig) => void;
}) {
  const { success, error: toastError } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<EmbeddingsConfig>(config);
  const [saving, setSaving] = useState(false);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(config);

  function update<K extends keyof EmbeddingsConfig>(
    key: K,
    value: EmbeddingsConfig[K],
  ) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      await apiFetch("/api/features/embeddings", {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      onSave(draft);
      window.dispatchEvent(new Event("features-changed"));
      success("Embeddings config saved.");
    } catch {
      toastError("Failed to save embeddings config.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 ml-[50px]">
      <button
        type="button"
        className="flex items-center gap-1.5 text-xs text-muted hover:text-foreground bg-transparent border-none cursor-pointer p-0"
        onClick={() => setExpanded((p) => !p)}
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronRight className="w-3 h-3" />
        )}
        <span>Embeddings Configuration</span>
        {isDirty && (
          <span className="text-xs font-medium text-warning bg-warning-subtle px-1.5 py-0.5 rounded-full ml-1">
            Unsaved
          </span>
        )}
      </button>

      {expanded && (
        <div className="mt-2 bg-bg-2 border border-border rounded-lg p-3 flex flex-col gap-3">
          <TextConfigField
            label="OpenRouter Model"
            description="Model ID on OpenRouter"
            value={draft.openrouterModel}
            onChange={(v) => update("openrouterModel", v)}
            placeholder="openai/text-embedding-3-small"
          />

          <ConfigField
            label="Dimensions"
            description="Vector embedding dimensions (must match Qdrant collection)"
            value={draft.dimensions}
            min={32}
            max={4096}
            onChange={(v) => update("dimensions", v)}
          />

          <ConfigField
            label="Batch Size"
            description="Max texts per API batch"
            value={draft.batchSize}
            min={1}
            max={256}
            onChange={(v) => update("batchSize", v)}
          />

          {isDirty && (
            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDraft(config)}
                disabled={saving}
              >
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
  const [savingScrapers, setSavingScrapers] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [openConfigId, setOpenConfigId] = useState<string | null>(null);
  const [qdrantSaving, setQdrantSaving] = useState(false);
  const [marketSaving, setMarketSaving] = useState(false);
  const [embeddingsConfig, setEmbeddingsConfig] =
    useState<EmbeddingsConfig | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ data: FeaturesResponse }>("/api/features");
        if (cancelled) return;
        setFeatures(res.data);
        setEnabledScrapers(new Set(res.data.scrapers.enabled));
        setEmbeddingsConfig(res.data.embeddings);
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

  async function handleScraperToggle(id: string, checked: boolean) {
    const next = new Set(enabledScrapers);
    if (checked) {
      next.add(id);
    } else {
      next.delete(id);
    }
    setEnabledScrapers(next);
    setSavingScrapers((prev) => new Set([...prev, id]));

    try {
      await apiFetch("/api/features/scrapers", {
        method: "PUT",
        body: JSON.stringify({ enabled: [...next] }),
      });
      window.dispatchEvent(new Event("features-changed"));
      const scraper = features?.scrapers.available.find((s) => s.id === id);
      success(`${scraper?.name ?? id} ${checked ? "enabled" : "disabled"}.`);
    } catch {
      // Revert on failure
      setEnabledScrapers(enabledScrapers);
      toastError("Failed to save scraper setting.");
    } finally {
      setSavingScrapers((prev) => {
        const s = new Set(prev);
        s.delete(id);
        return s;
      });
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
        {/* Qdrant + Embeddings */}
        <div className="bg-bg-1 border border-border rounded-xl p-5 transition-all duration-200 hover:border-border-hover">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3.5 min-w-0">
              <div className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center bg-accent-subtle text-accent">
                <Database className="w-[18px] h-[18px]" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2.5 mb-1">
                  <h3 className="text-sm font-semibold text-strong m-0">
                    Qdrant (RAG Memory)
                  </h3>
                  <StatusPill enabled={features.qdrant.enabled} />
                </div>
                <p className="text-xs text-muted m-0 leading-relaxed">
                  Vector database for agent long-term memory and semantic search.
                </p>
              </div>
            </div>
            <Toggle
              checked={features.qdrant.enabled}
              onChange={handleQdrantToggle}
              disabled={qdrantSaving}
            />
          </div>
          <div className="mt-3 ml-[50px] text-xs text-faint">
            {features.qdrant.enabled
              ? "Agents can read and write memory via RAG retrieval."
              : "RAG memory is unavailable for all agents."}
          </div>
          {features.qdrant.enabled && embeddingsConfig && (
            <EmbeddingsSection
              config={embeddingsConfig}
              onSave={setEmbeddingsConfig}
            />
          )}
        </div>

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
        <div className="bg-bg-1 border border-border rounded-xl transition-all duration-200 hover:border-border-hover">
          <div className="flex items-center gap-3.5 p-5 pb-0">
            <div className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center bg-pink-subtle text-pink">
              <Rss className="w-[18px] h-[18px]" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2.5 mb-1">
                <h3 className="text-sm font-semibold text-strong m-0">
                  Scrapers
                </h3>
                <span className="text-xs font-medium text-muted bg-bg-2 px-2 py-0.5 rounded-md font-mono">
                  {enabledScrapers.size}/{features.scrapers.available.length}
                </span>
              </div>
              <p className="text-xs text-muted m-0">
                Data scrapers for feeds, social, and market intelligence
              </p>
            </div>
          </div>

          <div className="px-5 pb-5 pt-3">
            {features.scrapers.available.length === 0 ? (
              <p className="text-sm text-muted py-4">
                No scrapers available.
              </p>
            ) : (
              <div className="flex flex-col">
                {features.scrapers.available.map((scraper, i) => {
                  const isConfigurable = CONFIGURABLE_SCRAPERS.has(scraper.id);
                  const isConfigOpen = openConfigId === scraper.id;
                  const isLast = i === features.scrapers.available.length - 1;
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
                              onClick={() =>
                                setOpenConfigId((prev) =>
                                  prev === scraper.id ? null : scraper.id,
                                )
                              }
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
                            onChange={(checked) =>
                              handleScraperToggle(scraper.id, checked)
                            }
                            disabled={savingScrapers.has(scraper.id)}
                          />
                        </div>
                      </div>
                      {isConfigOpen && (
                        <ScraperConfigForm
                          scraperId={scraper.id}
                          onClose={() => setOpenConfigId(null)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
