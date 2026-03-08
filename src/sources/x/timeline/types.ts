export interface TimelineScrapeJob {
  id: string;
  account_id: string;
  max_pages: number;
  sources: string;
  interval_minutes: number;
  status: "running" | "stopped";
  next_run_at: number | null;
  total_scraped: number;
  total_errors: number;
  last_run_at: number | null;
  last_error: string | null;
  languages: string | null;
  created_at: number;
  updated_at: number;
}

export interface TimelineTweetFromPython {
  source: string;
  tweet_id: string;
  author_username: string;
  author_display_name: string;
  author_verified: boolean;
  author_followers: number;
  text: string;
  likes: number;
  retweets: number;
  replies: number;
  views: number;
  bookmarks: number;
  quotes: number;
  has_media: boolean;
  tweet_created_at: number | null;
}

export type TimelineScrapeOutcome =
  | {
      ok: true;
      tweets: TimelineTweetFromPython[];
    }
  | {
      ok: false;
      reason: string;
      detail?: string;
    };
