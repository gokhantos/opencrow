"""
Mem0 sidecar for OpenCrow / SIGE.

Exposes the *hosted-platform-shaped* endpoints that `src/sige/knowledge/mem0-client.ts`
already calls (`/v1/memories/`, `/v1/memories/search/`, …), backed by a self-hosted
mem0 SDK instance wired to:
  - vector store : Qdrant   (existing container)
  - graph store  : Neo4j    (relations — the only thing SIGE reads)
  - embedder     : Ollama   (host-native, nomic-embed-text)
  - extraction   : Ollama   (host-native, via the OpenAI-compatible /v1 endpoint)

This deliberately mirrors the client's request/response contract so no TypeScript
client changes are needed.

Two Memory instances back the ADD path, differing only in whether a graph_store is
configured (same Qdrant collection / embedder / llm otherwise):
  - `_memory`          — graph_store configured → graph extraction ON (SIGE writes).
  - `_memory_nograph`  — no graph_store → graph phase skipped → ~embedding-latency
                         fast (agent-memory writes, the Qdrant→mem0 migration path).
The `enable_graph` flag in ADD request bodies is now HONORED: `enable_graph: false`
routes the write to the graph-less instance; unset/true keeps the graph-on instance
so SIGE's behavior is byte-identical. Reads (search/get_all/delete) always run on
`_memory`; because both instances share the SAME Qdrant collection, graph-less writes
are still returned by the existing search path (scoped by user_id).
"""
import os
import re
import logging
import secrets
import time

from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("mem0-sidecar")


# ─── CRITICAL: neutralize mem0's per-call PostHog telemetry (thread leak) ───────
# mem0 0.1.118's `mem0.memory.telemetry.capture_event` constructs a BRAND-NEW
# `AnonymousTelemetry()` on EVERY call, which constructs a brand-new `Posthog`
# client, which starts a daemon `Consumer` thread in its constructor and is never
# `.shutdown()`/`.close()`'d. mem0 calls `capture_event` on every add / search /
# get / _create_memory (per verbatim chunk on infer:false writes), so each write
# permanently leaks ~1 live OS thread. The Consumer's `run()` is `while
# self.running:` and `self.running` only flips on `pause()` (called from
# `shutdown()`), so the thread never exits — a TRUE unbounded leak, not a
# transient spike. Under a high-volume backfill the sidecar's thread count climbs
# monotonically until it hits `ulimit -u` (4000) and the runtime raises
# "can't start new thread", then even /health fails.
#
# `MEM0_TELEMETRY=false` does NOT fix this: that flag only sets
# `posthog.disabled = True`, which gates *sending* — the Consumer thread is still
# started in `Posthog.__init__` regardless (measured: 50 AnonymousTelemetry() with
# MEM0_TELEMETRY=false still leaked 50+ threads). The robust fix is to stop the
# per-call client construction entirely: replace `capture_event` /
# `capture_client_event` with no-ops, and neuter `AnonymousTelemetry` so neither
# the module-level `client_telemetry` singleton nor any stray construction can
# spawn a Posthog Consumer.
#
# This is patched BEFORE `from mem0 import Memory` so that when `mem0.memory.main`
# / `mem0.proxy.main` do `from mem0.memory.telemetry import capture_event` (a
# by-name binding at import time), they bind the no-op. We also overwrite the name
# in already-loaded mem0 namespaces defensively in case import order ever changes.
# Self-hosted OpenCrow has no use for mem0's anonymous usage analytics, so dropping
# them is purely upside. The vector/graph/embedder/LLM paths are untouched — only
# the analytics side-channel is removed.
def _disable_mem0_telemetry() -> None:
    try:
        import mem0.memory.telemetry as _tel
    except Exception as err:  # noqa: BLE001 — never block startup on telemetry
        log.warning("could not load mem0 telemetry module to disable it: %s", err)
        return

    def _noop_capture_event(*_args, **_kwargs) -> None:
        return None

    def _noop_capture_client_event(*_args, **_kwargs) -> None:
        return None

    # 1) Replace the functions at their source so any LATER by-name import binds
    #    the no-op.
    _tel.capture_event = _noop_capture_event
    _tel.capture_client_event = _noop_capture_client_event

    # 1b) CRITICAL: `mem0.memory.main` (and possibly `mem0.proxy.main`) is already
    #     imported transitively by `import mem0` BEFORE this runs, and it did
    #     `from mem0.memory.telemetry import capture_event` — a by-name binding
    #     that captured the ORIGINAL function. Patching `_tel.capture_event` alone
    #     does not update that already-bound copy, so the hot call sites
    #     (`_create_memory`, `add`, `search`, …) would still construct a Posthog
    #     client per call. Overwrite the by-name binding in every loaded module
    #     that holds one.
    import sys

    for _mod in list(sys.modules.values()):
        if _mod is None or getattr(_mod, "__name__", "").startswith("mem0") is False:
            continue
        if getattr(_mod, "capture_event", None) is not None:
            _mod.capture_event = _noop_capture_event
        if getattr(_mod, "capture_client_event", None) is not None:
            _mod.capture_client_event = _noop_capture_client_event

    # 2) Neuter the class so the module-level `client_telemetry` singleton (already
    #    constructed at import of this module) and any stray construction can never
    #    start a Posthog Consumer thread. We null out the posthog client and make
    #    capture_event/close no-ops on every instance.
    class _InertTelemetry:  # noqa: D401 — drop-in inert replacement
        def __init__(self, *_args, **_kwargs) -> None:
            self.posthog = None
            self.user_id = "disabled"

        def capture_event(self, *_a, **_k) -> None:
            return None

        def close(self) -> None:
            return None

    _tel.AnonymousTelemetry = _InertTelemetry
    # The already-built singleton may hold a live Posthog client (1 thread).
    # Shut it down so we don't even leak that one, then replace it.
    try:
        existing = getattr(_tel, "client_telemetry", None)
        if existing is not None and getattr(existing, "posthog", None) is not None:
            existing.posthog.shutdown()
    except Exception:  # noqa: BLE001 — best-effort cleanup
        pass
    _tel.client_telemetry = _InertTelemetry()

    log.info("mem0 telemetry disabled (no per-call PostHog client / thread leak)")


