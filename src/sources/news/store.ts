import { getDb } from "../../store/db";
import type {
  NewsArticle,
  CalendarEvent,
  ScraperRunRecord,
  RawArticle,
  RawCalendarEvent,
} from "./types";

function urlHash(url: string): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(url);
  return hash.digest("hex").slice(0, 32);
}

export async function upsertArticles(articles: readonly RawArticle[]): Promise<{
  found: number;
  inserted: number;
  insertedArticles: readonly RawArticle[];
}> {
  const db = getDb();
  const insertedArticles: RawArticle[] = [];

  for (const article of articles) {
    const id = crypto.randomUUID();
    const hash = urlHash(article.url);
    const now = Math.floor(Date.now() / 1000);

    const result = await db`
      INSERT INTO news_articles (
        id, source_name, title, url, url_hash,
        published_at, category, summary, body, sentiment, image_url,
        currencies_json, source_id, source_domain, section, extra_json,
        scraped_at
      ) VALUES (
        ${id}, ${article.source_name}, ${article.title}, ${article.url}, ${hash},
        ${article.published_at ?? ""}, ${article.category ?? ""}, ${article.summary ?? ""},
        ${article.body ?? null}, ${article.sentiment ?? ""}, ${article.image_url ?? ""},
        ${JSON.stringify(article.currencies ?? [])}, ${article.source_id ?? ""},
        ${article.source_domain ?? ""}, ${article.section ?? ""},
        ${JSON.stringify(article.extra ?? {})},
        ${now}
      )
      ON CONFLICT (url_hash) DO NOTHING
      RETURNING id
    `;

    if (result.length > 0) {
      insertedArticles.push({ ...article, source_id: id });
    }
  }

  return {
    found: articles.length,
    inserted: insertedArticles.length,
    insertedArticles,
  };
}

export async function upsertCalendarEvents(
  events: readonly RawCalendarEvent[],
): Promise<{ found: number; inserted: number }> {
  const db = getDb();
  let inserted = 0;

  for (const event of events) {
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const eventKey = `${event.event_name}:${event.event_datetime ?? ""}:${event.country ?? ""}`;
    const hash = urlHash(eventKey);

    const result = await db`
      INSERT INTO economic_calendar_events (
        id, event_name, country, currency, importance,
        event_datetime, actual, forecast, previous, source_url,
        scraped_at, event_hash
      ) VALUES (
        ${id}, ${event.event_name}, ${event.country ?? ""},
        ${event.currency ?? ""}, ${event.importance ?? "medium"},
        ${event.event_datetime ?? ""}, ${event.actual ?? ""},
        ${event.forecast ?? ""}, ${event.previous ?? ""},
        ${event.source_url ?? ""},
        ${now}, ${hash}
      )
      ON CONFLICT (event_hash) DO UPDATE SET
        actual = EXCLUDED.actual,
        forecast = EXCLUDED.forecast,
        previous = EXCLUDED.previous,
        scraped_at = EXCLUDED.scraped_at
      RETURNING id
    `;

    if (result.length > 0) {
      inserted++;
    }
  }

  return { found: events.length, inserted };
}

export async function getArticles(opts: {
  source?: string;
  limit?: number;
  offset?: number;
}): Promise<readonly NewsArticle[]> {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  if (opts.source) {
    return db`
      SELECT * FROM news_articles
      WHERE source_name = ${opts.source}
      ORDER BY scraped_at DESC
      LIMIT ${limit} OFFSET ${offset}
    ` as Promise<NewsArticle[]>;
  }

  return db`
    SELECT * FROM news_articles
    ORDER BY scraped_at DESC
    LIMIT ${limit} OFFSET ${offset}
  ` as Promise<NewsArticle[]>;
}

export async function getCalendarEvents(opts: {
  limit?: number;
  offset?: number;
}): Promise<readonly CalendarEvent[]> {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  return db`
    SELECT * FROM economic_calendar_events
    ORDER BY scraped_at DESC
    LIMIT ${limit} OFFSET ${offset}
  ` as Promise<CalendarEvent[]>;
}

