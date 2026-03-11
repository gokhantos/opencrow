import type { MemorySourceKind } from "./types";

interface ChunkProfile {
  readonly maxTokens: number;
  readonly overlap: number;
}

const profiles: Record<MemorySourceKind, ChunkProfile> = {
  x_post: { maxTokens: 150, overlap: 0 },
  producthunt_product: { maxTokens: 200, overlap: 0 },
  github_repo: { maxTokens: 200, overlap: 0 },
  conversation: { maxTokens: 400, overlap: 80 },
  reddit_post: { maxTokens: 400, overlap: 80 },
  reuters_news: { maxTokens: 500, overlap: 100 },
  cointelegraph_news: { maxTokens: 500, overlap: 100 },
  cryptopanic_news: { maxTokens: 500, overlap: 100 },
  investingnews_news: { maxTokens: 500, overlap: 100 },
  hackernews_story: { maxTokens: 500, overlap: 100 },
  note: { maxTokens: 500, overlap: 100 },
  document: { maxTokens: 500, overlap: 100 },
  observation: { maxTokens: 300, overlap: 50 },
  idea: { maxTokens: 400, overlap: 80 },
  appstore_review: { maxTokens: 200, overlap: 0 },
  appstore_ranking: { maxTokens: 200, overlap: 0 },
  playstore_review: { maxTokens: 200, overlap: 0 },
  playstore_ranking: { maxTokens: 200, overlap: 0 },
};

export function getChunkProfile(kind: MemorySourceKind): ChunkProfile {
  return profiles[kind];
}