_disable_mem0_telemetry()

from mem0 import Memory  # noqa: E402 — imported AFTER telemetry is neutralized


# ─── CRITICAL: make the Ollama embedder tolerate over-context chunks ────────────
# mem0 0.1.118's `OllamaEmbedding.embed` calls the ollama-python client's LEGACY
# `Client.embeddings(model=..., prompt=text)` → Ollama's deprecated
# `POST /api/embeddings`. That path passes NO `options` and NO `truncate`, and —
# verified against the live sidecar's Ollama — the legacy endpoint IGNORES
# `options.num_ctx` and HARD-ERRORS (HTTP 500 "the input length exceeds the
# context length") whenever a chunk's token count exceeds nomic-embed-text's
# loaded context. nomic's modelfile loads a 2048-token context by default, so
# dense content (reddit/markdown/URL-heavy) blows past it in ~4.5k chars. This
# broke (a) the Qdrant→mem0 backfill (failed mid-run) and (b) every live SIGE /
# agent-memory write of a dense chunk — both embed through this same code path.
#
# mem0 0.1.118 exposes NO config passthrough for `num_ctx`/`truncate`/endpoint
# (the embedder config block only accepts model / ollama_base_url /
# embedding_dims), so this cannot be fixed by config alone. We instead replace
# `OllamaEmbedding.embed` with a drop-in that calls the MODERN
# `Client.embed(model, input, truncate=True, options={"num_ctx": …})` →
# `POST /api/embed`, which (verified live):
#   - HONORS `options.num_ctx` (raise the window to nomic's supported 8192, so
#     chunks up to ~8192 tokens embed with ZERO data loss — the 4,503-char
#     reddit chunk fits fully), and
#   - HONORS `truncate=True` (safety net: a genuinely huge >8192-token input is
#     truncated to the window instead of erroring — lossy only for pathological
#     inputs, but it NEVER 500s).
# `num_ctx` alone is insufficient (a 28k-char input still exceeds 8192 tokens →
# 400) and `truncate` alone keeps only 2048 tokens; combining both maximizes
# fidelity while guaranteeing no error. This mirrors the OpenCrow Qdrant path
# (`src/memory/embeddings.ts`), which already tolerates these same chunks because
# Ollama's OpenAI-compatible `/v1/embeddings` truncates by default.
#
# Patched at the CLASS level, so it applies identically to BOTH Memory instances
# (graph-on SIGE writes and graph-off agent-memory writes share the one embedder
# class) — SIGE's graph path is otherwise byte-identical. The output (a list of
# floats) and the EmbeddingBase contract are unchanged, so mem0's vector-store
# and dimension handling are unaffected.
def _patch_ollama_embedder_context() -> None:
    try:
        from mem0.embeddings.ollama import OllamaEmbedding
    except Exception as err:  # noqa: BLE001 — never block startup on the patch
        log.warning("could not patch Ollama embedder context: %s", err)
        return

    # Read directly (not via _int_env, which is defined later in this module —
    # this patch runs at import time, right after `from mem0 import Memory`).
    try:
        num_ctx = int(os.environ.get("MEM0_EMBED_NUM_CTX", "8192"))
    except (TypeError, ValueError):
        num_ctx = 8192

    def embed(self, text, memory_action=None):  # type: ignore[no-untyped-def]
        # Modern /api/embed: honors num_ctx + truncate (legacy /api/embeddings
        # ignores both and 500s on over-context input). truncate=True is the
        # never-error guarantee; num_ctx=8192 keeps full fidelity up to nomic's
        # supported ceiling so realistic chunks lose nothing.
        response = self.client.embed(
            model=self.config.model,
            input=text,
            truncate=True,
            options={"num_ctx": num_ctx},
        )
        # /api/embed returns {"embeddings": [[...]]} (batched), vs legacy
        # /api/embeddings' {"embedding": [...]}. We embed a single string, so the
        # vector is embeddings[0]; fall back to the legacy key defensively.
        embeddings = response.get("embeddings")
        if embeddings:
            return embeddings[0]
        return response["embedding"]

    OllamaEmbedding.embed = embed
    log.info(
        "Ollama embedder patched: /api/embed with num_ctx=%d + truncate "
        "(no 500 on over-context chunks)",
        num_ctx,
    )


