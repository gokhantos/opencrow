import type { MemorySourceKind } from "./types";

/** Half-life in days — after this many days, the temporal decay factor is 0.5 */
const halfLifeDays: Record<MemorySourceKind, number> = {
  tweet: 7,
  conversation: 14,
  reddit_post: 30,
  article: 60,
  story: 60,
  product: 90,
  github_repo: 90,
  note: 180,
  document: 180,
  observation: 60,
  idea: 120,
  app_review: 60,
  app_ranking: 30,
  trend: 7,
  defi_protocol: 14,
  dex_token: 7,
};

export function getTemporalHalfLife(kind: MemorySourceKind): number {
  return halfLifeDays[kind];
}
