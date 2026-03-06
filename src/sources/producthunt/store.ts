import { getDb } from "../../store/db";

export interface PHAccount {
  id: string;
  label: string;
  username: string | null;
  cookies_json: string;
  status: string;
}

export interface PHProductRow {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  url: string;
  website_url: string;
  thumbnail_url: string;
  votes_count: number;
  comments_count: number;
  is_featured: boolean;
  rank: number | null;
  makers_json: string;
  topics_json: string;
  featured_at: number | null;
  product_created_at: number | null;
  reviews_count: number;
  reviews_rating: number;
  account_id: string | null;
  first_seen_at: number;
  updated_at: number;
}

export async function getActiveAccounts(): Promise<PHAccount[]> {
  const db = getDb();
  const rows = await db`
    SELECT id, label, username, cookies_json, status
    FROM ph_accounts
    WHERE status = 'active'
  `;
  return rows as PHAccount[];
}

export async function upsertProducts(
  products: PHProductRow[],
): Promise<number> {
  if (products.length === 0) return 0;

  const db = getDb();
  let upserted = 0;

  for (const p of products) {
    await db`
      INSERT INTO ph_products (
        id, slug, name, tagline, description, url, website_url,
        thumbnail_url, votes_count, comments_count, is_featured, rank,
        makers_json, topics_json, featured_at, product_created_at,
        reviews_count, reviews_rating,
        account_id, first_seen_at, updated_at
      ) VALUES (
        ${p.id}, ${p.slug}, ${p.name}, ${p.tagline}, ${p.description},
        ${p.url}, ${p.website_url}, ${p.thumbnail_url}, ${p.votes_count},
        ${p.comments_count}, ${p.is_featured}, ${p.rank},
        ${p.makers_json}, ${p.topics_json}, ${p.featured_at},
        ${p.product_created_at}, ${p.reviews_count}, ${p.reviews_rating},
        ${p.account_id}, ${p.first_seen_at}, ${p.updated_at}
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        tagline = EXCLUDED.tagline,
        description = EXCLUDED.description,
        url = EXCLUDED.url,
        website_url = EXCLUDED.website_url,
        thumbnail_url = EXCLUDED.thumbnail_url,
        votes_count = EXCLUDED.votes_count,
        comments_count = EXCLUDED.comments_count,
        is_featured = EXCLUDED.is_featured,
        rank = EXCLUDED.rank,
        makers_json = EXCLUDED.makers_json,
        topics_json = EXCLUDED.topics_json,
        featured_at = EXCLUDED.featured_at,
        product_created_at = EXCLUDED.product_created_at,
        reviews_count = EXCLUDED.reviews_count,
        reviews_rating = EXCLUDED.reviews_rating,
        updated_at = EXCLUDED.updated_at
    `;
    upserted++;
  }

  return upserted;
}

export async function getUnindexedProducts(
  limit = 200,
): Promise<PHProductRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM ph_products
    WHERE indexed_at IS NULL
    ORDER BY first_seen_at DESC
    LIMIT ${limit}
  `;
  return rows as PHProductRow[];
}

export async function markProductsIndexed(
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await db`
    UPDATE ph_products SET indexed_at = ${now}
    WHERE id IN ${db(ids)}
  `;
}

export async function getProducts(
  limit = 50,
  offset = 0,
): Promise<PHProductRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM ph_products
    ORDER BY updated_at DESC, rank ASC NULLS LAST
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows as PHProductRow[];
}

export async function updateLastScrape(
  accountId: string,
  count: number,
): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await db`
    UPDATE ph_accounts
    SET last_scraped_at = ${now},
        last_scrape_count = ${count},
        updated_at = ${now}
    WHERE id = ${accountId}
  `;
}
