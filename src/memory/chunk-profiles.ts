import type { MemorySourceKind } from "./types";
import { getOverride } from "../store/config-overrides";

export interface ChunkProfile {
  readonly maxTokens: number;
  readonly overlap: number;
  readonly contentMaxChars?: number;
  readonly commentMaxChars?: number;
}

export const DEFAULT_CHUNK_PROFILES: Record<MemorySourceKind, ChunkProfile> = {
  x_post: { maxTokens: 300, overlap: 0 },
  producthunt_product: { maxTokens: 400, overlap: 0 },
  github_repo: { maxTokens: 400, overlap: 0, contentMaxChars: 1500 },
  conversation: { maxTokens: 400, overlap: 80 },
  reddit_post: { maxTokens: 600, overlap: 100, contentMaxChars: 5000, commentMaxChars: 800 },
  reuters_news: { maxTokens: 800, overlap: 150, contentMaxChars: 400 },
  cointelegraph_news: { maxTokens: 800, overlap: 150, contentMaxChars: 400 },
  cryptopanic_news: { maxTokens: 800, overlap: 150, contentMaxChars: 400 },
  investingnews_news: { maxTokens: 800, overlap: 150, contentMaxChars: 400 },
  hackernews_story: { maxTokens: 800, overlap: 150, commentMaxChars: 800 },
  note: { maxTokens: 500, overlap: 100 },
  document: { maxTokens: 500, overlap: 100 },
  observation: { maxTokens: 500, overlap: 80 },
  idea: { maxTokens: 600, overlap: 100, contentMaxChars: 1500 },
  appstore_review: { maxTokens: 400, overlap: 0 },
  appstore_ranking: { maxTokens: 400, overlap: 0 },
  playstore_review: { maxTokens: 400, overlap: 0 },
  playstore_ranking: { maxTokens: 400, overlap: 0 },
};

export function getChunkProfile(kind: MemorySourceKind): ChunkProfile {
  return DEFAULT_CHUNK_PROFILES[kind];
}

export async function getChunkProfileWithOverrides(
  kind: MemorySourceKind,
  overrides?: Partial<ChunkProfile>,
): Promise<ChunkProfile> {
  const base = DEFAULT_CHUNK_PROFILES[kind];
  const dbOverride = await getOverride("chunk-profiles", kind);
  const dbPartial = dbOverride && typeof dbOverride === "object" ? (dbOverride as Partial<ChunkProfile>) : {};
  return { ...base, ...dbPartial, ...(overrides ?? {}) };
}
