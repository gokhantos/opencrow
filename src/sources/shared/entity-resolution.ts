/**
 * Cross-source corroboration / entity resolution.
 *
 * Given heterogeneous source rows (GitHub repos, X handles, app-store apps,
 * package mentions, generic URLs, free-text themes) this module groups rows
 * that refer to the SAME real-world entity, then counts how many DISTINCT
 * sources corroborate each entity.
 *
 * Resolution runs in two stages:
 *   1. DETERMINISTIC key-join (always on, no network): normalize each row to a
 *      stable entity key derived from a strong identifier — URL domain, GitHub
 *      `owner/repo`, package name, or social handle. Rows that share a key are
 *      collapsed into one entity. This path is fully unit-testable.
 *   2. OPTIONAL embedding name-match (off by default): for rows that only
 *      carry a free-text name/title, an injected `embed` function may be used
 *      to merge near-duplicate names. The embed function is injected so the
 *      module stays pure and the deterministic path needs no network.
 *
 * "Distinct source" is judged by the row's `source` field (e.g. "github",
 * "reddit", "x") — two rows from the same source mentioning the same entity
 * count as a single corroboration, while the same entity seen on github AND
 * reddit counts as two.
 */

import { createLogger } from "../../logger";

const log = createLogger("sources:entity-resolution");

// ── Input / output shapes ────────────────────────────────────────────────────

/**
 * Minimal row shape consumed by the resolver. Source collectors map their
 * native rows onto this before calling in. All identifier fields are optional;
 * the resolver uses whichever strong identifier is present, falling back to a
 * normalized name/title.
 */
export interface EntityRow {
  /** Stable per-row id (used to key the corroboration map back to callers). */
  readonly id: string;
  /** Originating source, e.g. "github", "reddit", "x", "appstore". */
  readonly source: string;
  /** Canonical link, if any. Its registrable domain is a resolution key. */
  readonly url?: string | null;
  /** GitHub "owner/repo" (or a bare repo name). */
  readonly fullName?: string | null;
  /** Package identifier (npm/pypi name, app bundle id, …). */
  readonly packageName?: string | null;
  /** Social handle (X/Twitter/GitHub user), with or without a leading "@". */
  readonly handle?: string | null;
  /** Human-readable name/title — fallback key + embedding-match input. */
  readonly name?: string | null;
}

/** One resolved cluster of rows that all refer to the same entity. */
export interface ResolvedEntity {
  /** Deterministic entity key (e.g. "github:owner/repo", "domain:example.com"). */
  readonly key: string;
  /** Row ids that resolved into this entity. */
  readonly rowIds: readonly string[];
  /** Distinct originating sources that mention this entity. */
  readonly sources: readonly string[];
  /** Convenience: count of distinct sources (corroboration strength). */
  readonly distinctSourceCount: number;
}

export interface ResolveResult {
  /** All resolved entities, keyed by entity key. */
  readonly entities: ReadonlyMap<string, ResolvedEntity>;
  /** entity-key → distinct-source-count. */
  readonly sourceCountByKey: ReadonlyMap<string, number>;
  /** row-id → corroboration_count (distinct sources for that row's entity). */
  readonly corroborationByRowId: ReadonlyMap<string, number>;
}

/** Injected embedding function. Returns one vector per input text, in order. */
export type EmbedFn = (texts: readonly string[]) => Promise<readonly (readonly number[])[]>;

export interface ResolveOptions {
  /**
   * Optional embedding function enabling the second-stage name-match. When
   * omitted, only the deterministic key-join runs (default, network-free).
   */
  readonly embed?: EmbedFn;
  /**
   * Cosine-similarity threshold above which two name-only entities are merged.
   * Only consulted when `embed` is provided.
   */
  readonly nameMatchThreshold?: number;
}

const DEFAULT_NAME_MATCH_THRESHOLD = 0.86;

// ── Normalization helpers (pure, exported for unit tests) ─────────────────────

/** Lowercase, collapse whitespace, strip surrounding punctuation. */
export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s\W_]+|[\s\W_]+$/g, "")
    .trim();
}

/**
 * Extract the registrable-ish domain from a URL.
 *
 * Strips protocol, `www.`/`m.` prefixes, port, path, query and fragment, and
 * lowercases. Returns `null` for unparseable or empty input. Bare hostnames
 * (no scheme) are tolerated by prefixing a synthetic scheme.
 */
