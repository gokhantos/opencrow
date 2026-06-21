/**
 * Integration tests for the DB-reading demand probes (keyword-filtered search).
 *
 * Requires a running Postgres instance (docker compose up -d postgres, or the
 * native brew Postgres on 127.0.0.1:5432, db/user/pw `opencrow`).
 * Lane: *.integration.test.ts → `bun run test:integration`
 *
 * These tests exercise the FIX for the "absence floor" defect: the probes must
 * find rows BY KEYWORD (not sample the global top-N). We insert rows with a
 * unique nonce keyword so the probes can isolate exactly our fixtures, then
 * assert: keyword-filter returns matches when present, absence floor still fires
 * on no match, ≤2★ reviews count WITHOUT an intent marker, ph_products lowers
 * whitespace via supply density, and the intent-marker AND is still required for
 * reddit/hn.
 *
 * The single-keyword probe tests run with `minKeywordHits: 1` so they isolate
 * the keyword-filter / intent-AND / rating logic. A dedicated "relevance gate"
 * block below exercises the default ≥2-distinct-keyword precision gate (a
 * 1-keyword doc must NOT count; a ≥2-keyword doc must).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { closeDb, getDb, initDb } from "../../store/db";
import {
  redditIntentProbe,
  fundingNewsProbe,
  reviewComplaintProbe,
  hnProbe,
  xIntentProbe,
  computePhSupplyDensity,
  enrichDemand,
} from "./demand-probes";
import { ABSENCE_SCORE_CAP } from "./demand";

// Unique nonce keyword so our fixtures can't collide with real scraped rows and
// the probes provably filtered BY KEYWORD (a real row would never contain it).
const NONCE = "zkxqfdemandprobe";
// Second nonce so the relevance-gate tests can force ≥2 distinct keyword hits in
// one document without colliding with real scraped rows.
const NONCE2 = "wjvmtdemandgate";
const ID_PREFIX = `demandprobe_test_`;
const NOW = Math.floor(Date.now() / 1000);
// minKeywordHits:1 isolates the keyword-filter / intent-AND / rating logic in the
// per-probe tests; the relevance gate (default 2) gets its own block below.
const OPTS = { windowSec: 3600, limit: 50, minKeywordHits: 1 } as const;
// Lever-1 weak-intent OFF: restores the strict keyword∧marker AND so the
// "marker required" assertions isolate the marker gate from the weak path.
const STRICT = {
  windowSec: 3600,
  limit: 50,
  minKeywordHits: 1,
  weakIntent: false,
} as const;

async function cleanup(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM reddit_posts WHERE id LIKE ${`${ID_PREFIX}%`}`;
  await db`DELETE FROM news_articles WHERE id LIKE ${`${ID_PREFIX}%`}`;
  await db`DELETE FROM appstore_reviews WHERE id LIKE ${`${ID_PREFIX}%`}`;
  await db`DELETE FROM playstore_reviews WHERE id LIKE ${`${ID_PREFIX}%`}`;
  await db`DELETE FROM hn_stories WHERE id LIKE ${`${ID_PREFIX}%`}`;
  await db`DELETE FROM ph_products WHERE id LIKE ${`${ID_PREFIX}%`}`;
  await db`DELETE FROM x_scraped_tweets WHERE id LIKE ${`${ID_PREFIX}%`}`;
  await db`DELETE FROM x_accounts WHERE id LIKE ${`${ID_PREFIX}%`}`;
}

// x_scraped_tweets.account_id is a FK to x_accounts; seed a throwaway account so
// the tweet fixtures satisfy the constraint.
const X_ACCOUNT_ID = `${ID_PREFIX}xacct`;
async function seedXAccount(): Promise<void> {
  const db = getDb();
  await db`
    INSERT INTO x_accounts (id, label, auth_token, ct0)
    VALUES (${X_ACCOUNT_ID}, 'demand-test', 'tok', 'ct0')
    ON CONFLICT (id) DO NOTHING
  `;
}

beforeAll(async () => {
  await initDb(process.env["DATABASE_URL"]);
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await closeDb();
});

// ── redditIntentProbe ─────────────────────────────────────────────────────────

describe("redditIntentProbe (keyword + intent AND)", () => {
  it("finds a niche keyword row even when it is NOT in the global top-N", async () => {
    const db = getDb();
    // One LOW-engagement row that matches keyword + intent, surrounded by many
    // HIGH-engagement rows that do NOT contain the keyword. The old code sampled
    // the global top-60 and would miss the low-engagement match; the fix filters
    // by keyword first so it is found.
    for (let i = 0; i < 70; i++) {
      await db`
        INSERT INTO reddit_posts (id, subreddit, title, selftext, top_comments_json, score, num_comments, permalink, first_seen_at, updated_at)
        VALUES (${`${ID_PREFIX}noise_${i}`}, 'general', 'general AI chatter', 'crypto and llm talk', '[]', ${5000 + i}, ${5000 + i}, '', ${NOW}, ${NOW})
      `;
    }
    await db`
      INSERT INTO reddit_posts (id, subreddit, title, selftext, top_comments_json, score, num_comments, permalink, first_seen_at, updated_at)
      VALUES (${`${ID_PREFIX}match`}, 'niche', ${`anyone know of a ${NONCE} tool`}, ${`is there a tool for ${NONCE}`}, '[]', 3, 1, '', ${NOW}, ${NOW})
    `;

    const out = await redditIntentProbe.probe([NONCE], OPTS);
    expect(out.length).toBe(1);
    expect(out[0]?.kind).toBe("reddit_intent");
    expect(out[0]?.sourceId).toBe(`${ID_PREFIX}match`);
  });

  it("requires the intent marker AND the keyword when weakIntent is off", async () => {
    const db = getDb();
    await db`
      INSERT INTO reddit_posts (id, subreddit, title, selftext, top_comments_json, score, num_comments, permalink, first_seen_at, updated_at)
      VALUES (${`${ID_PREFIX}kwonly`}, 'niche', ${`a post about ${NONCE}`}, 'no buyer intent here at all', '[]', 10, 5, '', ${NOW}, ${NOW})
    `;
    const out = await redditIntentProbe.probe([NONCE], STRICT);
    expect(out.length).toBe(0);
  });

  it("returns [] (absence) when no row contains the keyword", async () => {
    const out = await redditIntentProbe.probe([NONCE], OPTS);
    expect(out).toEqual([]);
  });
});

// ── Lever 1 — weak-intent gate ────────────────────────────────────────────────

describe("redditIntentProbe weak-intent gate (Lever 1)", () => {
  it("counts a marker-less but high-engagement keyword row as WEAK (discounted)", async () => {
    const db = getDb();
    // No buyer-intent marker, but ≥2 keywords + real engagement (score 40,
    // comments 10) → weak evidence, kind unchanged, count scaled by 0.35.
    await db`
      INSERT INTO reddit_posts (id, subreddit, title, selftext, top_comments_json, score, num_comments, permalink, first_seen_at, updated_at)
      VALUES (${`${ID_PREFIX}weak`}, 'niche', ${`${NONCE} ${NONCE2} thread`}, 'detailed discussion, no canned intent phrase', '[]', 40, 10, '', ${NOW}, ${NOW})
    `;
    const TWO = [NONCE, NONCE2] as const;
    const strong = 1 + Math.log1p(50); // 1 + log1p(score+comments)
    const weak = await redditIntentProbe.probe(TWO, {
      windowSec: 3600,
      limit: 50,
      minKeywordHits: 2,
      weakIntent: true,
      weakIntentFactor: 0.35,
    });
    expect(weak.length).toBe(1);
    expect(weak[0]?.kind).toBe("reddit_intent"); // SAME kind, just discounted
    expect(weak[0]?.count ?? 0).toBeCloseTo(strong * 0.35, 2);
  });

  it("rejects a marker-less ZERO-engagement keyword row (engagement floor)", async () => {
    const db = getDb();
    await db`
      INSERT INTO reddit_posts (id, subreddit, title, selftext, top_comments_json, score, num_comments, permalink, first_seen_at, updated_at)
      VALUES (${`${ID_PREFIX}dead`}, 'niche', ${`${NONCE} ${NONCE2} thread`}, 'no engagement, no marker', '[]', 0, 0, '', ${NOW}, ${NOW})
    `;
    const TWO = [NONCE, NONCE2] as const;
    // engagement = 1 + log1p(0) = 1 < weakIntentMinEngagement (1.5) → skipped.
    const out = await redditIntentProbe.probe(TWO, {
      windowSec: 3600,
      limit: 50,
      minKeywordHits: 2,
      weakIntent: true,
    });
    expect(out.length).toBe(0);
  });
});

// ── Lever 3 — fuzzy stem matching ─────────────────────────────────────────────

describe("fuzzy stem matching (Lever 3)", () => {
  it("matches a morphological VARIANT the literal substring filter would miss", async () => {
    const db = getDb();
    // Idea keyword is the singular nonce; the row uses the PLURAL form. Literal
    // includes() would still match here, so use a true inflection: keyword
    // "<nonce>" vs row "<nonce>s" both stem-collapse and the prefilter (%stem%)
    // catches the variant.
    const variant = `${NONCE}s`; // plural inflection of the nonce keyword
    await db`
      INSERT INTO reddit_posts (id, subreddit, title, selftext, top_comments_json, score, num_comments, permalink, first_seen_at, updated_at)
      VALUES (${`${ID_PREFIX}stem`}, 'niche', ${`is there a tool for ${variant}`}, ${`looking for a tool, ${NONCE2} ${variant}`}, '[]', 5, 2, '', ${NOW}, ${NOW})
    `;
    const TWO = [NONCE, NONCE2] as const;
    const fuzzy = await redditIntentProbe.probe(TWO, {
      windowSec: 3600,
      limit: 50,
      minKeywordHits: 2,
      fuzzyMatch: true,
    });
    expect(fuzzy.length).toBe(1);
    expect(fuzzy[0]?.kind).toBe("reddit_intent");
  });
});

// ── Lever 4 — xIntentProbe ────────────────────────────────────────────────────

describe("xIntentProbe (x_scraped_tweets, keyword + intent like reddit)", () => {
  it("matches a keyword tweet that pairs an intent marker (STRONG)", async () => {
    const db = getDb();
    await seedXAccount();
    await db`
      INSERT INTO x_scraped_tweets (id, account_id, tweet_id, text, likes, retweets, replies, scraped_at)
      VALUES (${`${ID_PREFIX}x1`}, ${X_ACCOUNT_ID}, ${`${ID_PREFIX}t1`}, ${`is there a tool for ${NONCE}? looking for a tool`}, 30, 5, 2, ${NOW})
    `;
    const out = await xIntentProbe.probe([NONCE], OPTS);
    expect(out.length).toBe(1);
    expect(out[0]?.kind).toBe("x_intent");
    expect(out[0]?.sourceId).toBe(`${ID_PREFIX}x1`);
  });

  it("requires the intent marker AND the keyword when weakIntent is off", async () => {
    const db = getDb();
    await seedXAccount();
    await db`
      INSERT INTO x_scraped_tweets (id, account_id, tweet_id, text, likes, retweets, replies, scraped_at)
      VALUES (${`${ID_PREFIX}x2`}, ${X_ACCOUNT_ID}, ${`${ID_PREFIX}t2`}, ${`just shipped my ${NONCE} thing`}, 30, 5, 2, ${NOW})
    `;
    const out = await xIntentProbe.probe([NONCE], STRICT);
    expect(out.length).toBe(0);
  });

  it("weights the count by engagement (likes/retweets/replies)", async () => {
    const db = getDb();
    await seedXAccount();
    await db`
      INSERT INTO x_scraped_tweets (id, account_id, tweet_id, text, likes, retweets, replies, scraped_at)
      VALUES (${`${ID_PREFIX}x3`}, ${X_ACCOUNT_ID}, ${`${ID_PREFIX}t3`}, ${`is there a tool for ${NONCE}`}, 100, 50, 10, ${NOW})
    `;
    const out = await xIntentProbe.probe([NONCE], OPTS);
    expect(out.length).toBe(1);
    expect(out[0]?.count ?? 0).toBeGreaterThan(1);
  });

  it("returns [] (absence) when no tweet contains the keyword", async () => {
    const out = await xIntentProbe.probe([NONCE], OPTS);
    expect(out).toEqual([]);
  });
});

// ── fundingNewsProbe ──────────────────────────────────────────────────────────

describe("fundingNewsProbe (keyword + funding AND)", () => {
  it("matches a keyword article that mentions a funding marker", async () => {
    const db = getDb();
    await db`
      INSERT INTO news_articles (id, source_name, url, url_hash, title, summary, body, category, section, scraped_at)
      VALUES (${`${ID_PREFIX}fund`}, 'test', ${`u/${ID_PREFIX}fund`}, ${`${ID_PREFIX}fund`}, ${`${NONCE} startup raises Series A`}, 'big round', 'led the round', 'tech', 'startups', ${NOW})
    `;
    const out = await fundingNewsProbe.probe([NONCE], OPTS);
    expect(out.length).toBe(1);
    expect(out[0]?.kind).toBe("funding_news");
  });

  it("requires the funding marker AND the keyword (keyword alone => no match)", async () => {
    const db = getDb();
    await db`
      INSERT INTO news_articles (id, source_name, url, url_hash, title, summary, body, category, section, scraped_at)
      VALUES (${`${ID_PREFIX}nofund`}, 'test', ${`u/${ID_PREFIX}nofund`}, ${`${ID_PREFIX}nofund`}, ${`a story about ${NONCE}`}, 'no money mentioned', 'just news', 'tech', 'general', ${NOW})
    `;
    const out = await fundingNewsProbe.probe([NONCE], OPTS);
    expect(out.length).toBe(0);
  });
});

// ── reviewComplaintProbe ──────────────────────────────────────────────────────

describe("reviewComplaintProbe (<=2★, NO intent marker required)", () => {
  it("counts a <=2★ keyword review with no intent marker (the rating IS intent)", async () => {
    const db = getDb();
    await db`
      INSERT INTO appstore_reviews (id, app_id, app_name, author, rating, title, content, version, first_seen_at)
      VALUES (${`${ID_PREFIX}app1`}, 'app.x', 'App X', 'a', 1, 'awful', ${`the ${NONCE} feature never works`}, '1.0', ${NOW})
    `;
    const out = await reviewComplaintProbe.probe([NONCE], OPTS);
    expect(out.length).toBe(1);
    expect(out[0]?.kind).toBe("review_complaint");
    expect(out[0]?.count).toBe(1); // appstore: no engagement column
  });

  it("ignores >=3★ reviews even when they contain the keyword", async () => {
    const db = getDb();
    await db`
      INSERT INTO appstore_reviews (id, app_id, app_name, author, rating, title, content, version, first_seen_at)
      VALUES (${`${ID_PREFIX}app4`}, 'app.x', 'App X', 'a', 4, 'great', ${`love the ${NONCE} feature`}, '1.0', ${NOW})
    `;
    const out = await reviewComplaintProbe.probe([NONCE], OPTS);
    expect(out.length).toBe(0);
  });

  it("weights a play-store complaint by thumbs_up (count > 1)", async () => {
    const db = getDb();
    await db`
      INSERT INTO playstore_reviews (id, app_id, app_name, author, rating, title, content, thumbs_up, version, first_seen_at)
      VALUES (${`${ID_PREFIX}play1`}, 'app.y', 'App Y', 'b', 2, 'bad', ${`${NONCE} keeps crashing`}, 100, '2.0', ${NOW})
    `;
    const out = await reviewComplaintProbe.probe([NONCE], OPTS);
    expect(out.length).toBe(1);
    expect(out[0]?.count ?? 0).toBeGreaterThan(1);
  });
});

// ── hnProbe ───────────────────────────────────────────────────────────────────

describe("hnProbe (keyword + intent AND, like reddit)", () => {
  it("matches a keyword story that pairs an intent marker", async () => {
    const db = getDb();
    await db`
      INSERT INTO hn_stories (id, title, url, points, author, comment_count, hn_url, first_seen_at, updated_at, description, top_comments_json)
      VALUES (${`${ID_PREFIX}hn1`}, ${`is there a tool for ${NONCE}`}, '', 50, 'a', 20, '', ${NOW}, ${NOW}, ${`looking for a tool for ${NONCE}`}, '[]')
    `;
    const out = await hnProbe.probe([NONCE], OPTS);
    expect(out.length).toBe(1);
    expect(out[0]?.kind).toBe("hn_intent");
  });

  it("requires the intent marker AND the keyword when weakIntent is off", async () => {
    const db = getDb();
    await db`
      INSERT INTO hn_stories (id, title, url, points, author, comment_count, hn_url, first_seen_at, updated_at, description, top_comments_json)
      VALUES (${`${ID_PREFIX}hn2`}, ${`Show HN: my ${NONCE} project`}, '', 50, 'a', 20, '', ${NOW}, ${NOW}, 'just shipped it', '[]')
    `;
    const out = await hnProbe.probe([NONCE], STRICT);
    expect(out.length).toBe(0);
  });
});

// ── ph_products supply density ────────────────────────────────────────────────

describe("computePhSupplyDensity (supply, not demand)", () => {
  it("returns 0 when no ph_products match the keyword", async () => {
    const density = await computePhSupplyDensity([NONCE], OPTS);
    expect(density).toBe(0);
  });

  it("raises supply density when keyword-matching launches exist", async () => {
    const db = getDb();
    for (let i = 0; i < 4; i++) {
      await db`
        INSERT INTO ph_products (id, slug, name, tagline, description, topics_json, first_seen_at, updated_at)
        VALUES (${`${ID_PREFIX}ph_${i}`}, ${`slug-${i}`}, ${`${NONCE} competitor ${i}`}, 'a competing launch', 'does the thing', '[]', ${NOW}, ${NOW})
      `;
    }
    const density = await computePhSupplyDensity([NONCE], OPTS);
    expect(density).toBeGreaterThan(0);
  });

  it("lowers whitespace end-to-end via enrichDemand when competitors exist", async () => {
    const db = getDb();
    // Demand evidence: a strong reddit-intent match for the keyword.
    await db`
      INSERT INTO reddit_posts (id, subreddit, title, selftext, top_comments_json, score, num_comments, permalink, first_seen_at, updated_at)
      VALUES (${`${ID_PREFIX}demand`}, 'niche', ${`anyone know of a ${NONCE} tool`}, ${`is there a tool for ${NONCE}`}, '[]', 500, 300, '', ${NOW}, ${NOW})
    `;
    const candidate = { title: NONCE, summary: `a ${NONCE} product`, reasoning: NONCE };
    const cfg = { windowSec: 3600, limit: 50, minKeywordHits: 1 } as const;

    // No competitors yet.
    const open = await enrichDemand(candidate, undefined, cfg);

    // Now add keyword-matching ph_products (supply).
    for (let i = 0; i < 6; i++) {
      await db`
        INSERT INTO ph_products (id, slug, name, tagline, description, topics_json, first_seen_at, updated_at)
        VALUES (${`${ID_PREFIX}phc_${i}`}, ${`c-${i}`}, ${`${NONCE} rival ${i}`}, 'rival', 'rival', '[]', ${NOW}, ${NOW})
      `;
    }
    const crowded = await enrichDemand(candidate, undefined, cfg);

    expect(crowded.whitespace).toBeLessThan(open.whitespace);
    // ph_products must NOT inflate the demand score — same evidence both times.
    expect(crowded.score).toBeCloseTo(open.score, 5);
  });
});

// ── relevance gate (≥N distinct keywords must co-occur) ───────────────────────

describe("relevance gate (minKeywordHits)", () => {
  const TWO_KWS = [NONCE, NONCE2] as const;
  const GATE_OPTS = { windowSec: 3600, limit: 50 } as const; // default minKeywordHits=2

  it("review_complaint: a 1-keyword ≤2★ review does NOT count (default gate=2)", async () => {
    const db = getDb();
    await db`
      INSERT INTO appstore_reviews (id, app_id, app_name, author, rating, title, content, version, first_seen_at)
      VALUES (${`${ID_PREFIX}gate1kw`}, 'app.x', 'App X', 'a', 1, 'bad', ${`only ${NONCE} mentioned once`}, '1.0', ${NOW})
    `;
    const out = await reviewComplaintProbe.probe(TWO_KWS, GATE_OPTS);
    expect(out.length).toBe(0);
  });

  it("review_complaint: a ≥2-distinct-keyword ≤2★ review DOES count (no intent marker needed)", async () => {
    const db = getDb();
    await db`
      INSERT INTO appstore_reviews (id, app_id, app_name, author, rating, title, content, version, first_seen_at)
      VALUES (${`${ID_PREFIX}gate2kw`}, 'app.x', 'App X', 'a', 1, 'awful', ${`${NONCE} and ${NONCE2} both broken`}, '1.0', ${NOW})
    `;
    const out = await reviewComplaintProbe.probe(TWO_KWS, GATE_OPTS);
    expect(out.length).toBe(1);
    expect(out[0]?.kind).toBe("review_complaint");
  });

  it("reddit_intent: a ≥2-keyword row STILL requires the marker when weakIntent is off", async () => {
    const db = getDb();
    // weakIntent OFF isolates the marker gate: two keywords co-occur but there is
    // NO buyer-intent marker -> rejected.
    const STRICT_GATE = { ...GATE_OPTS, weakIntent: false } as const;
    await db`
      INSERT INTO reddit_posts (id, subreddit, title, selftext, top_comments_json, score, num_comments, permalink, first_seen_at, updated_at)
      VALUES (${`${ID_PREFIX}gate_noi`}, 'niche', ${`${NONCE} ${NONCE2} discussion`}, 'no buyer intent here', '[]', 10, 5, '', ${NOW}, ${NOW})
    `;
    const noMarker = await redditIntentProbe.probe(TWO_KWS, STRICT_GATE);
    expect(noMarker.length).toBe(0);

    // Add the intent marker AND keep ≥2 keywords -> accepted.
    await db`
      INSERT INTO reddit_posts (id, subreddit, title, selftext, top_comments_json, score, num_comments, permalink, first_seen_at, updated_at)
      VALUES (${`${ID_PREFIX}gate_intent`}, 'niche', ${`is there a tool for ${NONCE}`}, ${`looking for a tool for ${NONCE2}`}, '[]', 10, 5, '', ${NOW}, ${NOW})
    `;
    const withMarker = await redditIntentProbe.probe(TWO_KWS, STRICT_GATE);
    expect(withMarker.length).toBe(1);
    expect(withMarker[0]?.sourceId).toBe(`${ID_PREFIX}gate_intent`);
  });

  it("end-to-end: a row sharing only ONE keyword falls to the absence regime", async () => {
    const db = getDb();
    // A ≤2★ review with exactly one of the candidate's keywords — the cross-domain
    // false-positive shape (one generic word shared). Must NOT accrue evidence.
    await db`
      INSERT INTO appstore_reviews (id, app_id, app_name, author, rating, title, content, version, first_seen_at)
      VALUES (${`${ID_PREFIX}gate_e2e`}, 'app.x', 'App X', 'a', 1, 'bad', ${`a review that only says ${NONCE}`}, '1.0', ${NOW})
    `;
    const candidate = {
      title: `${NONCE} ${NONCE2} product`,
      summary: `${NONCE} ${NONCE2}`,
      reasoning: `${NONCE} and ${NONCE2}`,
    };
    const art = await enrichDemand(candidate, undefined, GATE_OPTS);
    expect(art.evidence.length).toBe(0);
    expect(art.score).toBeLessThanOrEqual(ABSENCE_SCORE_CAP);
  });
});

// ── absence floor preserved ───────────────────────────────────────────────────

describe("absence floor preserved end-to-end", () => {
  it("an idea with NO keyword match anywhere falls to the absence regime", async () => {
    const candidate = {
      title: `${NONCE} nothingmatches`,
      summary: `${NONCE} nothingmatches`,
      reasoning: NONCE,
    };
    const art = await enrichDemand(candidate, undefined, {
      windowSec: 3600,
      limit: 50,
    });
    expect(art.evidence.length).toBe(0);
    expect(art.score).toBeLessThanOrEqual(ABSENCE_SCORE_CAP);
  });
});
