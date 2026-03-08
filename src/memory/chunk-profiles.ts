import type { MemorySourceKind } from "./types";

interface ChunkProfile {
  readonly maxTokens: number;
  readonly overlap: number;
}

const profiles: Record<MemorySourceKind, ChunkProfile> = {
  tweet: { maxTokens: 150, overlap: 0 },
  product: { maxTokens: 200, overlap: 0 },
  hf_model: { maxTokens: 200, overlap: 0 },
  github_repo: { maxTokens: 200, overlap: 0 },
  conversation: { maxTokens: 400, overlap: 80 },
  reddit_post: { maxTokens: 400, overlap: 80 },
  article: { maxTokens: 500, overlap: 100 },
  story: { maxTokens: 500, overlap: 100 },
  note: { maxTokens: 500, overlap: 100 },
  document: { maxTokens: 500, overlap: 100 },
  observation: { maxTokens: 300, overlap: 50 },
  idea: { maxTokens: 400, overlap: 80 },
  app_review: { maxTokens: 200, overlap: 0 },
  app_ranking: { maxTokens: 200, overlap: 0 },
  trend: { maxTokens: 300, overlap: 50 },
  defi_protocol: { maxTokens: 200, overlap: 0 },
  dex_token: { maxTokens: 150, overlap: 0 },
};

export function getChunkProfile(kind: MemorySourceKind): ChunkProfile {
  return profiles[kind];
}
