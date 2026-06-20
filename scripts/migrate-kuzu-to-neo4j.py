#!/usr/bin/env python3
"""
One-off ops migration: backfill mem0's OLD Kùzu knowledge graph into the NEW
live Neo4j graph backend, in the exact shape mem0 (mem0ai==0.1.118) writes so
its own reads (`get_all` / `search` graph) recognize the migrated data.

WHY THIS EXISTS
---------------
The native-macOS mem0 stack migrated its graph backend kùzu -> neo4j. mem0
started a *fresh* Neo4j graph, but the old Kùzu graph (~61 MB; 5905 entities /
11967 relations across the real namespaces) is still on disk and holds the bulk
of SIGE's accumulated knowledge. This script imports it so SIGE keeps its memory.

TARGET SCHEMA — derived from mem0's own source, NOT guessed
-----------------------------------------------------------
Authoritative source read in the live venv:
  .../site-packages/mem0/memory/graph_memory.py
  .../site-packages/mem0/memory/utils.py  (sanitize_relationship_for_cypher)
  .../site-packages/mem0/graphs/configs.py (Neo4jConfig.base_label)

The live sidecar config (mem0-server/app.py :: _build_graph_config, neo4j path)
does NOT set `base_label`, so `MemoryGraph.node_label == ""` (graph_memory.py:43).
Consequences, all verified empirically against the live Neo4j graph:

  * Nodes carry a PER-ENTITY-TYPE label (e.g. `app`, `company`, `platform`),
    NOT a `__Entity__` base label. mem0's fallback type when the extractor does
    not classify a node is `__User__` (graph_memory.py:425). Kùzu's `Entity`
    table stores NO type/label column, so the original per-type label is
    unrecoverable — we apply `__User__`, mem0's own default. This is safe
    because every mem0 read uses the empty `node_label` and matches purely on
    `{user_id: ...}` (graph_memory.py:175, 286, 626) — the label is not part of
    any read filter.
  * Node properties mem0 sets: `name`, `user_id`, `embedding` (768-dim vector,
    written via `db.create.setNodeVectorProperty`, graph_memory.py:577/585),
    `mentions`, `created` (epoch-ms integer from `timestamp()`).
  * Node identity / MERGE key is `(name, user_id)` (graph_memory.py:559-560).
  * Relationships use a DYNAMIC TYPE built from the relationship text, lowercased
    with spaces -> underscores and run through `sanitize_relationship_for_cypher`
    (graph_memory.py:587, 612). Rel properties: `created`, `mentions`.

Kùzu names are already lowercase/underscored (mem0 wrote them the same way), so
they MERGE directly against mem0's freshly-written nodes — re-runs are idempotent.

SAFETY
------
  * Writes to the LIVE graph mem0 is actively using. MERGE only; never DELETE.
  * --dry-run is the DEFAULT: reads Kùzu, reports per-namespace counts, writes
    nothing. Use --apply to write.
  * Idempotent: MERGE on (name, user_id) for nodes and on (type, src, dst) for
    rels; re-running does not duplicate.
  * Reads Kùzu strictly read-only. Reads NEO4J_PASSWORD from ~/.opencrow/mem0/
    mem0.env (mode 0600); the password is never logged or echoed.
  * Junk/test namespaces are never migrated (see _JUNK_PATTERNS).

USAGE
-----
  python scripts/migrate-kuzu-to-neo4j.py                 # dry-run (default)
  python scripts/migrate-kuzu-to-neo4j.py --apply
  python scripts/migrate-kuzu-to-neo4j.py --apply --namespaces sige-global

Run with the venv that has both drivers:
  ~/.opencrow/mem0/app/.venv/bin/python scripts/migrate-kuzu-to-neo4j.py [...]
"""

from __future__ import annotations

import argparse
import datetime as _dt
import logging
import os
import re
import sys
from pathlib import Path

# ─── Defaults / constants ─────────────────────────────────────────────────────
_DEFAULT_KUZU_DB = os.path.expanduser("~/.opencrow/mem0/kuzu")
_DEFAULT_ENV_FILE = os.path.expanduser("~/.opencrow/mem0/mem0.env")
# The three real namespaces (user_id) worth migrating. Everything else is junk.
_DEFAULT_NAMESPACES = ("sige-global", "claude-code", "sige-ideas")
# Defensive deny-list: never migrate these even if explicitly requested.
_JUNK_PATTERNS = (
    r".*-deleteme$",
    r".*-check$",
    r"^perf-test.*",
    r"^quality-test.*",
    r"^restore-check.*",
    r"^permfix.*",
    r"^qat-.*",
    r"^shipcheck.*",
    r"^native-cutover.*",
)
# mem0's fallback node label for entities with no extracted type (its own default
# in graph_memory.py:425). Kùzu has no type column, so all migrated nodes use it.
_NODE_LABEL = "__User__"
_BATCH_SIZE = 500  # rows per write transaction (UNWIND batches)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kuzu->neo4j")


