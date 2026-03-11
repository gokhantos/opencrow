import React, { useState, useEffect } from "react";
import { apiFetch } from "../api";
import { PageHeader, LoadingState, EmptyState, Button } from "../components";
import { formatTime, parseJsonArray } from "../lib/format";
import { PHCredentials } from "./ph-accounts/PHCredentials";

const PH_COLOR = "#da552f";

interface PHProduct {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
  readonly url: string;
  readonly website_url: string;
  readonly thumbnail_url: string;
  readonly votes_count: number;
  readonly comments_count: number;
  readonly reviews_count: number;
  readonly reviews_rating: number;
  readonly rank: number | null;
  readonly topics_json: string;
  readonly makers_json: string;
  readonly featured_at: number | null;
  readonly updated_at: number;
}

interface PHStats {
  readonly total_products: number;
  readonly last_updated_at: number | null;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}


function TopicPills({ topicsJson }: { readonly topicsJson: string }) {
  const topics = parseJsonArray<string>(topicsJson);
  if (topics.length === 0) return null;
  return (
    <span className="inline-flex gap-1 flex-wrap">
      {topics.slice(0, 5).map((t) => (
        <span
          key={t}
          className="inline-flex px-1.5 py-0.5 rounded-md bg-accent-subtle text-accent font-mono text-xs font-semibold"
        >
          {t}
        </span>
      ))}
    </span>
  );
}

function ProductCard({ product }: { readonly product: PHProduct }) {
  return (
    <div className="flex gap-4 px-4 py-4 bg-bg-1 rounded-lg transition-colors hover:bg-bg-2">
      {/* Rank badge */}
      {product.rank != null && (
        <div
          className="flex items-start justify-center font-mono font-bold text-base shrink-0 w-7 pt-0.5"
          style={{ color: PH_COLOR }}
        >
          {product.rank}
        </div>
      )}

      {/* Thumbnail */}
      {product.thumbnail_url && (
        <img
          src={product.thumbnail_url}
          alt=""
          className="w-12 h-12 rounded-lg object-cover shrink-0 self-start"
        />
      )}

      {/* Content */}
      <div className="min-w-0 flex-1">
        {/* Name + website */}
        <div className="flex items-start gap-2 flex-wrap">
          <a
            href={product.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-strong no-underline font-semibold leading-snug hover:underline"
          >
            {product.name}
          </a>
          {product.website_url && (
            <a
              href={product.website_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-faint no-underline hover:underline shrink-0 self-center"
            >
              {extractDomain(product.website_url)}
            </a>
          )}
        </div>

        {/* Tagline */}
        {product.tagline && (
          <p className="text-sm text-muted mt-0.5 leading-relaxed">
            {product.tagline}
          </p>
        )}

        {/* Description */}
        {product.description && (
          <p className="text-sm text-faint mt-1 leading-relaxed line-clamp-2 overflow-hidden">
            {product.description}
          </p>
        )}

        {/* Stats row */}
        <div className="flex items-center gap-3 mt-2 flex-wrap text-xs">
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono font-semibold uppercase tracking-wide shrink-0"
            style={{
              background: `${PH_COLOR}18`,
              color: PH_COLOR,
              border: `1px solid ${PH_COLOR}40`,
            }}
          >
            {product.votes_count} upvotes
          </span>

          <span className="text-faint">{product.comments_count} comments</span>

          {product.reviews_count > 0 && (
            <span className="text-faint">
              {product.reviews_count} reviews
              {product.reviews_rating > 0 && (
                <span className="text-warning ml-1">
                  · {product.reviews_rating.toFixed(1)}★
                </span>
              )}
            </span>
          )}

          {product.featured_at != null && (
            <span className="text-faint">
              {new Date(product.featured_at * 1000).toLocaleDateString("en", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          )}
        </div>

        {/* Topics */}
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <TopicPills topicsJson={product.topics_json} />
        </div>
      </div>
    </div>
  );
}

export default function ProductHunt() {
  const [products, setProducts] = useState<readonly PHProduct[]>([]);
  const [stats, setStats] = useState<PHStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [scraping, setScraping] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 5 * 60_000);
    return () => clearInterval(interval);
  }, []);

  async function fetchAll() {
    try {
      const [productsRes, statsRes] = await Promise.all([
        apiFetch<{ success: boolean; data: readonly PHProduct[] }>(
          "/api/ph/products?limit=100",
        ),
        apiFetch<{ success: boolean; data: PHStats }>("/api/ph/products/stats"),
      ]);
      if (productsRes.success) setProducts(productsRes.data);
      if (statsRes.success) setStats(statsRes.data);
    } catch {
      // ignore fetch errors
    } finally {
      setLoading(false);
    }
  }

  async function handleScrapeNow() {
    setScraping(true);
    setError(null);
    try {
      await apiFetch("/api/ph/scrape-now", { method: "POST" });
      await fetchAll();
    } catch {
      setError("Scrape failed. Check API credentials.");
    } finally {
      setScraping(false);
    }
  }

  async function handleBackfillRag() {
    setBackfilling(true);
    setError(null);
    try {
      await apiFetch("/api/ph/backfill-rag", { method: "POST" });
    } catch {
      setError("RAG backfill failed.");
    } finally {
      setBackfilling(false);
    }
  }

  if (loading) {
    return <LoadingState message="Loading..." />;
  }

  return (
    <div>
      <PageHeader
        title="Product Hunt"
        subtitle={
          stats
            ? `${stats.total_products} products · Last updated: ${formatTime(stats.last_updated_at)}`
            : undefined
        }
        actions={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={handleBackfillRag}
              loading={backfilling}
            >
              Backfill RAG
            </Button>
            <Button size="sm" onClick={handleScrapeNow} loading={scraping}>
              Scrape Now
            </Button>
          </div>
        }
      />

      <PHCredentials />

      {error && (
        <div className="mb-4 px-4 py-2 bg-danger-subtle text-danger rounded-lg text-sm">
          {error}
        </div>
      )}

      {products.length === 0 ? (
        <EmptyState description='No products yet. Click "Scrape Now" to fetch.' />
      ) : (
        <div className="flex flex-col gap-1">
          {products.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      )}
    </div>
  );
}
