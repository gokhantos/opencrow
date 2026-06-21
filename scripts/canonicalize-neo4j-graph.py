#!/usr/bin/env python3
"""Re-runnable, reversible canonicalization of the mem0 Neo4j knowledge graph.

WHY THIS EXISTS
---------------
mem0 writes its graph store with a DYNAMIC relationship type and a per-entity
node label built from the extractor's free-text output (see
`scripts/migrate-kuzu-to-neo4j.py` for the mem0 schema derivation). Left alone,
that vocabulary sprawls: ~4785 distinct relationship types and ~442 node labels,
almost all singletons. SIGE's read-side graph reasoning
(`src/sige/knowledge/neo4j-client.ts`) filters traversal by a small whitelist of
meaningful relationship types — which only works if the graph speaks a small,
canonical vocabulary. This tool collapses the sprawl to a controlled set:

  ~4785 relationship types -> ~30 UPPERCASE canonical types
  ~442  node labels         -> ~19 canonical labels  (mem0's `__User__` untouched)

It MUST be re-run periodically. There is NO write-side prevention: mem0 keeps
writing raw free-text types/labels as new memories are ingested, so the graph
drifts back toward sprawl between runs. `src/sige/knowledge/neo4j-client.ts`
`REL_WHITELIST` is the canonical vocabulary's consumer and must stay in sync with
the canonical relationship set this tool produces.

FIVE PHASES (idempotent; phases 1-2 preserve the original so they are reversible)
------------------------------------------------------------------------------------
  1. RETYPE   relationships -> canonical type   (sets r.orig_type; skips already-done)
  2. RELABEL  typed nodes   -> canonical label  (sets n.orig_label; `__User__` skipped)
  3. MERGE    true duplicates (same lower(name)+user_id), rewiring edges onto the
              surviving typed node, then deleting the twin
  4. DELETE   pre-existing orphans + value/sentinel pseudo-entities (rating
              fractions, `user_id:` artifacts, etc.). `app_store`/`play_store`
              are real platforms and are NEVER deleted (they are relabeled in
              phase 2, not removed).
  5. INDEX    ensure the `:Entity` base label on every node, recompute the
              `degree` property, and create the three `:Entity` property indexes
              (`entity_user_id` / `entity_name` / `entity_degree`) the SIGE
              read-side graph-reasoning query relies on to stay INDEX-BACKED and
              avoid a per-node runtime degree subquery (the original >4min
              timeout). Additive + idempotent. MUST stay in sync with
              `src/sige/knowledge/neo4j-client.ts`.

Reversibility: every retyped edge keeps `orig_type` and every relabeled node
keeps `orig_label`, so the structural changes can be unwound. Phases 3/4 DELETE
and are not auto-reversible — that is why dry-run is the default and why the
deletion set is deliberately conservative (only PRE-EXISTING orphans, never nodes
newly orphaned by sentinel-hub removal, whose embeddings are preserved).

MAPPING DATA
------------
The canonical mapping is committed alongside this script as data so the APPLY
step NEVER needs to call an LLM:

  scripts/data/neo4j-reltype-map.json  (original_type  -> CANONICAL_TYPE)
  scripts/data/neo4j-label-map.json    (original_label -> Canonical_Label)

These were built in two stages: a curated rule-based head (the SYNONYM CLUSTERS
below) plus an LLM-refined tail (everything the rules dumped into the generic
RELATED_TO / Other bucket, re-classified into the controlled list). Regenerate
them only when the live vocabulary has drifted enough that the tail is stale:

  python3 scripts/canonicalize-neo4j-graph.py --refine   # re-runs the LLM tail

`--refine` reads the live label/reltype inventory from Neo4j, re-applies the
curated rules, LLM-classifies the remaining tail via the Alibaba token-plan
deepseek endpoint (MEM0_LLM_BASE_URL / MEM0_LLM_API_KEY / MEM0_LLM_MODEL, same
config the mem0 sidecar uses), and overwrites the two JSON map files. It does NOT
touch the graph.

USAGE
-----
  python3 scripts/canonicalize-neo4j-graph.py                  # dry-run (default)
  python3 scripts/canonicalize-neo4j-graph.py --apply          # write changes
  python3 scripts/canonicalize-neo4j-graph.py --refine         # regen maps (LLM)

SAFETY
------
  * Dry-run is the DEFAULT: reports per-phase counts, writes nothing.
  * Idempotent: re-runs skip edges/nodes already carrying orig_type/orig_label.
  * Loopback only: Neo4j HTTP tx API at http://127.0.0.1:7474 (mem0 is
    loopback-pinned). NEO4J_PASSWORD is read from the env or the mem0.env file
    (mode 0600) and is NEVER logged or echoed.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.request
from pathlib import Path

# ─── Defaults / constants ─────────────────────────────────────────────────────
_DIR = Path(__file__).resolve().parent
_DATA_DIR = _DIR / "data"
_RELTYPE_MAP_FILE = _DATA_DIR / "neo4j-reltype-map.json"
_LABEL_MAP_FILE = _DATA_DIR / "neo4j-label-map.json"
_DEFAULT_ENV_FILE = os.path.expanduser("~/.opencrow/mem0/mem0.env")
_DEFAULT_HTTP_URL = "http://127.0.0.1:7474/db/neo4j/tx/commit"
_DEFAULT_USER = "neo4j"
# mem0's structural base label for un-typed entities; NEVER remapped or deleted.
_USER_LABEL = "__User__"
_BATCH_SIZE = 40  # statements per HTTP tx batch

# value/sentinel node names to delete. app_store/play_store are REAL platforms and
# are deliberately EXCLUDED — they are relabeled in phase 2, never removed.
_STOPLIST_CYPHER = (
    "n.name STARTS WITH 'user_id:' "
    "OR n.name =~ '^\\\\d+\\\\s*/\\\\s*\\\\d+$' "  # 1/5 rating fractions
    "OR n.name =~ '(?i)^\\\\d+(\\\\.\\\\d+)?\\\\s*(stars?)?$' "  # 4, 4.5 stars
    "OR toLower(trim(n.name)) IN "
    "['sige-global','claude-code','green','blue','red','yellow','none','n/a','null']"
)


# ─── env / secret loading (password NEVER logged) ─────────────────────────────
def load_env_file(path: str) -> dict[str, str]:
    """Parse a KEY=VALUE env file. Missing file -> {} (env var may supply it)."""
    p = Path(path)
    if not p.is_file():
        return {}
    env: dict[str, str] = {}
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        env[key.strip()] = val.strip()
    return env


def resolve_password(env_file: str) -> str:
    """NEO4J_PASSWORD from the process env first, then the mem0.env file."""
    pw = os.environ.get("NEO4J_PASSWORD") or os.environ.get("MEM0_GRAPH_PASSWORD")
    if not pw:
        env = load_env_file(env_file)
        pw = env.get("NEO4J_PASSWORD") or env.get("MEM0_GRAPH_PASSWORD")
    if not pw:
        raise SystemExit(
            "NEO4J_PASSWORD not set (checked env vars and "
            f"{env_file}). Refusing to run."
        )
    return pw


# ─── Neo4j HTTP tx client (loopback) ──────────────────────────────────────────
class Neo4jHttp:
    """Minimal Neo4j HTTP transaction client. Auth header built from the password,
    which is held only in memory and never printed."""

    def __init__(self, url: str, user: str, password: str) -> None:
        self._url = url
        self._auth = "Basic " + base64.b64encode(
            f"{user}:{password}".encode()
        ).decode()

    def tx(self, statements: list[dict]) -> list[dict]:
        body = json.dumps({"statements": statements}).encode()
        req = urllib.request.Request(
            self._url,
            data=body,
            headers={"Authorization": self._auth, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=120) as r:
            d = json.loads(r.read())
        if d.get("errors"):
            raise RuntimeError(d["errors"])
        return d["results"]

    def one(self, stmt: str, params: dict | None = None) -> list[dict]:
        return self.tx([{"statement": stmt, "parameters": params or {}}])[0]["data"]

    def count(self, query: str) -> int:
        return self.one(query)[0]["row"][0]


def esc(label: str) -> str:
    """Backtick-escape a label/type for literal embedding in Cypher."""
    return "`" + label.replace("`", "``") + "`"


def chunked(seq: list, n: int):
    for i in range(0, len(seq), n):
        yield seq[i : i + n]


# ─── Canonicalization (the 4 phases) ──────────────────────────────────────────
def load_maps() -> tuple[dict[str, str], dict[str, str]]:
    if not _RELTYPE_MAP_FILE.is_file() or not _LABEL_MAP_FILE.is_file():
        raise SystemExit(
            f"mapping files missing under {_DATA_DIR}; run --refine to regenerate."
        )
    rel_map = json.loads(_RELTYPE_MAP_FILE.read_text())
    lbl_map = json.loads(_LABEL_MAP_FILE.read_text())
    return rel_map, lbl_map


def print_counts(db: Neo4jHttp, header: str) -> None:
    print(
        f"{header}:",
        "nodes",
        db.count("MATCH (n) RETURN count(n)"),
        "rels",
        db.count("MATCH ()-[r]->() RETURN count(r)"),
        "labels",
        db.count("CALL db.labels() YIELD label RETURN count(label)"),
        "reltypes",
        db.count(
            "CALL db.relationshipTypes() YIELD relationshipType "
            "RETURN count(relationshipType)"
        ),
    )


def phase1_retype(db: Neo4jHttp, rel_map: dict[str, str], apply: bool) -> None:
    changes = {o: c for o, c in rel_map.items() if c and c != o}
    todo: list[tuple[str, str, int]] = []
    for o, c in changes.items():
        cnt = db.count(
            f"MATCH ()-[r:{esc(o)}]->() WHERE r.orig_type IS NULL RETURN count(r)"
        )
        if cnt:
            todo.append((o, c, cnt))
    edges = sum(x[2] for x in todo)
    print(f"\nPHASE 1 RETYPE: {len(todo)} source types -> canonical, {edges} edges")
    if apply and todo:
        stmts = [
            {
                "statement": (
                    f"MATCH (a)-[r:{esc(o)}]->(b) WHERE r.orig_type IS NULL "
                    f"CREATE (a)-[r2:{esc(c)}]->(b) "
                    "SET r2 += properties(r), r2.orig_type = $o DELETE r"
                ),
                "parameters": {"o": o},
            }
            for o, c, _ in todo
        ]
        for batch in chunked(stmts, _BATCH_SIZE):
            db.tx(batch)
        print(f"  retyped {edges} edges")


def phase2_relabel(db: Neo4jHttp, lbl_map: dict[str, str], apply: bool) -> None:
    changes = {
        o: c for o, c in lbl_map.items() if c and c != o and o != _USER_LABEL
    }
    todo: list[tuple[str, str, int]] = []
    for o, c in changes.items():
        cnt = db.count(
            f"MATCH (n:{esc(o)}) WHERE n.orig_label IS NULL RETURN count(n)"
        )
        if cnt:
            todo.append((o, c, cnt))
    nodes = sum(x[2] for x in todo)
    print(f"\nPHASE 2 RELABEL: {len(todo)} source labels -> canonical, {nodes} nodes")
    if apply and todo:
        stmts = [
            {
                "statement": (
                    f"MATCH (n:{esc(o)}) WHERE n.orig_label IS NULL "
                    f"SET n:{esc(c)}, n.orig_label = $o REMOVE n:{esc(o)}"
                ),
                "parameters": {"o": o},
            }
            for o, c, _ in todo
        ]
        for batch in chunked(stmts, _BATCH_SIZE):
            db.tx(batch)
        print(f"  relabeled {nodes} nodes")


def phase3_merge(db: Neo4jHttp, apply: bool) -> None:
    dup_groups = db.one(
        "MATCH (n) WHERE n.name IS NOT NULL "
        "WITH toLower(trim(n.name)) AS nm, n.user_id AS uid, collect(n) AS ns "
        "WHERE size(ns) > 1 RETURN nm, uid, [x IN ns | id(x)] AS ids, "
        "[x IN ns | labels(x)[0]] AS labs"
    )
    print(f"\nPHASE 3 MERGE: {len(dup_groups)} true-duplicate groups")
    merged = 0
    for row in dup_groups:
        _nm, _uid, ids, labs = row["row"]
        # Keep the non-__User__ typed node; drop the rest.
        keep = next((i for i, l in zip(ids, labs) if l != _USER_LABEL), ids[0])
        drops = [i for i in ids if i != keep]
        if not drops:
            continue
        if apply:
            for d in drops:
                rels = db.one(
                    "MATCH (d)-[r]-(o) WHERE id(d)=$d "
                    "RETURN id(o) AS oid, type(r) AS ty, properties(r) AS p, "
                    "startNode(r)=d AS outgoing",
                    {"d": d},
                )
                for rr in rels:
                    oid, ty, p, outgoing = rr["row"]
                    if oid == keep:
                        continue  # would self-loop
                    if outgoing:
                        stmt = (
                            "MATCH (k),(o) WHERE id(k)=$k AND id(o)=$o "
                            f"MERGE (k)-[r2:{esc(ty)}]->(o) SET r2 += $p"
                        )
                    else:
                        stmt = (
                            "MATCH (k),(o) WHERE id(k)=$k AND id(o)=$o "
                            f"MERGE (o)-[r2:{esc(ty)}]->(k) SET r2 += $p"
                        )
                    db.one(stmt, {"k": keep, "o": oid, "p": p})
                db.one("MATCH (d) WHERE id(d)=$d DETACH DELETE d", {"d": d})
        merged += len(drops)
    print(f"  {'merged' if apply else 'would merge'} {merged} duplicate nodes")


def phase4_delete(db: Neo4jHttp, apply: bool) -> None:
    orphans = db.count("MATCH (n) WHERE NOT (n)--() RETURN count(n)")
    stop = db.count(f"MATCH (n) WHERE {_STOPLIST_CYPHER} RETURN count(n)")
    print(f"\nPHASE 4 DELETE: orphans {orphans}, stoplist {stop}")
    if apply:
        # Delete ONLY pre-existing orphans + explicit stoplist nodes. Do NOT
        # cascade-delete nodes newly orphaned by sentinel-hub removal — those are
        # real entities (kept, just disconnected; embeddings preserved).
        db.one("MATCH (n) WHERE NOT (n)--() DETACH DELETE n")
        db.one(f"MATCH (n) WHERE {_STOPLIST_CYPHER} DETACH DELETE n")
        print("  deleted pre-existing orphans + stoplist")


# SIGE read-side index requirements. The graph-reasoning Cypher
# (`src/sige/knowledge/neo4j-client.ts`) qualifies every traversed node to the
# `:Entity` base label and filters on a precomputed `n.degree` property so its
# bounded multi-hop query is INDEX-BACKED instead of doing a full-scan +
# per-node `COUNT { (n)--() }` (which timed out at >4min on sige-global). These
# three steps make that contract hold and are idempotent. Keep in sync with the
# index names / property in neo4j-client.ts.
_ENTITY_LABEL = "Entity"
_ENTITY_INDEXES = (
    ("entity_user_id", "user_id"),
    ("entity_name", "name"),
    ("entity_degree", "degree"),
)


def phase5_index(db: Neo4jHttp, apply: bool) -> None:
    """Ensure the `:Entity` base label, a recomputed `degree` property, and the
    three `:Entity` property indexes the SIGE graph-reasoning query relies on.

    Idempotent: labeling skips nodes already carrying `:Entity`; `degree` is
    recomputed wholesale (cheap relative to the rest of the run and correct after
    phases 1-4 may have changed connectivity); indexes use IF NOT EXISTS.
    """
    unlabeled = db.count(f"MATCH (n) WHERE NOT n:{esc(_ENTITY_LABEL)} RETURN count(n)")
    total = db.count("MATCH (n) RETURN count(n)")
    print(
        f"\nPHASE 5 INDEX: {unlabeled} nodes need :{_ENTITY_LABEL}, "
        f"{total} nodes will get degree recomputed, "
        f"{len(_ENTITY_INDEXES)} indexes ensured"
    )
    if not apply:
        return
    if unlabeled:
        db.one(f"MATCH (n) WHERE NOT n:{esc(_ENTITY_LABEL)} SET n:{esc(_ENTITY_LABEL)}")
    # Recompute degree for every Entity node (undirected degree, matching the
    # `COUNT { (n)--() }` the Cypher used to evaluate at query time).
    db.one(
        f"MATCH (n:{esc(_ENTITY_LABEL)}) SET n.degree = COUNT {{ (n)--() }}"
    )
    for name, prop in _ENTITY_INDEXES:
        db.one(
            f"CREATE INDEX {esc(name)} IF NOT EXISTS "
            f"FOR (n:{esc(_ENTITY_LABEL)}) ON (n.{prop})"
        )
    # Block until the new indexes are populated so the next read is fast.
    db.one("CALL db.awaitIndexes(120000)")
    print(
        f"  ensured :{_ENTITY_LABEL} on all nodes, recomputed degree, "
        "indexes ONLINE"
    )


def run_canonicalize(args: argparse.Namespace) -> int:
    rel_map, lbl_map = load_maps()
    password = resolve_password(args.env_file)
    db = Neo4jHttp(args.url, args.user, password)

    mode = "APPLY" if args.apply else "DRY-RUN"
    print(
        f"{mode} | rel mappings: {len(rel_map)}  label mappings: {len(lbl_map)}\n"
    )
    print_counts(db, "BEFORE")

    phase1_retype(db, rel_map, args.apply)
    phase2_relabel(db, lbl_map, args.apply)
    phase3_merge(db, args.apply)
    phase4_delete(db, args.apply)
    phase5_index(db, args.apply)

    if args.apply:
        print_counts(db, "\nAFTER")
    else:
        print("\n(dry-run — no changes written; re-run with --apply)")
    return 0


# ─── --refine: regenerate the mapping JSONs (curated rules + LLM tail) ─────────
# The curated SYNONYM CLUSTERS are the high-confidence head; the LLM only
# re-classifies the tail the rules dumped into the generic fallback bucket. Both
# are kept here so the data files can be regenerated from scratch.
_LABEL_CLUSTERS: dict[str, list[str]] = {
    "App": ["app", "mobile_app", "application", "web_application", "play_store_app",
            "app/product", "app/service", "app/game", "application/software",
            "ios_app", "android_app", "software_application", "app/brand",
            "business/app", "payment_service/app", "web_app"],
    "Game": ["game", "game/product", "video_game", "mobile_game", "game_mechanic",
             "in-game_purchase", "game_feature"],
    "Company": ["company", "organization", "organization/company", "company/service",
                "business", "brand", "brand/company", "brand/product", "vendor",
                "developer", "publisher", "corporation", "people", "person",
                "philosopher"],
    "Service": ["service", "product/service", "service/product", "web_service",
                "service/team", "service/department", "program/service",
                "payment_service", "component/service"],
    "Product": ["product", "physical_item", "physical_item/card", "product/food_item",
                "device", "device/product_component", "hardware"],
    "Platform": ["platform", "platform/website", "digital_storefront",
                 "operating_system", "operating_system_version", "website",
                 "web_application/website", "publication/media"],
    "Feature": ["feature", "app_feature", "game_feature", "feature/concept",
                "feature/application", "capability"],
    "Concept": ["concept", "technical_concept", "philosophy", "technique/method",
                "design_pattern", "algorithm", "algorithm/method",
                "algorithm/scoring_method", "methodology", "acronym/abbreviation"],
    "Idea": ["idea", "product_idea", "business_idea", "startup_idea"],
    "Rating": ["rating", "rating_label", "rating_(placeholder)", "star_rating"],
    "Issue": ["issue", "complaint/issue", "issue/problem", "problem", "bug",
              "complaint/title", "review_title/complaint", "phrase/message",
              "message"],
    "Technology": ["technology", "technology/tool", "technology/library", "software",
                   "software_component", "software/project", "software/platform",
                   "software_repository", "library", "framework",
                   "programming_language", "runtime_environment", "tool",
                   "software_tool", "vector_database", "database_system",
                   "database_concept", "database_index_type", "infrastructure",
                   "infrastructure_component"],
    "CodeArtifact": ["function", "method", "command", "script", "api_endpoint",
                     "pull_request", "port", "configuration_parameter",
                     "environment_variable", "database_operation", "database_object",
                     "database_table", "sql_command", "interface", "backend",
                     "process", "file", "source_file", "configuration_file",
                     "directory", "dataset"],
    "Location": ["location", "region", "country", "city", "scope"],
    "Category": ["category", "app_category", "genre", "role/user_type", "user_role",
                 "user_type", "role", "user_group"],
    "Model": ["ai_model", "model", "llm"],
    "Metric": ["metric", "metric_(placeholder)", "data", "visualization"],
    "LegalDoc": ["legal_document/policy", "legal_document", "article/post", "tv_show"],
}

_REL_CLUSTERS: dict[str, list[str]] = {
    "HAS_RATING": ["has_rating", "rating", "rating_for", "has_star_rating",
                   "given_rating", "received_rating", "has_review_rating"],
    "RATED": ["rated", "rates", "gave_rating", "gives_rating", "rated_on",
              "rated_with", "gave", "scored"],
    "REVIEWED": ["reviewed", "reviewed_on", "reviews", "wrote_review",
                 "left_review", "review", "reviewed_by"],
    "COMPLAINED_ABOUT": ["complained_about", "complaint_about", "complains_about",
                         "has_complaint_about", "is_subject_of_complaint",
                         "submitted_complaint_about", "complaint", "raised_complaint",
                         "complaining_about", "complaint_regarding", "complains"],
    "HAS_ISSUE": ["has_issue", "issue", "has_problem", "experiences_issue", "has_bug",
                  "suffers_from", "reports_issue", "experienced",
                  "has_difficulty_with", "encountered", "faces_issue"],
    "HAS_FEATURE": ["has_feature", "features", "feature", "offers_feature",
                    "with_feature"],
    "PROVIDES": ["provides", "offers", "includes", "contains", "supports", "enables",
                 "delivers", "gives", "providing", "provided", "has", "comes_with"],
    "AVAILABLE_ON": ["available_on", "is_available_on", "listed_on", "launched_on",
                     "distributed_on", "sold_on", "is_listed_on", "downloadable_on",
                     "available_for", "available_at", "found_on"],
    "HOSTED_ON": ["hosts", "hosted_on", "runs_on", "deployed_on", "hosted_by",
                  "hosting"],
    "POSTED_ON": ["posted_on", "published_on", "shared_on", "appears_on",
                  "submitted_on", "posted_to", "posted", "published"],
    "USES": ["uses", "used", "utilizes", "uses_technology", "built_with",
             "powered_by", "using", "leverages", "based_on", "implemented_with"],
    "REQUIRES": ["requires", "needs", "depends_on", "requires_access_to", "required",
                 "requiring", "needs_access_to"],
    "COMPATIBLE_WITH": ["compatible_with", "works_with", "integrates_with",
                        "supports_platform", "compatible", "interoperable_with"],
    "IS_A": ["is_a", "is", "is_a_type_of", "type_of", "instance_of", "is_an", "are",
             "is_type_of", "classified_as_a"],
    "IN_CATEGORY": ["category", "in_category", "categorized_as",
                    "belongs_to_category", "classified_as", "has_category",
                    "categorized_under", "genre"],
    "DESCRIBED_AS": ["described_as", "characterized_as", "known_as",
                     "referred_to_as", "describes", "labeled_as"],
    "TARGETS": ["targets", "designed_for", "serves", "intended_for", "aimed_at",
                "for_audience", "targeted_at", "meant_for", "serves_audience"],
    "DEVELOPED_BY": ["developed_by", "created_by", "made_by", "published_by",
                     "owned_by", "operated_by", "built_by", "produced_by",
                     "developed", "maker_of", "owns", "operates", "develops"],
    "PART_OF": ["part_of", "belongs_to", "component_of", "member_of", "contained_in",
                "subset_of", "within", "included_in"],
    "DISCUSSES": ["discusses", "mentions", "talks_about", "covers", "addresses",
                  "about", "discussed", "references", "discussing", "mentioned_in",
                  "concerns"],
    "PLATFORM_FOR": ["platform_for", "serves_as_platform", "marketplace_for"],
    "ALTERNATIVE_TO": ["alternative_to", "competes_with", "similar_to",
                       "competitor_of", "comparable_to", "rival_of", "vs"],
    "LOCATED_IN": ["located_in", "based_in", "in_region", "operates_in",
                   "located_at", "headquartered_in"],
    "HAS_PRICE": ["has_price", "priced_at", "costs", "charges", "priced", "has_cost",
                  "offered_at_price"],
    "USED_BY": ["used_by", "user_of", "has_user", "serves_user", "adopted_by",
                "downloaded_by", "installed_by"],
    "CAUSES": ["causes", "leads_to", "results_in", "triggers", "caused_by", "due_to",
               "resulting_in"],
    "LACKS": ["lacks", "missing", "does_not_have", "lacking", "without", "absent"],
    "RECOMMENDS": ["recommends", "suggests", "advises", "recommended"],
    "RELEASED_ON": ["released_on", "released", "updated_on", "version", "has_version"],
}


def _canon_label(lbl: str) -> str | None:
    if lbl == _USER_LABEL:
        return None  # never remap
    low = lbl.lower()
    for canon, members in _LABEL_CLUSTERS.items():
        if low in members:
            return canon
    if "/" in low:
        head = low.split("/")[0]
        for canon, members in _LABEL_CLUSTERS.items():
            if head in members:
                return canon
    return "Other"


def _canon_rel(t: str) -> str:
    low = t.lower().strip()
    for canon, members in _REL_CLUSTERS.items():
        if low in members:
            return canon
    return "RELATED_TO"


def _llm_classify(terms: list[str], canon: list[str], guide: str, kind: str) -> dict:
    import time

    base = os.environ["MEM0_LLM_BASE_URL"]
    key = os.environ["MEM0_LLM_API_KEY"]
    model = os.environ.get("MEM0_LLM_MODEL", "deepseek-v4-flash")
    numbered = "\n".join(f"{i + 1}. {t}" for i, t in enumerate(terms))
    prompt = (
        f"You normalize a knowledge-graph vocabulary. Map each input {kind} to "
        f"EXACTLY ONE canonical bucket from this controlled list:\n{guide}\n\n"
        "Rules: choose the closest semantic bucket; use the generic fallback only "
        "if nothing fits. Output ONLY a JSON object mapping each input number (as "
        "string) to a bucket name from the list. No prose, no code fences.\n\n"
        f"Inputs:\n{numbered}"
    )
    body = json.dumps(
        {
            "model": model,
            "enable_thinking": False,
            "temperature": 0,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 4000,
        }
    ).encode()
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    out = ""
    for i in range(4):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                out = json.loads(r.read())["choices"][0]["message"]["content"]
            break
        except Exception:
            if i == 3:
                raise
            time.sleep(2 * (i + 1))
    out = out.strip()
    if out.startswith("```"):
        out = out.split("```")[1].lstrip("json").strip()
    try:
        m = json.loads(out)
    except Exception:
        s, e = out.find("{"), out.rfind("}")
        m = json.loads(out[s : e + 1])
    allowed = set(canon)
    return {
        t: (m.get(str(i + 1)) if m.get(str(i + 1)) in allowed else canon[-1])
        for i, t in enumerate(terms)
    }


def run_refine(args: argparse.Namespace) -> int:
    password = resolve_password(args.env_file)
    db = Neo4jHttp(args.url, args.user, password)

    rel_inv = [
        (row["row"][0], 1)
        for row in db.one(
            "CALL db.relationshipTypes() YIELD relationshipType "
            "RETURN relationshipType"
        )
    ]
    lbl_inv = [
        (row["row"][0], 1)
        for row in db.one("CALL db.labels() YIELD label RETURN label")
    ]
    print(
        f"--refine: {len(rel_inv)} reltypes, {len(lbl_inv)} labels from live graph"
    )

    rel_guide = ", ".join(_REL_CLUSTERS.keys()) + ", RELATED_TO(generic/none)"
    lbl_guide = ", ".join(_LABEL_CLUSTERS.keys()) + ", Other(none of the above)"
    rel_canon = list(_REL_CLUSTERS.keys()) + ["RELATED_TO"]
    lbl_canon = list(_LABEL_CLUSTERS.keys()) + ["Other"]

    def build(inv, rule_fn, canon, guide, kind, fallback):
        rule_map = {}
        for name, _ in inv:
            rv = rule_fn(name)
            if rv is not None and rv != name:
                rule_map[name] = rv
        tail = [
            t
            for t, _ in inv
            if rule_map.get(t, fallback) == fallback and t != _USER_LABEL
        ]
        print(f"{kind}: {len(tail)} tail terms to LLM-classify")
        refined: dict[str, str] = {}
        for i in range(0, len(tail), 70):
            batch = tail[i : i + 70]
            try:
                refined.update(_llm_classify(batch, canon, guide, kind))
            except Exception as exc:
                # One malformed LLM response must not kill the whole refine.
                # Split into small sub-batches and retry; anything still failing
                # falls back to the generic bucket (lossless — --apply keeps
                # orig_type/orig_label, so a fallback edge is still recoverable).
                for j in range(0, len(batch), 10):
                    sub = batch[j : j + 10]
                    try:
                        refined.update(_llm_classify(sub, canon, guide, kind))
                    except Exception:
                        for t in sub:
                            refined[t] = fallback
                print(
                    f"{kind}: batch {i // 70 + 1} recovered via split-retry "
                    f"({type(exc).__name__})"
                )
        merged = {}
        for name, _ in inv:
            if name == _USER_LABEL:
                continue
            rv = rule_map.get(name, fallback)
            merged[name] = rv if rv != fallback else refined.get(name, fallback)
        return merged

    rel_map = build(rel_inv, _canon_rel, rel_canon, rel_guide, "reltype", "RELATED_TO")
    lbl_map = build(lbl_inv, _canon_label, lbl_canon, lbl_guide, "label", "Other")

    _DATA_DIR.mkdir(exist_ok=True)
    _RELTYPE_MAP_FILE.write_text(json.dumps(rel_map, indent=0))
    _LABEL_MAP_FILE.write_text(json.dumps(lbl_map, indent=0))
    print(
        f"wrote {_RELTYPE_MAP_FILE.name} ({len(set(rel_map.values()))} canonical) "
        f"and {_LABEL_MAP_FILE.name} ({len(set(lbl_map.values()))} canonical)"
    )
    return 0


# ─── CLI ──────────────────────────────────────────────────────────────────────
def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "--apply",
        action="store_true",
        help="Write canonicalization to the live graph (default: dry-run).",
    )
    ap.add_argument(
        "--refine",
        action="store_true",
        help="Regenerate the mapping JSONs from the live vocab via the LLM tail "
        "(does NOT touch the graph). Requires MEM0_LLM_* env.",
    )
    ap.add_argument("--url", default=_DEFAULT_HTTP_URL, help="Neo4j HTTP tx endpoint.")
    ap.add_argument("--user", default=_DEFAULT_USER, help="Neo4j user.")
    ap.add_argument(
        "--env-file",
        default=_DEFAULT_ENV_FILE,
        help="mem0.env holding NEO4J_PASSWORD (mode 0600); env var wins if set.",
    )
    return ap.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.refine:
        return run_refine(args)
    return run_canonicalize(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
