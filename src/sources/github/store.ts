import { getDb } from "../../store/db";

export interface GithubRepoRow {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly full_name: string;
  readonly description: string;
  readonly language: string;
  readonly stars: number;
  readonly forks: number;
  readonly stars_today: number;
  readonly built_by_json: string;
  readonly url: string;
  readonly period: string;
  readonly first_seen_at: number;
  readonly updated_at: number;
  readonly indexed_at?: number;
  readonly prev_stars?: number | null;
  readonly prev_forks?: number | null;
  readonly stars_velocity?: number | null;
}

export async function upsertRepos(
  repos: readonly GithubRepoRow[],
): Promise<number> {
  if (repos.length === 0) return 0;

  const db = getDb();
  let upserted = 0;

  for (const r of repos) {
    await db`
      INSERT INTO github_repos (
        id, owner, name, full_name, description, language,
        stars, forks, stars_today, built_by_json, url,
        period, first_seen_at, updated_at
      ) VALUES (
        ${r.id}, ${r.owner}, ${r.name}, ${r.full_name},
        ${r.description}, ${r.language}, ${r.stars}, ${r.forks},
        ${r.stars_today}, ${r.built_by_json}, ${r.url},
        ${r.period}, ${r.first_seen_at}, ${r.updated_at}
      )
      ON CONFLICT (id) DO UPDATE SET
        description = EXCLUDED.description,
        stars = GREATEST(github_repos.stars, EXCLUDED.stars),
        forks = GREATEST(github_repos.forks, EXCLUDED.forks),
        stars_today = EXCLUDED.stars_today,
        built_by_json = EXCLUDED.built_by_json,
        updated_at = EXCLUDED.updated_at,
        prev_stars = github_repos.stars,
        prev_forks = github_repos.forks,
        stars_velocity = CASE
          WHEN github_repos.updated_at IS NOT NULL
            AND EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(github_repos.updated_at))) > 60
          THEN (GREATEST(github_repos.stars, EXCLUDED.stars) - github_repos.stars)::REAL
            / (EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(github_repos.updated_at))) / 3600.0)
          ELSE github_repos.stars_velocity END,
        indexed_at = CASE
          WHEN github_repos.description IS DISTINCT FROM EXCLUDED.description
          THEN NULL ELSE github_repos.indexed_at END
    `;
    upserted++;
  }

  return upserted;
}

export async function getRepos(
  language?: string,
  period?: string,
  limit = 50,
  offset = 0,
): Promise<readonly GithubRepoRow[]> {
  const db = getDb();

  if (language && period) {
    return db`
      SELECT * FROM github_repos
      WHERE language = ${language} AND period = ${period}
      ORDER BY stars_today DESC, stars DESC
      LIMIT ${limit} OFFSET ${offset}
    ` as Promise<GithubRepoRow[]>;
  }

  if (language) {
    return db`
      SELECT * FROM github_repos
      WHERE language = ${language}
      ORDER BY stars_today DESC, stars DESC
      LIMIT ${limit} OFFSET ${offset}
    ` as Promise<GithubRepoRow[]>;
  }

  if (period) {
    return db`
      SELECT * FROM github_repos
      WHERE period = ${period}
      ORDER BY stars_today DESC, stars DESC
      LIMIT ${limit} OFFSET ${offset}
    ` as Promise<GithubRepoRow[]>;
  }

  return db`
    SELECT * FROM github_repos
    ORDER BY stars_today DESC, stars DESC
    LIMIT ${limit} OFFSET ${offset}
  ` as Promise<GithubRepoRow[]>;
}

export async function getUnindexedRepos(
  limit = 200,
): Promise<readonly GithubRepoRow[]> {
  const db = getDb();
  return db`
    SELECT * FROM github_repos
    WHERE indexed_at IS NULL
    ORDER BY first_seen_at DESC
    LIMIT ${limit}
  ` as Promise<GithubRepoRow[]>;
}

export async function markReposIndexed(
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await db`
    UPDATE github_repos SET indexed_at = ${now}
    WHERE id IN ${db(ids)}
  `;
}

export async function getRepoStats(): Promise<{
  readonly total_repos: number;
  readonly last_updated_at: number | null;
  readonly languages: number;
}> {
  const db = getDb();
  const rows = await db`
    SELECT
      count(*)::int as total_repos,
      max(updated_at) as last_updated_at,
      count(DISTINCT language)::int as languages
    FROM github_repos
  `;
  return (rows[0] as {
    total_repos: number;
    last_updated_at: number | null;
    languages: number;
  }) ?? { total_repos: 0, last_updated_at: null, languages: 0 };
}
