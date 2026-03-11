import type { MemorySourceKind } from "./types";

/** Half-life in days — after this many days, the temporal decay factor is 0.5 */
const halfLifeDays: Record<MemorySourceKind, number> = {
  x_post: 7,
  conversation: 14,
  reddit_post: 30,
  reuters_news: 60,
  cointelegraph_news: 60,
  cryptopanic_news: 60,
  investingnews_news: 60,
  hackernews_story: 60,
  producthunt_product: 90,
  github_repo: 90,
  note: 180,
  document: 180,
  observation: 60,
  idea: 120,
  appstore_review: 60,
  appstore_ranking: 30,
  playstore_review: 60,
  playstore_ranking: 30,
};

export function getTemporalHalfLife(kind: MemorySourceKind): number {
  return halfLifeDays[kind];
}
