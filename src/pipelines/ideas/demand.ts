/**
 * Phase 2 — DEMAND-SIDE GROUNDING (PURE core).
 *
 * The ideas pipeline is supply-side blind: every scraper feeds it WHAT exists
 * (apps, repos, launches, news) but nothing about WHO WANTS IT. As a result the
 * GIANT `demand` axis — which is EVIDENCE-GATED in giant.ts (capped <=2 without
 * a cited artifact) — can never legitimately score 3-5. This module supplies the
 * missing artifact: a structured, CITED {@link DemandArtifact} bound to each
 * candidate, derived DETERMINISTICALLY from real scraped-row COUNTS.
 *
 * CRITICAL ANTI-HALLUCINATION CONTRACT (from the plan's pressure-test):
 *   - Demand keywords are extracted from the candidate's own text by CODE
 *     ({@link extractDemandKeywords}) — tokenize, drop stopwords, keep salient
 *     terms + bigrams. No LLM picks the queries.
 *   - The artifact's `score` / `confidence` / `whitespace` are DETERMINISTIC
 *     functions of the evidence ROW COUNTS ({@link aggregateDemand}). An LLM may
 *     only PHRASE a `quote` that is already present in a matched row; it may
 *     NEVER invent a count or assert demand.
 *   - ABSENCE IS A PENALTY, NOT A NEUTRAL: zero matched evidence yields a LOW
 *     score (<=1) and LOW confidence (<=0.2), never a free middling score.
 *
 * Everything here is PURE (no DB / clock / rng) and fully unit-testable. The
 * DB-reading probes live in ./demand-probes.ts; this module only defines the
 * shapes, the keyword extractor, the deterministic aggregation, and the
 * {@link DemandProbe} interface they implement.
 */

import { z } from "zod";
import { demandSynonymsFor } from "./demand-intent-markers";

// ── Demand evidence kinds ─────────────────────────────────────────────────────

/** The provenance kinds a single piece of demand evidence can come from. */
export const DEMAND_EVIDENCE_KINDS = [
  "reddit_intent",
  "funding_news",
  "hiring",
  "search_trend",
  // A ≤2★ app-store / play-store review that names the candidate keyword: the
  // low rating IS the expressed unmet need (no separate intent marker required).
  "review_complaint",
  // A Hacker News story/discussion pairing the keyword WITH a buyer-intent
  // marker — same "people who WANT a tool" semantics as reddit_intent.
  "hn_intent",
  // A scraped corpus row (reddit) whose EMBEDDING is topically close to the
  // idea even when it shares no buyer-intent phrase or exact keyword. This is
  // the fix for the "dead demand probe -> absence floor" defect: niche pains
  // discussed in different words than the candidate's keywords were invisible
  // to the lexical+intent probes and pinned demand at the absence cap. Softer,
  // fuzzier evidence than an explicit intent marker (see DEMAND_KIND_WEIGHTS).
  "semantic_corpus",
  // An X/Twitter post pairing the keyword WITH a buyer-intent marker — organic
  // intent from a third social surface, same semantics as reddit_intent.
  "x_intent",
] as const;

export type DemandEvidenceKind = (typeof DEMAND_EVIDENCE_KINDS)[number];

/**
 * One CITED demand signal. `count` is a real row count (or matched-pattern
 * count) from an EXISTING scraped table — never an LLM assertion. `quote`, when
 * present, is a verbatim snippet from a matched row (the only thing an LLM may
 * later rephrase). `sourceId` binds the evidence back to the originating row so
 * the citation is auditable.
 */
export interface DemandEvidence {
  readonly kind: DemandEvidenceKind;
  /** The demand keyword/phrase that matched (what we queried for). */
  readonly query: string;
  /** Real number of matched rows / weighted matches backing this evidence. */
  readonly count: number;
  /** A verbatim snippet from a matched row (auditable; never invented). */
  readonly quote?: string;
  /** Source row id binding the evidence to a real scraped record. */
  readonly sourceId?: string;
}

/**
 * The structured, deterministic demand verdict bound to one candidate.
 *
 *   score      — 0..5 demand strength, a deterministic (log-scaled, capped)
 *                function of the total weighted match count. NOT an LLM opinion.
 *   confidence — 0..1, how much evidence backs the score (volume + source
 *                diversity). LOW when no signal (absence penalty).
 *   whitespace — 0..1, demand intensity minus supply density (high = wanted but
 *                underserved).
 *   evidence   — the cited rows the numbers were derived from.
 */