export function normalizeDomain(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  const candidate = /^[a-z][\w+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let host: string;
  try {
    host = new URL(candidate).hostname;
  } catch {
    return null;
  }

  const cleaned = host
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^(?:www|m|mobile|amp)\./, "");

  return cleaned || null;
}

/**
 * Normalize a social handle to a bare lowercase handle (no leading "@",
 * no surrounding URL). Accepts "@foo", "foo", or a profile URL like
 * "https://twitter.com/foo" / "https://github.com/foo".
 */
export function normalizeHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (!value) return null;

  // If it's a URL, take the first path segment as the handle.
  if (/^[a-z][\w+.-]*:\/\//i.test(value) || /^[\w.-]+\.[a-z]{2,}\//i.test(value)) {
    const domain = normalizeDomain(value);
    try {
      const url = new URL(/:\/\//.test(value) ? value : `https://${value}`);
      const seg = url.pathname.split("/").filter(Boolean)[0];
      value = seg ?? "";
    } catch {
      value = "";
    }
    // Guard: a bare domain with no path is not a handle.
    if (!value && domain) return null;
  }

  const cleaned = value
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "");

  return cleaned || null;
}

/**
 * Normalize a GitHub "owner/repo" string to lowercase `owner/repo`. Strips a
 * GitHub URL wrapper and trailing `.git`. Returns `null` if it cannot form a
 * two-part path. A bare repo name (no slash) is treated as not-resolvable here
 * (callers should pass it via `name` instead).
 */