export async function insertScraperRun(run: {
  source_name: string;
  status: "ok" | "error" | "timeout";
  articles_found: number;
  articles_new: number;
  duration_ms: number;
  error?: string;
  started_at: number;
}): Promise<ScraperRunRecord> {
  const db = getDb();
  const id = crypto.randomUUID();

  const rows = await db`
    INSERT INTO news_scraper_runs (
      id, source_name, status, articles_found, articles_new,
      duration_ms, error, started_at
    ) VALUES (
      ${id}, ${run.source_name}, ${run.status}, ${run.articles_found},
      ${run.articles_new}, ${run.duration_ms}, ${run.error ?? null},
      ${run.started_at}
    )
    RETURNING *
  `;

  return rows[0] as ScraperRunRecord;
}

export async function getScraperRuns(opts: {
  source?: string;
  limit?: number;
}): Promise<readonly ScraperRunRecord[]> {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 20, 100);

  if (opts.source) {
    return db`
      SELECT * FROM news_scraper_runs
      WHERE source_name = ${opts.source}
      ORDER BY started_at DESC
      LIMIT ${limit}
    ` as Promise<ScraperRunRecord[]>;
  }

  return db`
    SELECT * FROM news_scraper_runs
    ORDER BY started_at DESC
    LIMIT ${limit}
  ` as Promise<ScraperRunRecord[]>;
}

export async function getArticleStats(): Promise<
  readonly { source_name: string; count: number; latest_at: number }[]
> {
  const db = getDb();
  return db`
    SELECT source_name, COUNT(*)::int AS count,
      MAX(scraped_at)::int AS latest_at
    FROM news_articles
    GROUP BY source_name
    ORDER BY source_name
  ` as Promise<{ source_name: string; count: number; latest_at: number }[]>;
}

export async function getRecentArticles(opts: {
  hours?: number;
  source?: string;
  limit?: number;
}): Promise<readonly NewsArticle[]> {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 50, 200);
  const cutoff = opts.hours
    ? Math.floor(Date.now() / 1000) - opts.hours * 3600
    : 0;

  if (opts.source && cutoff > 0) {
    return db`
      SELECT * FROM news_articles
      WHERE source_name = ${opts.source} AND scraped_at >= ${cutoff}
      ORDER BY scraped_at DESC
      LIMIT ${limit}
    ` as Promise<NewsArticle[]>;
  }

  if (opts.source) {
    return db`
      SELECT * FROM news_articles
      WHERE source_name = ${opts.source}
      ORDER BY scraped_at DESC
      LIMIT ${limit}
    ` as Promise<NewsArticle[]>;
  }

  if (cutoff > 0) {
    return db`
      SELECT * FROM news_articles
      WHERE scraped_at >= ${cutoff}
      ORDER BY scraped_at DESC
      LIMIT ${limit}
    ` as Promise<NewsArticle[]>;
  }

  return db`
    SELECT * FROM news_articles
    ORDER BY scraped_at DESC
    LIMIT ${limit}
  ` as Promise<NewsArticle[]>;
}

export async function getCalendarEventsFiltered(opts: {
  limit?: number;
  importance?: string;
  currency?: string;
}): Promise<readonly CalendarEvent[]> {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 50, 200);

  if (opts.importance && opts.currency) {
    return db`
      SELECT * FROM economic_calendar_events
      WHERE importance = ${opts.importance} AND currency = ${opts.currency}
      ORDER BY event_datetime DESC
      LIMIT ${limit}
    ` as Promise<CalendarEvent[]>;
  }

  if (opts.importance) {
    return db`
      SELECT * FROM economic_calendar_events
      WHERE importance = ${opts.importance}
      ORDER BY event_datetime DESC
      LIMIT ${limit}
    ` as Promise<CalendarEvent[]>;
  }

  if (opts.currency) {
    return db`
      SELECT * FROM economic_calendar_events
      WHERE currency = ${opts.currency}
      ORDER BY event_datetime DESC
      LIMIT ${limit}
    ` as Promise<CalendarEvent[]>;
  }

  return db`
    SELECT * FROM economic_calendar_events
    ORDER BY event_datetime DESC
    LIMIT ${limit}
  ` as Promise<CalendarEvent[]>;
}
