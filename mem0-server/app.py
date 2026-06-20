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
client changes are needed. The `enable_graph` flag in request bodies is accepted and
ignored — graph extraction is always on server-side because a graph_store is configured.
"""
import os
import logging
import secrets
import time

from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from mem0 import Memory

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("mem0-sidecar")


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


def build_config() -> dict:
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
        "graph_store": _build_graph_config(),
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


# ─── mem0 init (retry so the sidecar tolerates Qdrant/Neo4j boot ordering) ──────
_memory: Memory | None = None


def get_memory() -> Memory:
    global _memory
    if _memory is None:
        raise HTTPException(status_code=503, detail="mem0 not initialized yet")
    return _memory


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
    enable_graph: bool | None = None  # accepted, ignored (graph always on)


class SearchBody(BaseModel):
    query: str
    user_id: str
    limit: int | None = 30
    enable_graph: bool | None = None  # accepted, ignored


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
    # while it retries connecting to Qdrant/Neo4j/Ollama on boot.
    import threading

    threading.Thread(target=init_memory_with_retry, daemon=True).start()


@app.get("/health")
def health() -> dict:
    return {"status": "ok" if _memory is not None else "initializing"}


@app.post("/v1/memories/", dependencies=[Depends(require_token)])
def add_memories(body: AddBody) -> dict:
    mem = get_memory()
    try:
        res = mem.add(
            messages=[m.model_dump() for m in body.messages],
            user_id=body.user_id,
            metadata=body.metadata or {},
        )
    except Exception as err:  # noqa: BLE001
        log.exception("add failed")
        raise HTTPException(status_code=500, detail=str(err)) from err
    return _normalize(res)


@app.post("/v1/memories/search/", dependencies=[Depends(require_token)])
def search_memories(body: SearchBody) -> dict:
    mem = get_memory()
    try:
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
