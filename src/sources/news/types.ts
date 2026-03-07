export interface NewsArticle {
  readonly id: string;
  readonly source_name: string;
  readonly title: string;
  readonly url: string;
  readonly url_hash: string;
  readonly published_at: string;
  readonly category: string;
  readonly summary: string;
  readonly body: string | null;
  readonly sentiment: string;
  readonly image_url: string;
  readonly currencies_json: string;
  readonly source_id: string;
  readonly source_domain: string;
  readonly section: string;
  readonly extra_json: string;
  readonly scraped_at: number;
  readonly created_at: number;
}

export interface CalendarEvent {
  readonly id: string;
  readonly event_name: string;
  readonly country: string;
  readonly currency: string;
  readonly importance: string;
  readonly event_datetime: string;
  readonly actual: string;
  readonly forecast: string;
  readonly previous: string;
  readonly source_url: string;
  readonly scraped_at: number;
  readonly created_at: number;
}

export interface ScraperRunRecord {
  readonly id: string;
  readonly source_name: string;
  readonly status: "ok" | "error" | "timeout";
  readonly articles_found: number;
  readonly articles_new: number;
  readonly duration_ms: number;
  readonly error: string | null;
  readonly started_at: number;
  readonly created_at: number;
}

export type NewsSource =
  | "cryptopanic"
  | "cointelegraph"
  | "reuters"
  | "investing_news"
  | "investing_calendar";

export interface ScraperResult {
  readonly source: NewsSource;
  readonly articles: ReadonlyArray<RawArticle>;
}

export interface RawArticle {
  readonly source_name: string;
  readonly title: string;
  readonly url: string;
  readonly published_at?: string;
  readonly category?: string;
  readonly summary?: string;
  readonly body?: string;
  readonly sentiment?: string;
  readonly image_url?: string;
  readonly currencies?: readonly string[];
  readonly source_id?: string;
  readonly source_domain?: string;
  readonly section?: string;
  readonly extra?: Record<string, string>;
}

export interface RawCalendarEvent {
  readonly event_name: string;
  readonly country?: string;
  readonly currency?: string;
  readonly importance?: string;
  readonly event_datetime?: string;
  readonly actual?: string;
  readonly forecast?: string;
  readonly previous?: string;
  readonly source_url?: string;
}
