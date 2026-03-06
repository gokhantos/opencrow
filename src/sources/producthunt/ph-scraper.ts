/** ProductHunt daily feed scraper — GraphQL API with OAuth2 client credentials. */

import { z } from "zod";
import { createLogger } from "../../logger";

const log = createLogger("ph-daily");

const TOKEN_URL = "https://api.producthunt.com/v2/oauth/token";
const GRAPHQL_URL = "https://api.producthunt.com/v2/api/graphql";
const MAX_PAGES = 3;
const MAX_RETRY_ATTEMPTS = 3;

// ── Zod schemas ──────────────────────────────────────────────────────────────

const TokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  scope: z.string().optional(),
});

const MakerSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
  headline: z.string().nullable().optional(),
  profileImage: z.string().nullable().optional(),
});

const TopicEdgeSchema = z.object({
  node: z.object({ name: z.string() }),
});

const PostNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  tagline: z.string(),
  description: z.string().nullable().optional(),
  url: z.string(),
  website: z.string().nullable().optional(),
  votesCount: z.number(),
  commentsCount: z.number(),
  reviewsCount: z.number().optional(),
  reviewsRating: z.number().optional(),
  createdAt: z.string().nullable().optional(),
  featuredAt: z.string().nullable().optional(),
  thumbnail: z.object({ url: z.string() }).nullable().optional(),
  makers: z.array(MakerSchema).optional(),
  topics: z
    .object({ edges: z.array(TopicEdgeSchema) })
    .nullable()
    .optional(),
});

const PageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable().optional(),
});

const GraphQLResponseSchema = z.object({
  data: z
    .object({
      posts: z.object({
        edges: z.array(z.object({ node: PostNodeSchema })),
        pageInfo: PageInfoSchema,
      }),
    })
    .optional(),
  errors: z
    .array(z.object({ message: z.string() }))
    .optional(),
});

// ── Public types ─────────────────────────────────────────────────────────────

export interface RawPHMaker {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly headline: string | null;
  readonly avatar_url: string | null;
}

export interface RawPHProduct {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
  readonly url: string;
  readonly website_url: string;
  readonly thumbnail_url: string;
  readonly metrics: {
    readonly votes_count: number;
    readonly comments_count: number;
  };
  readonly makers: readonly RawPHMaker[];
  readonly topics: readonly string[];
  readonly featured_at: string | null;
  readonly created_at: string | null;
  readonly is_featured: boolean;
  readonly reviews_count: number;
  readonly reviews_rating: number;
  readonly rank: number | null;
}

// ── Token exchange ───────────────────────────────────────────────────────────

async function fetchAccessToken(
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });

  if (!res.ok) {
    throw new Error(`Token request failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  const parsed = TokenResponseSchema.parse(json);
  return parsed.access_token;
}

// ── GraphQL fetcher ──────────────────────────────────────────────────────────

const POSTS_QUERY = `
  query FetchPosts($after: String) {
    posts(first: 50, order: RANKING, after: $after) {
      edges {
        node {
          id name slug tagline description url website
          votesCount commentsCount reviewsCount reviewsRating
          createdAt featuredAt
          thumbnail { url }
          makers { id username name headline profileImage }
          topics(first: 10) { edges { node { name } } }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function fetchPostsPage(
  token: string,
  cursor: string | null,
): Promise<{ nodes: z.infer<typeof PostNodeSchema>[]; pageInfo: z.infer<typeof PageInfoSchema> }> {
  const body = JSON.stringify({
    query: POSTS_QUERY,
    variables: cursor ? { after: cursor } : {},
  });

  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body,
  });

  if (!res.ok) {
    throw Object.assign(
      new Error(`GraphQL request failed: ${res.status} ${res.statusText}`),
      { statusCode: res.status },
    );
  }

  const json = await res.json();
  const parsed = GraphQLResponseSchema.parse(json);

  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(`GraphQL errors: ${parsed.errors.map((e) => e.message).join(", ")}`);
  }

  const posts = parsed.data?.posts;
  if (!posts) {
    throw new Error("GraphQL response missing data.posts");
  }

  return {
    nodes: posts.edges.map((e) => e.node),
    pageInfo: posts.pageInfo,
  };
}

// ── Retry with exponential backoff ───────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number = MAX_RETRY_ATTEMPTS,
): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      const statusCode =
        err instanceof Object && "statusCode" in err
          ? (err as { statusCode: number }).statusCode
          : null;

      if (statusCode === 401 || statusCode === 403) {
        throw err;
      }

      if (attempt < attempts - 1) {
        const delayMs = 1000 * 2 ** attempt;
        log.warn("GraphQL request failed, retrying", {
          attempt: attempt + 1,
          delayMs,
          error: err instanceof Error ? err.message : String(err),
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastErr;
}

// ── Node → RawPHProduct mapping ───────────────────────────────────────────────

function nodeToRaw(
  node: z.infer<typeof PostNodeSchema>,
  rank: number,
): RawPHProduct {
  const makers: RawPHMaker[] = (node.makers ?? []).map((m) => ({
    id: m.id,
    username: m.username,
    name: m.name,
    headline: m.headline ?? null,
    avatar_url: m.profileImage ?? null,
  }));

  const topics =
    node.topics?.edges.map((e) => e.node.name) ?? [];

  return {
    id: node.id,
    slug: node.slug,
    name: node.name,
    tagline: node.tagline,
    description: node.description ?? "",
    url: node.url,
    website_url: node.website ?? "",
    thumbnail_url: node.thumbnail?.url ?? "",
    metrics: {
      votes_count: node.votesCount,
      comments_count: node.commentsCount,
    },
    makers,
    topics,
    featured_at: node.featuredAt ?? null,
    created_at: node.createdAt ?? null,
    is_featured: node.featuredAt != null,
    reviews_count: node.reviewsCount ?? 0,
    reviews_rating: node.reviewsRating ?? 0,
    rank,
  };
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function scrapePHDaily(
  apiKey: string,
  apiSecret: string,
): Promise<readonly RawPHProduct[]> {
  log.info("Fetching PH OAuth token");
  const token = await fetchAccessToken(apiKey, apiSecret);

  const seen = new Set<string>();
  const products: RawPHProduct[] = [];
  let cursor: string | null = null;
  let globalRank = 1;

  for (let page = 0; page < MAX_PAGES; page++) {
    log.info("Fetching PH posts page", { page: page + 1, cursor });

    const { nodes, pageInfo } = await withRetry(() =>
      fetchPostsPage(token, cursor),
    );

    for (const node of nodes) {
      if (!node.id || seen.has(node.id)) continue;
      seen.add(node.id);
      products.push(nodeToRaw(node, globalRank));
      globalRank++;
    }

    log.info("PH page fetched", { page: page + 1, count: nodes.length });

    if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
    cursor = pageInfo.endCursor;
  }

  log.info("PH scrape complete", { source: "producthunt", count: products.length });
  return products;
}