export interface DemandArtifact {
  readonly score: number;
  readonly confidence: number;
  readonly whitespace: number;
  readonly evidence: readonly DemandEvidence[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEMAND_SCORE_MIN = 0;
export const DEMAND_SCORE_MAX = 5;
export const CONFIDENCE_MIN = 0;
export const CONFIDENCE_MAX = 1;

/**
 * Absence caps. When NO evidence matched, the artifact is explicitly penalized:
 * score is held at or below {@link ABSENCE_SCORE_CAP} and confidence at or below
 * {@link ABSENCE_CONFIDENCE_CAP}. Demand-blindness must cost, not be neutral.
 */
export const ABSENCE_SCORE_CAP = 1;
export const ABSENCE_CONFIDENCE_CAP = 0.2;

/**
 * RELEVANCE GATE default: minimum number of DISTINCT candidate keywords that must
 * co-occur in a single document for it to count as demand evidence. 2 means "a
 * random row sharing one generic word does NOT count; the row must be about THIS
 * idea (two distinct idea terms, or one multi-word idea phrase)". Bias toward
 * missing rather than inflating — see {@link distinctKeywordHits}.
 */
export const DEFAULT_MIN_KEYWORD_HITS = 2;

/**
 * Log scaling for the score: score ≈ DEMAND_SCORE_MAX * ln(1 + w) / ln(1 + SAT),
 * so the weighted match total `w` saturates the 0..5 range near {@link SCORE_SATURATION}.
 * Log-scaled so a handful of strong matches is meaningful but a flood of weak
 * ones can't run away — diminishing returns, capped at 5.
 */
export const SCORE_SATURATION = 40;

/**
 * Per-kind weights: a funding round / hiring spike is a stronger buyer-intent
 * signal than a single forum "is there a tool that…", so weight the contribution
 * of each evidence kind before log-scaling. Keeps the score deterministic and
 * explainable.
 */
export const DEMAND_KIND_WEIGHTS: Readonly<Record<DemandEvidenceKind, number>> = {
  reddit_intent: 1.0,
  funding_news: 1.5,
  hiring: 1.25,
  search_trend: 1.0,
  // A single ≤2★ review is one user's pain; weighted slightly below a forum
  // "is there a tool for X" because it expresses dissatisfaction with an
  // existing product rather than an unmet want, but engagement (thumbs_up) on
  // play-store reviews already amplifies the loud ones via `count`.
  review_complaint: 0.75,
  // HN discussion pairs a keyword with a buyer-intent marker — same strength as
  // the reddit-intent signal it mirrors.
  hn_intent: 1.0,
  // Embedding-similarity match against the scraped corpus. Deliberately SOFTER
  // than a literal buyer-intent marker (1.0): semantic relatedness is fuzzier
  // evidence than an explicit "is there a tool for X" phrase — it proves the
  // topic is discussed, not that someone stated a want. We keep it below 1.0 so
  // it lifts genuinely-niche ideas off the absence floor without letting purely
  // topical chatter masquerade as buyer intent. Engagement still scales `count`.
  semantic_corpus: 0.8,
  // X/Twitter post pairs a keyword with a buyer-intent marker — same buyer-intent
  // semantics and strength as the reddit-intent signal it mirrors.
  x_intent: 1.0,
};

/** Confidence saturates as evidence volume + source diversity grow. */
const CONFIDENCE_COUNT_SATURATION = 6; // total matches for the volume term
const CONFIDENCE_DIVERSITY_WEIGHT = 0.4; // share of confidence from kind diversity
const CONFIDENCE_VOLUME_WEIGHT = 0.6; // share of confidence from raw volume

// ── Small pure helpers ────────────────────────────────────────────────────────

/** Clamp into [min, max]; non-finite → min. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

// ── Keyword extraction (PURE, deterministic) ──────────────────────────────────

/**
 * English stopwords + idea-pipeline boilerplate dropped from demand keywords.
 * Kept deliberately broad: these tokens carry no buyer-intent signal and would
 * match almost any scraped row, polluting the demand counts.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "of", "to",
  "in", "on", "at", "by", "with", "from", "as", "is", "are", "was", "were", "be",
  "been", "being", "this", "that", "these", "those", "it", "its", "they", "them",
  "their", "we", "our", "you", "your", "i", "me", "my", "he", "she", "his", "her",
  "not", "no", "so", "up", "out", "off", "into", "over", "than", "too", "very",
  "can", "will", "just", "do", "does", "did", "done", "have", "has", "had", "get",
  "got", "make", "makes", "made", "use", "using", "used", "via", "per", "about",
  "more", "most", "some", "any", "all", "each", "other", "such", "only", "own",
  "same", "new", "app", "apps", "tool", "tools", "platform", "solution", "product",
  "service", "users", "user", "people", "help", "helps", "helping", "way", "ways",
  "thing", "things", "lot", "lots", "need", "needs", "want", "wants", "like",
  "based", "build", "builds", "building", "built", "let", "lets", "etc", "also",
  "one", "two", "many", "much", "how", "what", "when", "where", "who", "why",
  "which", "while", "because", "without", "within", "across", "between", "data",
]);

/**
 * GENERICNESS STOPLIST — ultra-common tokens that, ON THEIR OWN, carry no TOPICAL
 * signal: they appear in tens of thousands of unrelated scraped rows, so a single
 * one of them satisfying a keyword match inflates the demand count without
 * indicating the document is about the idea (e.g. a package-tracking review
 * matched a glucose idea on the bare word "tracking"; a Hinge dating review
 * matched it on "monitor"; a DoorDash delivery review matched a staff-scheduling
 * idea on "restaurant").
 *
 * These are dropped from the extracted UNIGRAM keyword set (see
 * {@link extractDemandKeywords}) so a lone generic word can neither prefilter
 * candidates nor satisfy the co-occurrence gate. They are STILL allowed to form
 * BIGRAMS, because a phrase like "glucose monitoring" / "staff scheduling" /
 * "restaurant scheduling" is highly topical even though its parts are generic —
 * and {@link distinctKeywordHits} treats a phrase match as strong co-occurrence.
 *
 * Curated deliberately narrow: only words generic enough to be corpus-wide noise.
 * Distinctive domain terms (glucose, paystub, hotschedules, overtime, wage,
 * diabetes, payroll) are intentionally NOT here — they are the signal the gate
 * relies on. Disjoint from {@link STOPWORDS} (function words).
 */
const DEMAND_GENERIC_STOPWORDS: ReadonlySet<string> = new Set([
  // generic product/usage nouns
  "feature", "features", "version", "update", "updates", "account", "accounts",
  "company", "companies", "business", "businesses", "customer", "customers",
  "consumer", "consumers", "client", "clients", "worker", "workers", "employee",
  "employees", "team", "teams", "member", "members", "manager", "managers",
  // generic verbs/states that match almost anything as a single token
  "track", "tracks", "tracking", "tracker", "monitor", "monitors", "monitoring",
  "manage", "manages", "managing", "management", "schedule", "schedules",
  "scheduling", "scheduler", "report", "reports", "reporting", "system",
  "systems", "software", "website", "site", "page", "pages", "screen", "click",
  "button", "menu", "login", "log", "sign", "email", "message", "messages",
  "notification", "notifications", "support", "experience", "interface", "device",
  // generic adjectives / quality words (dominate low-star review text)
  "free", "paid", "premium", "pro", "basic", "simple", "easy", "fast", "slow",
  "good", "bad", "great", "best", "better", "worst", "nice", "cool", "awesome",
  "terrible", "awful", "broken", "buggy", "useful", "happy",
  // broad domain umbrellas (too wide to be topical on their own)
  "health", "fitness", "money", "finance", "financial", "work", "job", "jobs",
  "time", "day", "days", "daily", "week", "month", "year", "today", "online",
  "mobile", "digital", "smart", "tech", "technology", "internet", "web", "cloud",
  "restaurant", "restaurants", "food", "order", "orders", "delivery",
  // universal quantifiers / indefinite pronouns (match literally anything)
  "every", "everyone", "everything", "everybody", "anyone", "anything",
  "someone", "something", "somebody", "nobody", "nothing", "everywhere",
]);

/** A candidate's text fields used for demand keyword extraction. */
export interface DemandCandidateText {
  readonly title?: string;
  readonly summary?: string;
  /** The problem / pain statement; in this pipeline that is `reasoning`. */
  readonly reasoning?: string;
  /** Free-text trend intersection (additional salient terms). */
  readonly trendIntersection?: string;
  readonly targetAudience?: string;
}

/** Options for {@link extractDemandKeywords}. */
export interface ExtractKeywordsOptions {
  /** Max number of keywords (unigrams + bigrams) to return. Default 12. */
  readonly maxKeywords?: number;
  /** Minimum token length kept (after lowercasing). Default 3. */
  readonly minTokenLength?: number;
}

/** A single tokenized, normalized word (alpha-numeric, lowercased). */
function tokenize(text: string): readonly string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** Whether a token is salient (non-stopword, long enough, not pure digits). */
function isSalient(token: string, minLen: number): boolean {
  if (token.length < minLen) return false;
  if (STOPWORDS.has(token)) return false;
  if (/^\d+$/.test(token)) return false;
  return true;
}

/** Whether a salient token is also TOPICAL (not an ultra-generic single word). */
function isTopicalUnigram(token: string, minLen: number): boolean {
  return isSalient(token, minLen) && !DEMAND_GENERIC_STOPWORDS.has(token);
}

// ── Fuzzy lexical matching (Lever 3 — PURE, deterministic, no deps) ────────────

/** Minimum token length below which no suffix stripping is applied (safety). */
const STEM_MIN_LEN = 4;

/**
 * Conservative, deterministic suffix-stripping stemmer — NOT a full Porter
 * stemmer. The goal is recall on common morphological variants
 * (schedule/schedules/scheduling/scheduled/scheduler) WITHOUT the over-stemming
 * that collapses distinct lexemes (the classic "billing" → "bill" trap).
 *
 * Rules, applied to a lowercased alpha token, in order, each guarded by a length
 * floor so short words are never mangled:
 *   - `-ing` / `-ed`  → strip (running → runn..; we then also drop a trailing
 *     doubled consonant so "running"→"run", "scheduled"→"schedul")
 *   - `-tion`         → `-t` (automation → automat ⟂ automate→automat)
 *   - `-er` / `-or`   → strip ONLY when the remaining stem is long enough
 *   - `-es` / `-s`    → strip plural (invoices → invoice, boxes → box)
 *
 * Deliberately conservative: words shorter than {@link STEM_MIN_LEN}, and stems
 * that would drop below 3 chars, are left intact. Idempotent on already-stemmed
 * input. PURE: no IO, same input → same output.
 */
export function stemToken(token: string): string {
  const original = token.toLowerCase();
  if (original.length < STEM_MIN_LEN || !/^[a-z]+$/.test(original)) {
    return original;
  }
  let t = original;

  // 1. plural -s / -es first, so "reconciliations" → "reconciliation" before the
  //    -tion rule fires (single pass, idempotent).
  if (t.endsWith("ies") && t.length > 4) {
    // "policies" → "poli" + "y" pattern is too aggressive; collapse to "i"-less
    // stem "polic" instead by just dropping "es" (kept conservative).
    t = t.slice(0, -2);
  } else if (t.endsWith("es") && t.length > 4) {
    t = t.slice(0, -2);
  } else if (t.endsWith("s") && !t.endsWith("ss") && t.length > 3) {
    t = t.slice(0, -1);
  }

  // 2. -tion → -t (automation/automate share the "automat" stem). Guard length.
  if (t.endsWith("tion") && t.length > 5) {
    return ensureMinStem(`${t.slice(0, -4)}t`, original);
  }

  // 3. verb / agent-noun suffixes, then undo consonant doubling so a CVC-doubled
  //    form ("running") collapses onto its base ("run").
  if (t.endsWith("ing") && t.length > 5) {
    t = dropDoubledTail(t.slice(0, -3));
  } else if (t.endsWith("ed") && t.length > 4) {
    t = dropDoubledTail(t.slice(0, -2));
  } else if ((t.endsWith("er") || t.endsWith("or")) && t.length > 5) {
    t = dropDoubledTail(t.slice(0, -2));
  }

  // 4. strip a trailing silent -e so the bare base ("schedule") normalizes to the
  //    same stem as its inflections ("schedules"/"scheduling" → "schedul").
  if (t.endsWith("e") && t.length > 4) {
    t = t.slice(0, -1);
  }

  return ensureMinStem(t, original);
}

/** Guard: a stem must stay >= 3 chars; otherwise keep the original token. */
function ensureMinStem(stem: string, original: string): string {
  return stem.length >= 3 ? stem : original;
}

/** Collapse a trailing doubled consonant ("schedul"→"schedul", "runn"→"run"). */
function dropDoubledTail(t: string): string {
  if (
    t.length >= 3 &&
    t[t.length - 1] === t[t.length - 2] &&
    /[bcdfghjklmnpqrstvwxz]/.test(t[t.length - 1] ?? "")
  ) {
    return t.slice(0, -1);
  }
  return t;
}

/** Split a haystack into stemmed word tokens (PURE). */
function stemmedWords(haystack: string): readonly string[] {
  return tokenize(haystack).map(stemToken);
}

/** Whether the stemmed `needleWords` appear as an adjacent run in `hayWords`. */
function containsStemmedSequence(
  hayWords: readonly string[],
  needleWords: readonly string[],
): boolean {
  if (needleWords.length === 0) return false;
  if (needleWords.length === 1) {
    const w = needleWords[0];
    return w !== undefined && w.length > 0 && hayWords.includes(w);
  }
  for (let i = 0; i + needleWords.length <= hayWords.length; i++) {
    let ok = true;
    for (let j = 0; j < needleWords.length; j++) {
      if (hayWords[i + j] !== needleWords[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Whether `keyword` (a single word or multi-word phrase) is present in
 * `haystack` under FUZZY-LEXICAL matching:
 *   - both sides are tokenized and {@link stemToken}-stemmed, so morphological
 *     variants match (scheduling↔scheduler↔schedules);
 *   - matching is at WORD BOUNDARIES (token equality), so "cat" does NOT match
 *     inside "category" — fixing the old `includes()` substring precision bug;
 *   - a multi-word keyword must match as an ADJACENT stemmed sequence;
 *   - a narrow curated synonym map ({@link demandSynonymsFor}) expands the
 *     keyword to accepted variants (payroll↔wages, invoicing↔billing).
 *
 * PURE: no IO, deterministic. The synonym map is intentionally tight so recall
 * gains don't re-open the false-positive hole the relevance gate guards.
 */
export function matchesKeyword(haystack: string, keyword: string): boolean {
  if (!haystack || !keyword) return false;
  const hayWords = stemmedWords(haystack);
  if (hayWords.length === 0) return false;

  // The keyword itself, plus its curated synonyms, are each tried as a candidate.
  const candidates = [keyword, ...demandSynonymsFor(keyword)];
  for (const candidate of candidates) {
    const needleWords = tokenize(candidate).map(stemToken);
    if (containsStemmedSequence(hayWords, needleWords)) return true;
  }
  return false;
}

/** Literal (legacy) substring presence — used when fuzzy matching is disabled. */
function literalContains(lowerHaystack: string, keyword: string): boolean {
  return keyword.length > 0 && lowerHaystack.includes(keyword);
}

/**
 * The cheap DB-prefilter LIKE BODY for a keyword: the STEM of its most salient
 * (longest) word, so a `%stem%` ILIKE recall-filters morphological variants
 * (`scheduling` → `%schedul%` catches scheduler/schedules) while the precise
 * stem/boundary/synonym gate runs in code per row. For a multi-word keyword the
 * head word's stem is used (recall-safe OR-prefilter); for `fuzzy=false` the
 * verbatim keyword is returned (legacy literal prefilter). PURE.
 *
 * The returned value is the INNER text only (no `%` wrappers) — the caller binds
 * it as a parameter (`%${term}%`), so the keyword text is never concatenated into
 * SQL (injection-safe).
 */
export function keywordPrefilterTerm(keyword: string, fuzzy = true): string {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return kw;
  if (!fuzzy) return kw;
  const words = kw.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return kw;
  // Pick the longest word (most distinctive) and stem it for the LIKE body.
  let head = words[0] ?? kw;
  for (const w of words) {
    if (w.length > head.length) head = w;
  }
  return stemToken(head);
}

/**
 * RELEVANCE-GATE primitive — count how many DISTINCT candidate keywords co-occur
 * in `haystack`, so a probe can require ≥ N before treating the document as
 * demand evidence (see {@link DemandProbeOptions.minKeywordHits}).
 *
 * A MULTI-WORD keyword (a bigram like "glucose monitoring", "staff scheduling")
 * is itself an expression of co-occurrence — its parts already had to appear
 * adjacently in the candidate AND adjacently here — so a single phrase match
 * counts as `phraseWeight` (default 2) distinct hits, enough to clear the default
 * gate on its own. A single-word keyword counts as 1. This is what lets a
 * genuinely-on-topic phrase match a real review while a row that merely shares
 * one generic word ("tracking", "restaurant") cannot reach the threshold.
 *
 * Each distinct keyword is counted at most once (a keyword repeated in the text
 * does not inflate the hit count). PURE: no IO, deterministic.
 */
export function distinctKeywordHits(
  haystack: string,
  keywords: readonly string[],
  phraseWeight = 2,
  fuzzy = true,
): number {
  if (!haystack || keywords.length === 0) return 0;
  const lower = haystack.toLowerCase();
  const seen = new Set<string>();
  let hits = 0;
  for (const raw of keywords) {
    const kw = raw.toLowerCase();
    if (!kw || seen.has(kw)) continue;
    // Fuzzy (default): stem + word-boundary + curated synonyms. Literal
    // (fuzzy=false): legacy substring, restoring the pre-Lever-3 behavior.
    const present = fuzzy
      ? matchesKeyword(haystack, kw)
      : literalContains(lower, kw);
    if (!present) continue;
    seen.add(kw);
    // A space => multi-word phrase; weight it as strong co-occurrence.
    hits += kw.includes(" ") ? Math.max(1, Math.floor(phraseWeight)) : 1;
  }
  return hits;
}

/**
 * Deterministically extract salient demand KEYWORDS from a candidate's text.
 *
 * Tokenizes title + summary + problem statement (+ trend/audience), drops
 * stopwords + pipeline boilerplate, and keeps the most frequent salient
 * unigrams AND adjacent salient bigrams (bigrams ranked first — a noun phrase
 * like "expense report" is a sharper query than "expense" alone). PURE: no IO,
 * stable ordering, same input → same output.
 *
 * Frequency-weighted with title terms double-counted (a candidate's title is its
 * sharpest self-description). Ties broken by first-appearance order for stability.
 */
export function extractDemandKeywords(
  candidate: DemandCandidateText,
  opts: ExtractKeywordsOptions = {},
): readonly string[] {
  const maxKeywords =
    typeof opts.maxKeywords === "number" && opts.maxKeywords > 0
      ? Math.floor(opts.maxKeywords)
      : 12;
  const minLen =
    typeof opts.minTokenLength === "number" && opts.minTokenLength > 0
      ? Math.floor(opts.minTokenLength)
      : 3;

  // Title terms weigh double; gather (text, weight) segments deterministically.
  const segments: readonly { text: string; weight: number }[] = [
    { text: candidate.title ?? "", weight: 2 },
    { text: candidate.summary ?? "", weight: 1 },
    { text: candidate.reasoning ?? "", weight: 1 },
    { text: candidate.trendIntersection ?? "", weight: 1 },
    { text: candidate.targetAudience ?? "", weight: 1 },
  ];

  const unigramScore = new Map<string, number>();
  const bigramScore = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;

  for (const { text, weight } of segments) {
    if (!text) continue;
    const tokens = tokenize(text);
    let prevSalient: string | null = null;
    for (const token of tokens) {
      if (!isSalient(token, minLen)) {
        prevSalient = null;
        continue;
      }
      unigramScore.set(token, (unigramScore.get(token) ?? 0) + weight);
      if (!firstSeen.has(token)) firstSeen.set(token, order++);
      // Skip degenerate repeated-word bigrams ("logging logging") — they are
      // noise, not noun phrases.
      if (prevSalient && prevSalient !== token) {
        const bigram = `${prevSalient} ${token}`;
        bigramScore.set(bigram, (bigramScore.get(bigram) ?? 0) + weight);
        if (!firstSeen.has(bigram)) firstSeen.set(bigram, order++);
      }
      prevSalient = token;
    }
  }

  // Rank: bigrams first (sharper phrases), then unigrams; within each by score
  // desc, ties by first-appearance order asc for deterministic output.
  const rank = (entries: Map<string, number>): readonly string[] =>
    [...entries.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return (firstSeen.get(a[0]) ?? 0) - (firstSeen.get(b[0]) ?? 0);
      })
      .map(([k]) => k);

  // A bigram is only kept if at least one of its words is TOPICAL — a phrase of
  // two ultra-generic words ("easy login", "great app") is still corpus noise.
  const bigramIsTopical = (b: string): boolean =>
    b.split(" ").some((w) => !DEMAND_GENERIC_STOPWORDS.has(w));

  // Prefer bigrams that recurred (score>=2) up front; the rest interleave.
  const rankedBigrams = rank(bigramScore).filter(bigramIsTopical);
  const strongBigrams = rankedBigrams.filter((b) => (bigramScore.get(b) ?? 0) >= 2);
  const weakBigrams = rankedBigrams.filter((b) => (bigramScore.get(b) ?? 0) < 2);
  // Drop ultra-generic single tokens from the UNIGRAM set: a lone generic word
  // must not prefilter candidates or satisfy the co-occurrence relevance gate.
  const rankedUnigrams = rank(unigramScore).filter((u) =>
    isTopicalUnigram(u, minLen),
  );

  const ordered = [...strongBigrams, ...rankedUnigrams, ...weakBigrams];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const kw of ordered) {
    if (seen.has(kw)) continue;
    seen.add(kw);
    out.push(kw);
    if (out.length >= maxKeywords) break;
  }
  return out;
}

// ── Aggregation (PURE, deterministic) ─────────────────────────────────────────

/** Options for {@link aggregateDemand}. */
export interface AggregateDemandOptions {
  /**
   * Supply density in [0, 1]: how crowded the supply side already is for this
   * candidate's space (e.g. normalized count of competing apps/repos). Higher =
   * more crowded. Used to derive whitespace = demand intensity − supply density.
   * Optional; when absent, whitespace == demand intensity (no supply discount).
   */
  readonly supplyDensity?: number;
  /**
   * Minimum matched rows before evidence is considered corroborated. Below this
   * the artifact is nudged toward the absence regime (reduced confidence). NOT a
   * hard zero — a single strong funding hit still counts, just with low
   * confidence. Default 1 (any evidence corroborates).
   */
  readonly minMatches?: number;
}

/** Total weighted match count across all evidence (kind-weighted). */
function weightedMatchTotal(evidence: readonly DemandEvidence[]): number {
  let total = 0;
  for (const e of evidence) {
    const count = Number.isFinite(e.count) && e.count > 0 ? e.count : 0;
    const weight = DEMAND_KIND_WEIGHTS[e.kind] ?? 1;
    total += count * weight;
  }
  return total;
}

/** Deterministic log-scaled 0..5 demand score from a weighted match total. */
function scoreFromWeightedTotal(weightedTotal: number): number {
  if (weightedTotal <= 0) return 0;
  const scaled =
    (DEMAND_SCORE_MAX * Math.log1p(weightedTotal)) /
    Math.log1p(SCORE_SATURATION);
  return clamp(scaled, DEMAND_SCORE_MIN, DEMAND_SCORE_MAX);
}

/**
 * Deterministic confidence in [0,1] from evidence volume + source-kind
 * diversity. Volume term saturates at {@link CONFIDENCE_COUNT_SATURATION} total
 * matches; diversity term is (#distinct kinds / #possible kinds). Blended by the
 * VOLUME / DIVERSITY weights.
 */
function confidenceFromEvidence(
  evidence: readonly DemandEvidence[],
  totalMatches: number,
): number {
  if (evidence.length === 0 || totalMatches <= 0) return 0;
  const volumeTerm = clamp(
    totalMatches / CONFIDENCE_COUNT_SATURATION,
    0,
    1,
  );
  const distinctKinds = new Set(evidence.map((e) => e.kind)).size;
  const diversityTerm = clamp(
    distinctKinds / DEMAND_EVIDENCE_KINDS.length,
    0,
    1,
  );
  const blended =
    CONFIDENCE_VOLUME_WEIGHT * volumeTerm +
    CONFIDENCE_DIVERSITY_WEIGHT * diversityTerm;
  return clamp(blended, CONFIDENCE_MIN, CONFIDENCE_MAX);
}

/**
 * Combine cited evidence rows into a deterministic {@link DemandArtifact}.
 *
 * PURE — no DB / clock / rng. All numbers derive from the supplied evidence
 * COUNTS; this function never asserts demand on its own.
 *
 *   score      = log-scaled, kind-weighted match total, capped 0..5.
 *   confidence = blended volume + kind-diversity, 0..1.
 *   whitespace = demand intensity (score/5) − supplyDensity, clamped 0..1.
 *
 * ABSENCE PENALTY: when no evidence matched (or every count is 0), the artifact
 * is explicitly penalized — score <= {@link ABSENCE_SCORE_CAP}, confidence <=
 * {@link ABSENCE_CONFIDENCE_CAP}, whitespace 0. Absence is NEVER a neutral
 * middling score. When evidence exists but falls short of `minMatches`, the
 * score stands but confidence is dampened toward the absence regime.
 */
export function aggregateDemand(
  matches: readonly DemandEvidence[],
  opts: AggregateDemandOptions = {},
): DemandArtifact {
  const evidence = Array.isArray(matches) ? matches : [];
  const totalMatches = evidence.reduce(
    (sum, e) => sum + (Number.isFinite(e.count) && e.count > 0 ? e.count : 0),
    0,
  );
  const minMatches =
    typeof opts.minMatches === "number" && opts.minMatches >= 1
      ? Math.floor(opts.minMatches)
      : 1;

  // Absence regime: no usable evidence → explicit penalty, never neutral.
  if (evidence.length === 0 || totalMatches <= 0) {
    return {
      score: ABSENCE_SCORE_CAP,
      confidence: ABSENCE_CONFIDENCE_CAP,
      whitespace: 0,
      evidence,
    };
  }

  const weightedTotal = weightedMatchTotal(evidence);
  const score = scoreFromWeightedTotal(weightedTotal);

  let confidence = confidenceFromEvidence(evidence, totalMatches);
  // Below the corroboration floor, dampen confidence toward the absence cap so
  // a single thin match cannot masquerade as well-corroborated demand.
  if (totalMatches < minMatches) {
    confidence = Math.min(confidence, ABSENCE_CONFIDENCE_CAP);
  }

  // Whitespace = demand intensity (normalized score) discounted by supply
  // density. High = strongly wanted yet underserved.
  const supplyDensity =
    typeof opts.supplyDensity === "number"
      ? clamp(opts.supplyDensity, 0, 1)
      : 0;
  const demandIntensity = score / DEMAND_SCORE_MAX;
  const whitespace = clamp(demandIntensity - supplyDensity, 0, 1);

  return {
    score: clamp(score, DEMAND_SCORE_MIN, DEMAND_SCORE_MAX),
    confidence: clamp(confidence, CONFIDENCE_MIN, CONFIDENCE_MAX),
    whitespace,
    evidence,
  };
}

/**
 * Whether a demand artifact constitutes a CITED demand evidence-artifact for the
 * GIANT demand evidence-gate (giant.ts caps demand <=2 without one). True only
 * when there is at least one real matched evidence row AND the score cleared the
 * absence cap — i.e. the gate opens on cited buyer-intent, not on absence.
 */
export function hasCitedDemand(artifact: DemandArtifact): boolean {
  return (
    artifact.evidence.length > 0 && artifact.score > ABSENCE_SCORE_CAP
  );
}

// ── DemandProbe interface ─────────────────────────────────────────────────────

/** Options threaded into a {@link DemandProbe} at probe time. */
export interface DemandProbeOptions {
  /** Look-back window in seconds (probes compare epoch-int columns to now-window). */
  readonly windowSec?: number;
  /** Max rows a probe scans / returns (cost ceiling). */
  readonly limit?: number;
  /** Whether the externalTrends (paid vendor) probe is permitted to run. */
  readonly externalTrends?: boolean;
  /**
   * RELEVANCE GATE — minimum number of DISTINCT candidate keywords that must
   * co-occur in a single document for it to count as demand evidence. The DB
   * keyword-filter (OR semantics) is only a cheap candidate prefilter; this gate
   * is applied in code per row ({@link distinctKeywordHits}) to ensure the
   * document is actually ABOUT this idea, not just sharing one generic word like
   * "tracking" / "restaurant" / "monitor". Default {@link DEFAULT_MIN_KEYWORD_HITS}.
   */
  readonly minKeywordHits?: number;
  /**
   * Lever 3 — FUZZY LEXICAL MATCHING. When true (default), keyword matching uses
   * {@link matchesKeyword} (stem + word-boundary + curated synonyms) so
   * morphological variants and near-synonyms count. When false, matching falls
   * back to legacy literal substring, restoring the pre-Lever-3 behavior. The
   * word-boundary precision fix is part of the fuzzy path; flipping this off is a
   * full revert of Lever 3 for that probe.
   */
  readonly fuzzyMatch?: boolean;
  /**
   * Lever 1 — WEAK-INTENT gate. When true (default), a row that clears the
   * relevance gate and names a keyword but lacks a buyer-intent marker still
   * counts as WEAK demand evidence (same kind, count scaled by
   * {@link weakIntentFactor}) provided its engagement-weighted count reaches
   * {@link weakIntentMinEngagement}. When false, only marker-paired rows count
   * (today's strict behavior).
   */
  readonly weakIntent?: boolean;
  /** Multiplier applied to a WEAK (marker-less) row's count. Default 0.35, in 0..1. */
  readonly weakIntentFactor?: number;
  /**
   * Minimum engagement-weighted count a marker-less row must reach to qualify as
   * weak evidence (`1 + log1p(score+comments)`). Default 1.5 (≥ ~1 upvote/comment
   * of community signal). Guards against dead, zero-engagement keyword mentions.
   */
  readonly weakIntentMinEngagement?: number;
}

/**
 * A pluggable demand probe: given deterministic candidate keywords, return CITED
 * {@link DemandEvidence} from some source. Implementations read EXISTING scraped
 * tables (license-clean) or are stubbed/no-op when their source is paid/off.
 *
 * A probe MUST be graceful: on any failure it returns [] (the demand path is
 * optional and must never break the pipeline's default path).
 */
export interface DemandProbe {
  /** Stable identifier (for logging + the evidence audit trail). */
  readonly name: string;
  probe(
    keywords: readonly string[],
    opts: DemandProbeOptions,
  ): Promise<readonly DemandEvidence[]>;
}

// ── Zod schema (defensive parse of evidence / artifacts at boundaries) ─────────

/** Zod schema for a single demand evidence row. */
export const demandEvidenceSchema = z.object({
  kind: z.enum(DEMAND_EVIDENCE_KINDS),
  query: z.string(),
  count: z.number(),
  quote: z.string().optional(),
  sourceId: z.string().optional(),
});

/** Zod schema for a full demand artifact (used to validate persisted/JSON forms). */
export const demandArtifactSchema = z.object({
  score: z.number().min(DEMAND_SCORE_MIN).max(DEMAND_SCORE_MAX),
  confidence: z.number().min(CONFIDENCE_MIN).max(CONFIDENCE_MAX),
  whitespace: z.number().min(0).max(1),
  evidence: z.array(demandEvidenceSchema),
});