# ─── Relationship sanitization (must match mem0 exactly) ──────────────────────
# Mirror of mem0.memory.utils.sanitize_relationship_for_cypher applied after the
# lower()/space->underscore normalization mem0 does in _remove_spaces_from_entities.
# Kept inline so this one-off tool has no import-time dependency on mem0's package
# layout; the char map is copied verbatim from the installed source.
_SANITIZE_CHAR_MAP = {
    "...": "_ellipsis_", "…": "_ellipsis_", "。": "_period_", "，": "_comma_",
    "；": "_semicolon_", "：": "_colon_", "！": "_exclamation_", "？": "_question_",
    "（": "_lparen_", "）": "_rparen_", "【": "_lbracket_", "】": "_rbracket_",
    "《": "_langle_", "》": "_rangle_", "'": "_apostrophe_", '"': "_quote_",
    "\\": "_backslash_", "/": "_slash_", "|": "_pipe_", "&": "_ampersand_",
    "=": "_equals_", "+": "_plus_", "*": "_asterisk_", "^": "_caret_",
    "%": "_percent_", "$": "_dollar_", "#": "_hash_", "@": "_at_", "!": "_bang_",
    "?": "_question_", "(": "_lparen_", ")": "_rparen_", "[": "_lbracket_",
    "]": "_rbracket_", "{": "_lbrace_", "}": "_rbrace_", "<": "_langle_", ">": "_rangle_",
}
# After sanitization a valid Neo4j relationship type (used unquoted in our Cypher)
# must be alphanumeric/underscore. Anything else is rejected to avoid breaking the
# query or injecting Cypher.
_VALID_REL_TYPE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def sanitize_rel_type(raw: str) -> str | None:
    """Normalize a Kùzu CONNECTED_TO.name into mem0's relationship TYPE.

    Returns None if the result is empty or not a valid bare relationship type
    (caller skips such relations rather than risk a malformed/injected query).
    """
    if not raw:
        return None
    s = raw.lower().replace(" ", "_")
    for old, new in _SANITIZE_CHAR_MAP.items():
        s = s.replace(old, new)
    s = re.sub(r"_+", "_", s).strip("_")
    if not s or not _VALID_REL_TYPE.match(s):
        return None
    return s


# ─── env / secret loading ─────────────────────────────────────────────────────
def load_env_file(path: str) -> dict[str, str]:
    """Parse a KEY=VALUE env file. Values are never logged by this tool."""
    p = Path(path)
    if not p.is_file():
        raise SystemExit(f"env file not found: {path}")
    env: dict[str, str] = {}
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        env[key.strip()] = val.strip()
    return env


def to_epoch_ms(value: object) -> int | None:
    """Convert a Kùzu TIMESTAMP (python datetime) to epoch-ms, matching mem0's
    `timestamp()` (which Neo4j stores as an INTEGER of milliseconds)."""
    if value is None:
        return None
    if isinstance(value, _dt.datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=_dt.timezone.utc)
        return int(dt.timestamp() * 1000)
    if isinstance(value, (int, float)):
        return int(value)
    return None


# ─── Kùzu read side (strictly read-only) ──────────────────────────────────────
def _kuzu_rows(conn, cypher: str, params: dict | None = None) -> list[list]:
    res = conn.execute(cypher, parameters=params or {})
    rows: list[list] = []
    while res.has_next():
        rows.append(res.get_next())
    return rows


def read_entities(conn, namespace: str) -> list[dict]:
    """Read all entities for a namespace. embedding may be None/empty -> kept as None."""
    rows = _kuzu_rows(
        conn,
        """
        MATCH (e:Entity)
        WHERE e.user_id = $uid
        RETURN e.name, e.user_id, e.mentions, e.created, e.embedding
        """,
        {"uid": namespace},
    )
    out: list[dict] = []
    for name, uid, mentions, created, embedding in rows:
        if not name:
            continue  # name is the MERGE key; skip nameless rows
        emb = list(embedding) if embedding else None
        out.append(
            {
                "name": name,
                "user_id": uid,
                "mentions": int(mentions) if mentions is not None else 1,
                "created": to_epoch_ms(created),
                "embedding": emb,
            }
        )
    return out