export function normalizeFullName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (!value) return null;

  if (/github\.com/i.test(value)) {
    const match = value.match(/github\.com[/:]+([^/]+)\/([^/?#]+)/i);
    if (match) value = `${match[1]}/${match[2]}`;
  }

  value = value.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  const parts = value.split("/").filter(Boolean);
  if (parts.length < 2) return null;

  const owner = parts[0]!.toLowerCase().replace(/[^a-z0-9_.-]/g, "");
  const name = parts[1]!.toLowerCase().replace(/[^a-z0-9_.-]/g, "");
  if (!owner || !name) return null;

  return `${owner}/${name}`;
}

/** Normalize a package identifier to a lowercase, scope-preserving key. */
export function normalizePackageName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase().replace(/^\/+|\/+$/g, "");
  if (!value) return null;
  // Keep npm scopes (@scope/name), bundle-id dots, hyphens, underscores.
  const cleaned = value.replace(/[^a-z0-9_.\-/@]/g, "");
  return cleaned || null;
}

/**
 * Derive the deterministic entity key for a row using the strongest available
 * identifier, in priority order:
 *   github full_name > package name > handle > url domain > normalized name.
 * Returns `null` when no usable identifier exists (row stays unresolved).
 */
export function entityKeyForRow(row: EntityRow): string | null {
  const full = normalizeFullName(row.fullName);
  if (full) return `github:${full}`;

  const pkg = normalizePackageName(row.packageName);
  if (pkg) return `package:${pkg}`;

  const handle = normalizeHandle(row.handle);
  if (handle) return `handle:${handle}`;

  const domain = normalizeDomain(row.url);
  if (domain) return `domain:${domain}`;

  const name = row.name ? normalizeText(row.name) : "";
  if (name) return `name:${name}`;

  return null;
}

// ── Deterministic resolution ──────────────────────────────────────────────────

interface MutableCluster {
  key: string;
  rowIds: string[];
  sources: Set<string>;
}

function deterministicClusters(
  rows: readonly EntityRow[],
): Map<string, MutableCluster> {
  const clusters = new Map<string, MutableCluster>();

  for (const row of rows) {
    let key: string | null;
    try {
      key = entityKeyForRow(row);
    } catch (err) {
      log.warn("entityKeyForRow failed; skipping row", {
        rowId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!key) continue;

    const existing = clusters.get(key);
    if (existing) {
      // Build a NEW cluster object (no mutation of the shared map value).
      clusters.set(key, {
        key,
        rowIds: [...existing.rowIds, row.id],
        sources: new Set([...existing.sources, row.source]),
      });
    } else {
      clusters.set(key, {
        key,
        rowIds: [row.id],
        sources: new Set([row.source]),
      });
    }
  }

  return clusters;
}

// ── Optional embedding name-match (second stage) ──────────────────────────────

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Merge name-only clusters whose names embed close together. Returns a NEW map;
 * the input is never mutated. Clusters keyed by a strong identifier (github:/
 * package:/handle:/domain:) are left untouched — only `name:` clusters merge.
 */
async function mergeByEmbedding(
  clusters: Map<string, MutableCluster>,
  embed: EmbedFn,
  threshold: number,
): Promise<Map<string, MutableCluster>> {
  const nameKeys = [...clusters.keys()].filter((k) => k.startsWith("name:"));
  if (nameKeys.length < 2) return clusters;

  let vectors: readonly (readonly number[])[];
  try {
    vectors = await embed(nameKeys.map((k) => k.slice("name:".length)));
  } catch (err) {
    log.warn("embedding name-match failed; using deterministic result only", {
      error: err instanceof Error ? err.message : String(err),
    });
    return clusters;
  }

  if (vectors.length !== nameKeys.length) {
    log.warn("embedding count mismatch; skipping name-match", {
      expected: nameKeys.length,
      received: vectors.length,
    });
    return clusters;
  }

  // Union-find over name clusters by cosine similarity.
  const parent = new Map<string, string>();
  for (const k of nameKeys) parent.set(k, k);
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (let i = 0; i < nameKeys.length; i++) {
    for (let j = i + 1; j < nameKeys.length; j++) {
      const sim = cosineSimilarity(vectors[i]!, vectors[j]!);
      if (sim >= threshold) union(nameKeys[i]!, nameKeys[j]!);
    }
  }

  // Rebuild the cluster map, collapsing unioned name clusters into their root.
  const result = new Map<string, MutableCluster>();
  for (const [key, cluster] of clusters) {
    if (!key.startsWith("name:")) {
      result.set(key, cluster);
      continue;
    }
    const root = find(key);
    const existing = result.get(root);
    if (existing) {
      result.set(root, {
        key: root,
        rowIds: [...existing.rowIds, ...cluster.rowIds],
        sources: new Set([...existing.sources, ...cluster.sources]),
      });
    } else {
      result.set(root, { ...cluster, key: root, sources: new Set(cluster.sources) });
    }
  }

  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve rows into entities and compute corroboration.
 *
 * Always performs the deterministic key-join. If `options.embed` is supplied,
 * a second name-match pass merges near-duplicate name-only entities. Failures
 * in the optional pass degrade gracefully to the deterministic result.
 */
export async function resolveEntities(
  rows: readonly EntityRow[],
  options: ResolveOptions = {},
): Promise<ResolveResult> {
  if (rows.length === 0) {
    return {
      entities: new Map(),
      sourceCountByKey: new Map(),
      corroborationByRowId: new Map(),
    };
  }

  let clusters = deterministicClusters(rows);

  if (options.embed) {
    clusters = await mergeByEmbedding(
      clusters,
      options.embed,
      options.nameMatchThreshold ?? DEFAULT_NAME_MATCH_THRESHOLD,
    );
  }

  const entities = new Map<string, ResolvedEntity>();
  const sourceCountByKey = new Map<string, number>();
  const corroborationByRowId = new Map<string, number>();

  for (const [key, cluster] of clusters) {
    const sources = [...cluster.sources].sort();
    const distinctSourceCount = sources.length;
    entities.set(key, {
      key,
      rowIds: [...cluster.rowIds],
      sources,
      distinctSourceCount,
    });
    sourceCountByKey.set(key, distinctSourceCount);
    for (const rowId of cluster.rowIds) {
      corroborationByRowId.set(rowId, distinctSourceCount);
    }
  }

  return { entities, sourceCountByKey, corroborationByRowId };
}

/**
 * Convenience: deterministic-only distinct-source counts per entity key.
 *
 * Equivalent to `resolveEntities(rows)` with no embedding pass, returning just
 * the entity-key → distinct-source-count map. Synchronous-friendly callers that
 * only need corroboration tallies can use this.
 */
export async function corroborationCounts(
  rows: readonly EntityRow[],
  options: ResolveOptions = {},
): Promise<ReadonlyMap<string, number>> {
  const { sourceCountByKey } = await resolveEntities(rows, options);
  return sourceCountByKey;
}