_patch_ollama_embedder_context()


# ─── Optional: disable hosted "reasoning"/thinking on the extraction LLM ───────
# Some hosted OpenAI-compatible models (e.g. the Alibaba token-plan DeepSeek/Qwen
# family) are *reasoning* models: they emit a hidden chain-of-thought and make
# mem0's always-on graph-extraction phase stall — it issues sequential
# tool-calling completions that never return. Those endpoints honour a top-level
# `enable_thinking: false` flag to turn thinking off, but mem0's OpenAI LLM config
# exposes no passthrough for it. When MEM0_LLM_DISABLE_THINKING is truthy we wrap
# the OpenAI client so every chat.completions.create injects
# `extra_body={"enable_thinking": False}`. This covers both the main extraction
# LLM and the graph LLM (same client class). Embeddings use the Ollama provider
# (a different client) and are unaffected; the local-gemma path leaves the flag
# unset, so its requests are untouched.
def _maybe_disable_thinking() -> None:
    flag = (os.environ.get("MEM0_LLM_DISABLE_THINKING") or "").strip().lower()
    if flag not in ("1", "true", "yes", "on"):
        return
    try:
        from openai.resources.chat import completions as _completions
    except Exception as err:  # noqa: BLE001 — best-effort; never block startup
        log.warning("could not patch OpenAI client to disable thinking: %s", err)
        return
    original = _completions.Completions.create
    if getattr(original, "_nothink_wrapped", False):
        return

    def create(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        extra_body = dict(kwargs.get("extra_body") or {})
        extra_body.setdefault("enable_thinking", False)
        kwargs["extra_body"] = extra_body
        return original(self, *args, **kwargs)

    create._nothink_wrapped = True  # type: ignore[attr-defined]
    _completions.Completions.create = create
    log.info(
        "extraction LLM: reasoning disabled (injecting enable_thinking=false)"
    )


_maybe_disable_thinking()


# ─── Write-time relationship-type normalization (UPPERCASE canonical) ──────────
# mem0 0.1.118's graph write path LOWERCASES every extracted relationship before
# the Neo4j MERGE. In `mem0/memory/graph_memory.py`,
# `MemoryGraph._remove_spaces_from_entities` does (≈ line 612):
#
#     item["relationship"] = sanitize_relationship_for_cypher(
#         item["relationship"].lower().replace(" ", "_"))
#
# so every fresh graph edge lands lowercase (e.g. `complained_about`, `uses`,
# `available_on`). But the mem0↔Neo4j graph is meant to be canonicalized to
# UPPERCASE rel types: SIGE's REL_WHITELIST (src/sige/knowledge/neo4j-client.ts)
# is UPPERCASE-only. Canonicalization currently runs ONLY as a weekly launchd
# backfill (`ai.opencrow.canonicalize`, Sun 04:00, scripts/canonicalize-neo4j-
# graph.py) with NO write-time enforcement, so the graph re-drifts to lowercase
# within hours of each run.
#
# This patch enforces UPPERCASE AT WRITE so the graph is stored canonical at
# rest, the weekly --refine has a near-zero rel-type tail, and other graph
# consumers see canonical types. It complements (does not replace) the read-side
# case-insensitive fix in neo4j-client.ts (`toUpper(type(r)) IN $relWhitelist`,
# PR #247) — the two are defense-in-depth.
#
# Mechanism: wrap `sanitize_relationship_for_cypher` so its return value is
# upper-cased. Because line 612 calls it as the OUTERMOST transform building the
# final `item["relationship"]`, upper-casing its output guarantees every written
# rel type is UPPERCASE canonical:
#   "complained about" → .lower() → "complained_about"
#                      → sanitize → "complained_about"
#                      → .upper() → "COMPLAINED_ABOUT".
# Deterministic, NO LLM call, fail-safe.
#
# SCOPE: relationship TYPES only. Node/entity labels (e.g. `function`,
# `source_file`) are a SEPARATE axis — SIGE reads rels, not labels — and are left
# to the weekly canonicalizer; we do NOT touch them, nor the vector/embedder/LLM/
# Qdrant paths, the dual graph-on/graph-less design, or the response-shape
# helpers (`_normalize_relation`/`_flatten_relations`).
# Any char that is NOT a valid UNQUOTED Cypher identifier char. mem0 interpolates
# the relationship straight into `MERGE (s)-[r:{relationship}]->(d)` with NO
# backticks, so the rel type MUST be `[A-Za-z_][A-Za-z0-9_]*` or Neo4j raises a
# SyntaxError and the WHOLE graph write 500s. mem0's `sanitize_relationship_for_
# cypher` char-map misses some chars (notably `-` / ASCII `.`), so e.g. an
# extracted "Postgres-only" → `IS_POSTGRES-ONLY` → `[r:IS_POSTGRES-ONLY]` →
# `Invalid input '-'`. We coerce to a guaranteed-valid identifier as a backstop.
_INVALID_REL_CHARS = re.compile(r"[^A-Za-z0-9_]")


def _canonicalize_rel_type(s: str) -> str:
    """Canonical rel-type form written to Neo4j: UPPERCASE, valid Cypher id.

    UPPERCASE (matches SIGE's REL_WHITELIST) + coerced to a valid unquoted
    Cypher relationship-type identifier: every non-`[A-Za-z0-9_]` char (hyphen,
    ASCII period, etc. that mem0's own sanitizer leaves through) → `_`, runs of
    `_` collapsed and trimmed, a leading digit prefixed with `_` (an identifier
    cannot start with a digit), and an empty result falls back to `RELATED_TO`.
    Pure string transform, no mem0 dependency — independently unit-testable.
    """
    out = _INVALID_REL_CHARS.sub("_", str(s).upper())
    out = re.sub(r"_+", "_", out).strip("_")
    if out and out[0].isdigit():
        out = "_" + out
    return out or "RELATED_TO"


def _uppercase_relationship(orig):  # type: ignore[no-untyped-def]
    """Wrap a `sanitize_relationship_for_cypher`-shaped fn to UPPERCASE its output."""

    def wrapped(*args, **kwargs):  # type: ignore[no-untyped-def]
        return _canonicalize_rel_type(orig(*args, **kwargs))

    # Tag so a re-import of this module never double-wraps (idempotent).
    wrapped._reltype_upper_wrapped = True  # type: ignore[attr-defined]
    return wrapped


def _enable_reltype_write_normalization() -> None:
    """Rebind `sanitize_relationship_for_cypher` to UPPERCASE its result.

    `mem0/memory/graph_memory.py` does `from mem0.memory.utils import
    sanitize_relationship_for_cypher` at import, so the name is bound INTO the
    `graph_memory` module namespace. Line 612 resolves the call against THAT
    module global — so rebinding `mem0.memory.graph_memory.sanitize_relationship_
    for_cypher` is what actually takes effect at write time. We also rebind the
    original home (`mem0.memory.utils`) for completeness. We explicitly import
    `graph_memory` here because `from mem0 import Memory` does not eagerly load it
    (it's imported lazily when a graph-enabled Memory is built); importing it now
    forces the binding to exist before we patch it.

    Fail-safe: if a future mem0 lays this out differently and the symbol is
    missing, we WARN and continue — the read-side toUpper fix still covers
    correctness if this no-ops. Never crash sidecar startup over it.
    """
    try:
        import mem0.memory.graph_memory as _gm
        import mem0.memory.utils as _utils
    except Exception as err:  # noqa: BLE001 — best-effort; never block startup
        log.warning(
            "could not load mem0 graph modules for rel-type write normalization: %s",
            err,
        )
        return

    patched_any = False
    for _mod in (_gm, _utils):
        fn = getattr(_mod, "sanitize_relationship_for_cypher", None)
        if fn is None:
            log.warning(
                "rel-type write normalization: sanitize_relationship_for_cypher "
                "missing on %s (mem0 internals changed?) — skipping",
                getattr(_mod, "__name__", _mod),
            )
            continue
        if getattr(fn, "_reltype_upper_wrapped", False):
            # Already wrapped (module re-imported) — idempotent no-op.
            patched_any = True
            continue
        _mod.sanitize_relationship_for_cypher = _uppercase_relationship(fn)
        patched_any = True

    if patched_any:
        # Distinctive string for deploy verification (greppable in startup logs).
        log.info("graph rel-type write normalization active (UPPERCASE at write)")
    else:
        log.warning(
            "graph rel-type write normalization NOT applied "
            "(symbol missing on both modules) — relying on read-side toUpper fix"
        )


_enable_reltype_write_normalization()


# ─── Inbound auth ───────────────────────────────────────────────────────────
# mem0ai (0.1.118) ships no auth on its memory API (GHSA-jfv9-68m5-gjjr). We add
# a shared bearer-token check at the application layer as defense-in-depth on the
# internal Docker network (the host port is already loopback-only). The expected
# token is read once at import from MEM0_API_TOKEN.
#
# Fail-LOUD-but-safe when unconfigured: an unset/empty token does NOT silently
# open the API — guarded endpoints reject with 503 "auth not configured" and a
# prominent startup WARNING fires, so a misconfigured deploy is obvious instead
# of silently unauthenticated. /health stays open regardless.
_API_TOKEN = (os.environ.get("MEM0_API_TOKEN") or "").strip()

# auto_error=False so we return our own 401 (with WWW-Authenticate) instead of
# FastAPI's default 403 when the header is missing.
_bearer = HTTPBearer(auto_error=False)


def require_token(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> None:
    """Reject unless the request carries the matching shared bearer token."""
    if not _API_TOKEN:
        # Unconfigured → fail closed (loud, not silently open).
        raise HTTPException(
            status_code=503,
            detail="mem0 sidecar auth not configured (MEM0_API_TOKEN unset)",
        )
    presented = creds.credentials if creds else ""
    # Constant-time compare — never `==` on a secret.
    if not secrets.compare_digest(presented, _API_TOKEN):
        raise HTTPException(
            status_code=401,
            detail="invalid or missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


EMBED_DIMS = _int_env("MEM0_EMBED_DIMS", 768)


def _build_graph_config() -> dict:
    """
    Graph store. Defaults to Kùzu — an embedded, in-process graph DB (no server,
    no JVM, no extra container). Set MEM0_GRAPH_PROVIDER=neo4j + NEO4J_* to use a
    standalone Neo4j instead.
    """
    provider = os.environ.get("MEM0_GRAPH_PROVIDER", "kuzu")
    if provider == "neo4j":
        return {
            "provider": "neo4j",
            "config": {
                "url": os.environ.get("NEO4J_URL", "bolt://neo4j:7687"),
                "username": os.environ.get("NEO4J_USER", "neo4j"),
                "password": os.environ["NEO4J_PASSWORD"],
            },
        }
    return {
        "provider": "kuzu",
        "config": {"db": os.environ.get("MEM0_GRAPH_DB", "/data/kuzu")},
    }


def _build_llm_config() -> dict:
    """
    Extraction LLM. Defaults to local Ollama (no external key, fully self-hosted).
    The `openai` provider is used for the local Ollama OpenAI-compatible endpoint
    (MEM0_LLM_BASE_URL=http://host.docker.internal:11434/v1). There is intentionally
    NO external default model: MEM0_LLM_MODEL must be set explicitly so extraction can
    never silently fall back to a hosted/Anthropic model. Use a non-reasoning model:
    reasoning models stall the always-on graph phase.
    """
    provider = os.environ.get("MEM0_LLM_PROVIDER", "ollama")
    if provider == "openai":
        model = os.environ.get("MEM0_LLM_MODEL")
        if not model:
            raise RuntimeError(
                "MEM0_LLM_MODEL must be set when MEM0_LLM_PROVIDER=openai "
                "(no external fallback model is allowed — keep extraction local)."
            )
        return {
            "provider": "openai",
            "config": {
                "model": model,
                "openai_base_url": os.environ.get("MEM0_LLM_BASE_URL"),
                "api_key": os.environ.get("MEM0_LLM_API_KEY"),
                "temperature": 0,
                "max_tokens": 2000,
            },
        }
    return {
        "provider": "ollama",
        "config": {
            "model": os.environ.get("MEM0_LLM_MODEL", "llama3.1:8b"),
            "ollama_base_url": os.environ.get(
                "MEM0_OLLAMA_URL", "http://host.docker.internal:11434"
            ),
            "temperature": 0,
            "max_tokens": 2000,
        },
    }


def _build_base_config() -> dict:
    """
    Everything shared by the graph-on and graph-less Memory instances: the SAME
    Qdrant collection (so a graph-less write is visible to the existing search
    path), embedder, and extraction llm. Deliberately omits `graph_store` — each
    caller adds it (or not) to select whether mem0 runs its graph phase.
    """
    return {
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "host": os.environ.get("QDRANT_HOST", "qdrant"),
                "port": _int_env("QDRANT_PORT", 6333),
                "collection_name": os.environ.get("MEM0_COLLECTION", "sige_mem0"),
                "embedding_model_dims": EMBED_DIMS,
            },
        },
        "llm": _build_llm_config(),
        "embedder": {
            "provider": "ollama",
            "config": {
                "model": os.environ.get("MEM0_EMBED_MODEL", "nomic-embed-text:latest"),
                "ollama_base_url": os.environ.get(
                    "MEM0_OLLAMA_URL", "http://host.docker.internal:11434"
                ),
                "embedding_dims": EMBED_DIMS,
            },
        },
    }


def build_config() -> dict:
    """Graph-ON config (SIGE writes). Unchanged behavior: adds the graph_store."""
    return {**_build_base_config(), "graph_store": _build_graph_config()}


def build_config_nograph() -> dict:
    """
    Graph-OFF config (agent-memory writes). Identical vector_store/embedder/llm as
    build_config(), but NO graph_store, so mem0 sets enable_graph=False and skips
    the always-on entity/relation extraction LLM call (the measured ~7.4s/write).
    Same Qdrant collection_name as the graph-on instance, so writes here remain
    findable by the existing graph-on search path.
    """
    return _build_base_config()


# ─── mem0 init (retry so the sidecar tolerates Qdrant/Neo4j boot ordering) ──────
# Two instances against the SAME Qdrant collection:
#   _memory          — graph_store configured → graph extraction ON  (SIGE).
#   _memory_nograph  — no graph_store → graph phase skipped → fast    (agent mem).
# Both init off-thread with retry so /health serves "initializing" during boot.
_memory: Memory | None = None
_memory_nograph: Memory | None = None


def get_memory() -> Memory:
    global _memory
    if _memory is None:
        raise HTTPException(status_code=503, detail="mem0 not initialized yet")
    return _memory


def get_memory_nograph() -> Memory:
    global _memory_nograph
    if _memory_nograph is None:
        raise HTTPException(
            status_code=503, detail="mem0 (graph-less) not initialized yet"
        )
    return _memory_nograph


def init_memory_with_retry(attempts: int = 30, delay_s: float = 3.0) -> None:
    global _memory
    last_err: Exception | None = None
    for i in range(attempts):
        try:
            _memory = Memory.from_config(build_config())
            log.info("mem0 initialized (attempt %d)", i + 1)
            return
        except Exception as err:  # noqa: BLE001 — broad on purpose during boot
            last_err = err
            log.warning("mem0 init failed (attempt %d/%d): %s", i + 1, attempts, err)
            time.sleep(delay_s)
    log.error("mem0 init exhausted retries: %s", last_err)


def init_memory_nograph_with_retry(attempts: int = 30, delay_s: float = 3.0) -> None:
    global _memory_nograph
    last_err: Exception | None = None
    for i in range(attempts):
        try:
            _memory_nograph = Memory.from_config(build_config_nograph())
            log.info("mem0 (graph-less) initialized (attempt %d)", i + 1)
            return
        except Exception as err:  # noqa: BLE001 — broad on purpose during boot
            last_err = err
            log.warning(
                "mem0 (graph-less) init failed (attempt %d/%d): %s",
                i + 1,
                attempts,
                err,
            )
            time.sleep(delay_s)
    log.error("mem0 (graph-less) init exhausted retries: %s", last_err)


# ─── Response normalization (match the TS client's mapMemory/mapRelation) ───────
def _normalize_relation(r: dict) -> dict:
    return {
        "source": r.get("source"),
        "relationship": r.get("relationship") or r.get("relation"),
        "target": r.get("target") or r.get("destination"),
    }


def _flatten_relations(relations: object) -> list[dict]:
    """
    Coerce mem0's two relation shapes to a flat list of relation dicts.

    - search / get_all return a flat list: [{source, relationship, ...}, ...].
    - add returns the graph *write summary* instead: a dict
      {"added_entities": [...], "deleted_entities": [...]}, where added_entities
      is a list of Kùzu row groups (each itself a list of
      {source, relationship, target} dicts). Earlier code treated that dict as
      "not a list" and dropped every relation, so the add response always
      reported [] even when relations were written. Flatten added_entities here.
    """
    if isinstance(relations, dict):
        rows: object = relations.get("added_entities") or []
    elif isinstance(relations, list):
        rows = relations
    else:
        return []
    flat: list[dict] = []
    for row in rows if isinstance(rows, list) else []:
        if isinstance(row, dict):
            flat.append(row)
        elif isinstance(row, list):
            flat.extend(r for r in row if isinstance(r, dict))
    return flat


def _normalize(result: object) -> dict:
    # mem0 returns either {"results": [...], "relations": <flat list | add-path
    # write-summary dict>} or a bare list. Normalize relations from any shape.
    if isinstance(result, dict):
        results = result.get("results", []) or []
        relations: object = result.get("relations", []) or []
    else:
        results = result or []
        relations = []
    return {
        "results": results,
        "relations": [_normalize_relation(r) for r in _flatten_relations(relations)],
    }


# ─── Request models (lenient — accept and ignore platform-only fields) ──────────
class Message(BaseModel):
    role: str = "user"
    content: str


class AddBody(BaseModel):
    messages: list[Message]
    user_id: str
    metadata: dict | None = None
    # HONORED on the ADD path: False → graph-less instance (skips the ~7.4s graph
    # extraction LLM call). None/True → graph-on instance (SIGE, byte-identical).
    enable_graph: bool | None = None
    # Whether mem0 should run its LLM "fact extraction" phase on the input.
    # None → preserve mem0's own default (True). The OpenCrow memory backend
    # passes infer=False to store verbatim chunks (parity with the Qdrant path);
    # SIGE omits it, so its requests stay byte-identical to before this field.
    infer: bool | None = None


class SearchBody(BaseModel):
    query: str
    user_id: str
    limit: int | None = 30
    # Search is NOT routed: it always runs on the graph-on `_memory`, which shares
    # the Qdrant collection with the graph-less instance, so graph-less writes are
    # still returned (scoped by user_id). enable_graph here only toggles whether
    # the graph relation lookup is included; accepted as-is.
    enable_graph: bool | None = None
    # Optional top-level metadata-equality filters forwarded to mem0.search.
    # Only passed through when provided, so omitting it yields a byte-identical
    # call to mem.search(...) as before this field existed. Server-side filter
    # support is version-dependent; callers also post-filter client-side.
    filters: dict | None = None


app = FastAPI(title="OpenCrow Mem0 Sidecar")


@app.on_event("startup")
def _startup() -> None:
    if not _API_TOKEN:
        log.warning(
            "MEM0_API_TOKEN is unset — /v1/memories/* will reject every request "
            "with 503 until a token is configured. Set MEM0_API_TOKEN to enable "
            "the sidecar (GHSA-jfv9-68m5-gjjr defense-in-depth)."
        )
    # Init off-thread so the server can serve /health (and report "initializing")
    # while it retries connecting to Qdrant/Neo4j/Ollama on boot. Both instances
    # init independently; neither blocks startup nor the other.
    import threading

    threading.Thread(target=init_memory_with_retry, daemon=True).start()
    threading.Thread(target=init_memory_nograph_with_retry, daemon=True).start()


@app.get("/health")
def health() -> dict:
    return {"status": "ok" if _memory is not None else "initializing"}


@app.post("/v1/memories/", dependencies=[Depends(require_token)])
def add_memories(body: AddBody) -> dict:
    # Route the write: enable_graph=False → graph-less instance (no graph phase,
    # ~embedding-latency fast); None/True → graph-on instance, byte-identical to
    # the pre-split behavior so SIGE is unaffected. Both write the SAME Qdrant
    # collection, so the graph-on search path still finds graph-less writes.
    mem = get_memory_nograph() if body.enable_graph is False else get_memory()
    try:
        res = mem.add(
            messages=[m.model_dump() for m in body.messages],
            user_id=body.user_id,
            metadata=body.metadata or {},
            # Preserve mem0's default (True) when unset — SIGE stays identical;
            # the memory backend passes False to store verbatim chunks.
            infer=(body.infer if body.infer is not None else True),
        )
    except Exception as err:  # noqa: BLE001
        log.exception("add failed")
        raise HTTPException(status_code=500, detail=str(err)) from err
    return _normalize(res)


@app.post("/v1/memories/search/", dependencies=[Depends(require_token)])
def search_memories(body: SearchBody) -> dict:
    mem = get_memory()
    try:
        # Forward metadata filters only when supplied so the no-filter call is
        # byte-identical to before this field existed.
        if body.filters is not None:
            res = mem.search(
                query=body.query,
                user_id=body.user_id,
                limit=body.limit or 30,
                filters=body.filters,
            )
        else:
            res = mem.search(query=body.query, user_id=body.user_id, limit=body.limit or 30)
    except Exception as err:  # noqa: BLE001
        log.exception("search failed")
        raise HTTPException(status_code=500, detail=str(err)) from err
    return _normalize(res)


@app.get("/v1/memories/", dependencies=[Depends(require_token)])
def get_all_memories(user_id: str | None = None) -> dict:
    mem = get_memory()
    try:
        res = mem.get_all(user_id=user_id) if user_id else mem.get_all()
    except Exception as err:  # noqa: BLE001
        log.exception("get_all failed")
        raise HTTPException(status_code=500, detail=str(err)) from err
    return _normalize(res)


@app.delete("/v1/memories/{memory_id}/", dependencies=[Depends(require_token)])
def delete_memory(memory_id: str) -> dict:
    mem = get_memory()
    try:
        mem.delete(memory_id=memory_id)
    except Exception as err:  # noqa: BLE001
        log.exception("delete failed")
        raise HTTPException(status_code=500, detail=str(err)) from err
    return {"status": "deleted", "id": memory_id}