def read_relations(conn, namespace: str) -> list[dict]:
    """Read all relations whose BOTH endpoints live in the namespace.

    Relations whose source or destination entity is outside the namespace (and so
    would not be migrated) are excluded here, so we never create a dangling rel to
    an un-migrated node.
    """
    rows = _kuzu_rows(
        conn,
        """
        MATCH (a:Entity)-[r:CONNECTED_TO]->(b:Entity)
        WHERE a.user_id = $uid AND b.user_id = $uid
        RETURN a.name, b.name, r.name, r.mentions, r.created
        """,
        {"uid": namespace},
    )
    out: list[dict] = []
    for src, dst, rel_name, mentions, created in rows:
        if not src or not dst:
            continue
        rel_type = sanitize_rel_type(rel_name or "")
        if rel_type is None:
            log.debug("skip rel with unmappable name %r (%s -> %s)", rel_name, src, dst)
            continue
        out.append(
            {
                "source": src,
                "destination": dst,
                "rel_type": rel_type,
                "mentions": int(mentions) if mentions is not None else 1,
                "created": to_epoch_ms(created),
            }
        )
    return out


# ─── Neo4j write side (MERGE only, idempotent) ────────────────────────────────
# Node upsert. Label is mem0's `__User__` default (Kùzu has no type column).
# embedding is written via setNodeVectorProperty so it lands as a real vector
# property, exactly as mem0 does — this is what makes mem0's cosine reads work.
# `created`/`mentions` are only set on first create so a re-run never clobbers
# values mem0 has since updated for nodes that already exist.
_NODE_MERGE_CYPHER = f"""
UNWIND $rows AS row
MERGE (n:`{_NODE_LABEL}` {{name: row.name, user_id: row.user_id}})
ON CREATE SET n.created = coalesce(row.created, timestamp()),
              n.mentions = coalesce(row.mentions, 1)
ON MATCH SET  n.created = coalesce(n.created, row.created, timestamp())
WITH n, row
WHERE row.embedding IS NOT NULL AND n.embedding IS NULL
CALL db.create.setNodeVectorProperty(n, 'embedding', row.embedding)
RETURN count(n) AS n
"""


def _rel_merge_cypher(rel_type: str) -> str:
    # rel_type is validated by sanitize_rel_type() (alnum/underscore only) before
    # it ever reaches here, so this back-tick interpolation cannot inject Cypher.
    return f"""
    UNWIND $rows AS row
    MATCH (s:`{_NODE_LABEL}` {{name: row.source, user_id: row.user_id}})
    MATCH (d:`{_NODE_LABEL}` {{name: row.destination, user_id: row.user_id}})
    MERGE (s)-[r:`{rel_type}`]->(d)
    ON CREATE SET r.created = coalesce(row.created, timestamp()),
                  r.mentions = coalesce(row.mentions, 1)
    RETURN count(r) AS n
    """


