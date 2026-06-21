import type { SQL } from "bun";
import { z } from "zod";
import { createLogger } from "../../logger";

const log = createLogger("recall-harness-corpus");

type Db = InstanceType<typeof SQL>;

/**
 * One corpus item the harness dual-writes into both backends.
 *
 * `harnessItemId` is the stable cross-backend join key. It is injected into the
 * item's metadata under the reserved `harness_item_id` key before indexing, so a
 * backend that round-trips caller metadata (Qdrant) surfaces it on search
 * results; backends that don't (mem0) are matched by content hash instead (see
 * `runner.ts`). Every item is indexed as a `note` so both backends chunk it with
 * the identical `buildNoteChunks` path — byte-identical chunk text is what makes
 * the content-hash fallback reliable.
 */
export interface CorpusItem {
  readonly harnessItemId: string;
  readonly content: string;
  /** Extra string metadata passed through to the backend (context only). */
  readonly metadata: Readonly<Record<string, string>>;
}

/** Reserved metadata key carrying the cross-backend join id. */
export const HARNESS_ITEM_ID_KEY = "harness_item_id";

/**
 * JSONL fixture line schema. `kind` is advisory (recorded into metadata for
 * traceability); the harness always indexes via `indexNote`, so `kind` does not
 * change the write path. `metadata` is optional string→string passthrough.
 */
const fixtureItemSchema = z.object({
  kind: z.string().min(1).optional(),
  content: z.string().min(1),
  metadata: z.record(z.string(), z.string()).optional(),
});

/**
 * Parse a JSONL fixture into corpus items. Blank lines are skipped; a malformed
 * line throws with its line number so the operator can fix the fixture. Each
 * item gets a deterministic `harness_item_id` derived from its position
 * (`item-<n>`), so a given fixture always yields the same ids.
 */
export function parseFixtureCorpus(jsonl: string): readonly CorpusItem[] {
  const lines = jsonl.split("\n");
  const items: CorpusItem[] = [];
  let index = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]?.trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Invalid JSON on fixture line ${i + 1}: ${(err as Error).message}`,
      );
    }
    const result = fixtureItemSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Invalid fixture item on line ${i + 1}: ${result.error.message}`,
      );
    }
    const harnessItemId = `item-${index}`;
    index += 1;
    const baseMeta = result.data.metadata ?? {};
    items.push({
      harnessItemId,
      content: result.data.content,
      metadata: {
        ...baseMeta,
        ...(result.data.kind ? { harness_kind: result.data.kind } : {}),
        [HARNESS_ITEM_ID_KEY]: harnessItemId,
      },
    });
  }
  return items;
}

/** Load + parse a JSONL fixture file from disk. */
export async function loadFixtureCorpus(
  filePath: string,
): Promise<readonly CorpusItem[]> {
  const text = await Bun.file(filePath).text();
  const items = parseFixtureCorpus(text);
  log.info("Loaded fixture corpus", { filePath, items: items.length });
  return items;
}

interface ReviewRow {
  readonly id: string;
  readonly app_name: string;
  readonly title: string;
  readonly content: string;
  readonly rating: number;
}

interface StoryRow {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly points: number;
}

/** Build a corpus item from a raw text blob + provenance metadata. */
function makeDbItem(
  ordinal: number,
  table: string,
  rowId: string,
  content: string,
  extra: Readonly<Record<string, string>>,
): CorpusItem {
  const harnessItemId = `db-${table}-${ordinal}`;
  return {
    harnessItemId,
    content,
    metadata: {
      ...extra,
      harness_source_table: table,
      harness_row_id: rowId,
      [HARNESS_ITEM_ID_KEY]: harnessItemId,
    },
  };
}

/**
 * Sample up to `sample` recent rows from a couple of existing source tables
 * (app-store reviews + Hacker News stories) and map them to corpus items.
 *
 * Read-only: SELECTs only, ordered by the table's own recency column. Rows with
 * empty text after trimming are skipped so the backends never index blanks. The
 * sample is split evenly across the two tables. This path needs a live Postgres
 * with scraped data; an empty result is logged and returned as `[]` rather than
 * throwing, so the caller can fall back to the fixture corpus.
 */
export async function loadDbCorpus(
  db: Db,
  sample: number,
): Promise<readonly CorpusItem[]> {
  const perTable = Math.max(1, Math.floor(sample / 2));
  const items: CorpusItem[] = [];

  const reviewRows = (await db`
    SELECT id, app_name, title, content, rating
    FROM appstore_reviews
    WHERE content <> ''
    ORDER BY first_seen_at DESC
    LIMIT ${perTable}
  `) as ReviewRow[];
  reviewRows.forEach((r, i) => {
    const text = `${r.app_name} review (${r.rating}/5): ${r.title}\n${r.content}`.trim();
    if (text.length === 0) return;
    items.push(
      makeDbItem(i, "appstore_reviews", r.id, text, {
        harness_kind: "appstore_review",
        app_name: r.app_name,
        rating: String(r.rating),
      }),
    );
  });

  const storyRows = (await db`
    SELECT id, title, description, points
    FROM hn_stories
    WHERE title <> ''
    ORDER BY first_seen_at DESC
    LIMIT ${perTable}
  `) as StoryRow[];
  storyRows.forEach((s, i) => {
    const text = `${s.title}\n${s.description}`.trim();
    if (text.length === 0) return;
    items.push(
      makeDbItem(i, "hn_stories", s.id, text, {
        harness_kind: "hackernews_story",
        points: String(s.points),
      }),
    );
  });

  log.info("Loaded db-sample corpus", {
    sample,
    items: items.length,
    reviews: reviewRows.length,
    stories: storyRows.length,
  });
  if (items.length === 0) {
    log.warn("db-sample corpus is empty — no rows in source tables");
  }
  return items;
}

const querySetSchema = z.object({
  queries: z.array(z.string().min(1)).min(1),
});

/**
 * Load a query set. Supports either a JSON `{ "queries": [...] }` document or a
 * plain newline-delimited list of query strings (blank lines skipped). Throws if
 * the file yields zero queries.
 */
export async function loadQuerySet(
  filePath: string,
): Promise<readonly string[]> {
  const text = (await Bun.file(filePath).text()).trim();
  if (text.startsWith("{")) {
    const parsed: unknown = JSON.parse(text);
    const result = querySetSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Invalid query set JSON: ${result.error.message}`);
    }
    return result.data.queries;
  }
  const queries = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (queries.length === 0) {
    throw new Error(`Query set file is empty: ${filePath}`);
  }
  return queries;
}