def _batched(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def apply_namespace(session, namespace: str, entities: list[dict], relations: list[dict]) -> tuple[int, int]:
    """MERGE entities then relations for one namespace. Returns (nodes, rels) written."""
    # Nodes first so every relation endpoint exists.
    nodes_done = 0
    for batch in _batched(entities, _BATCH_SIZE):
        session.run(_NODE_MERGE_CYPHER, rows=batch).consume()
        nodes_done += len(batch)
        log.info("  [%s] nodes merged %d/%d", namespace, nodes_done, len(entities))

    # Group relations by sanitized type — rel TYPE can't be a query parameter, so
    # we run one UNWIND batch per type. Each row still carries name/user_id for the
    # endpoint MATCH, keeping the batch tight.
    by_type: dict[str, list[dict]] = {}
    for rel in relations:
        by_type.setdefault(rel["rel_type"], []).append(
            {
                "source": rel["source"],
                "destination": rel["destination"],
                "user_id": namespace,
                "created": rel["created"],
                "mentions": rel["mentions"],
            }
        )

    rels_done = 0
    total_rels = sum(len(v) for v in by_type.values())
    for rel_type, rows in by_type.items():
        cypher = _rel_merge_cypher(rel_type)
        for batch in _batched(rows, _BATCH_SIZE):
            session.run(cypher, rows=batch).consume()
            rels_done += len(batch)
        log.info("  [%s] rels merged %d/%d (last type=%s)", namespace, rels_done, total_rels, rel_type)

    return nodes_done, rels_done


# ─── CLI ──────────────────────────────────────────────────────────────────────
def is_junk(namespace: str) -> bool:
    return any(re.match(p, namespace) for p in _JUNK_PATTERNS)


def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="Backfill mem0's old Kùzu graph into the live Neo4j graph (MERGE, idempotent).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument(
        "--apply",
        action="store_true",
        help="Write to Neo4j. Without this flag the script is a read-only dry-run.",
    )
    ap.add_argument(
        "--namespaces",
        default=",".join(_DEFAULT_NAMESPACES),
        help="Comma-separated user_id namespaces to migrate (junk namespaces are always skipped).",
    )
    ap.add_argument("--kuzu-db", default=_DEFAULT_KUZU_DB, help="Path to the old Kùzu DB (read-only).")
    ap.add_argument("--env-file", default=_DEFAULT_ENV_FILE, help="mem0.env holding NEO4J_* (mode 0600).")
    return ap.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)

    requested = [n.strip() for n in args.namespaces.split(",") if n.strip()]
    namespaces = []
    for ns in requested:
        if is_junk(ns):
            log.warning("refusing junk/test namespace, skipping: %s", ns)
            continue
        namespaces.append(ns)
    if not namespaces:
        log.error("no valid namespaces to migrate")
        return 2

    mode = "APPLY (writing to live Neo4j)" if args.apply else "DRY-RUN (no writes)"
    log.info("mode: %s", mode)
    log.info("namespaces: %s", ", ".join(namespaces))
    log.info("kuzu db: %s  (read-only)", args.kuzu_db)

    # Import drivers lazily so --help works without them installed.
    try:
        import kuzu
    except ImportError:
        log.error("kuzu driver not installed — run with ~/.opencrow/mem0/app/.venv/bin/python")
        return 3

    # ── Read side: open Kùzu read-only and collect per-namespace payloads ──────
    if not Path(args.kuzu_db).exists():
        log.error("kuzu db not found: %s", args.kuzu_db)
        return 3
    kdb = kuzu.Database(args.kuzu_db, read_only=True)
    kconn = kuzu.Connection(kdb)

    payloads: dict[str, dict] = {}
    grand_nodes = grand_rels = grand_skipped_emb = 0
    for ns in namespaces:
        ents = read_entities(kconn, ns)
        rels = read_relations(kconn, ns)
        no_emb = sum(1 for e in ents if e["embedding"] is None)
        grand_nodes += len(ents)
        grand_rels += len(rels)
        grand_skipped_emb += no_emb
        payloads[ns] = {"entities": ents, "relations": rels}
        log.info(
            "  [%s] entities=%d relations=%d (entities w/o embedding=%d)",
            ns, len(ents), len(rels), no_emb,
        )

    log.info("TOTAL to migrate: entities=%d relations=%d (no-embedding entities=%d)",
             grand_nodes, grand_rels, grand_skipped_emb)

    if not args.apply:
        log.info("dry-run complete — nothing written. Re-run with --apply to migrate.")
        return 0

    # ── Write side: connect to live Neo4j (password from env file, never logged) ─
    env = load_env_file(args.env_file)
    url = env.get("NEO4J_URL", "bolt://127.0.0.1:7687")
    user = env.get("NEO4J_USER", "neo4j")
    password = env.get("NEO4J_PASSWORD")
    if not password:
        log.error("NEO4J_PASSWORD missing from %s", args.env_file)
        return 4

    try:
        from neo4j import GraphDatabase
    except ImportError:
        log.error("neo4j driver not installed — run with ~/.opencrow/mem0/app/.venv/bin/python")
        return 3

    driver = GraphDatabase.driver(url, auth=(user, password))
    written_nodes = written_rels = 0
    try:
        driver.verify_connectivity()
        # mem0 leaves `database` unset -> default db. Use the driver default too.
        with driver.session() as session:
            for ns in namespaces:
                p = payloads[ns]
                log.info("applying namespace: %s", ns)
                n, r = apply_namespace(session, ns, p["entities"], p["relations"])
                written_nodes += n
                written_rels += r
    finally:
        driver.close()

    log.info("APPLY complete: merged nodes=%d rels=%d across %d namespace(s)",
             written_nodes, written_rels, len(namespaces))
    log.info("Re-running is safe (idempotent MERGE).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
