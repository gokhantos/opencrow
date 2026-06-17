"""
Mem0 sidecar for OpenCrow / SIGE.

Exposes the *hosted-platform-shaped* endpoints that `src/sige/knowledge/mem0-client.ts`
already calls (`/v1/memories/`, `/v1/memories/search/`, …), backed by a self-hosted
mem0 SDK instance wired to:
  - vector store : Qdrant   (existing container)
  - graph store  : Neo4j    (relations — the only thing SIGE reads)
  - embedder     : Ollama   (host-native, nomic-embed-text)
  - extraction   : OpenRouter (OpenAI-compatible) → an Anthropic Claude model

This deliberately mirrors the client's request/response contract so no TypeScript
client changes are needed. The `enable_graph` flag in request bodies is accepted and
ignored — graph extraction is always on server-side because a graph_store is configured.
"""
import os
import logging
import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from mem0 import Memory

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("mem0-sidecar")


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
    Set MEM0_LLM_PROVIDER=openai + MEM0_LLM_API_KEY/MEM0_LLM_BASE_URL to route to a
    hosted OpenAI-compatible endpoint (e.g. OpenRouter → Claude) instead.
    """
    provider = os.environ.get("MEM0_LLM_PROVIDER", "ollama")
    if provider == "openai":
        return {
            "provider": "openai",
            "config": {
                "model": os.environ.get("MEM0_LLM_MODEL", "anthropic/claude-3.5-haiku"),
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


def _normalize(result: object) -> dict:
    # mem0 returns either {"results": [...], "relations": [...]} or a bare list.
    if isinstance(result, dict):
        results = result.get("results", []) or []
        relations = result.get("relations", []) or []
    else:
        results = result or []
        relations = []
    rel_list = relations if isinstance(relations, list) else []
    return {
        "results": results,
        "relations": [_normalize_relation(r) for r in rel_list if isinstance(r, dict)],
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
    # Init off-thread so the server can serve /health (and report "initializing")
    # while it retries connecting to Qdrant/Neo4j/Ollama on boot.
    import threading

    threading.Thread(target=init_memory_with_retry, daemon=True).start()


@app.get("/health")
def health() -> dict:
    return {"status": "ok" if _memory is not None else "initializing"}


@app.post("/v1/memories/")
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


@app.post("/v1/memories/search/")
def search_memories(body: SearchBody) -> dict:
    mem = get_memory()
    try:
        res = mem.search(query=body.query, user_id=body.user_id, limit=body.limit or 30)
    except Exception as err:  # noqa: BLE001
        log.exception("search failed")
        raise HTTPException(status_code=500, detail=str(err)) from err
    return _normalize(res)


@app.get("/v1/memories/")
def get_all_memories(user_id: str | None = None) -> dict:
    mem = get_memory()
    try:
        res = mem.get_all(user_id=user_id) if user_id else mem.get_all()
    except Exception as err:  # noqa: BLE001
        log.exception("get_all failed")
        raise HTTPException(status_code=500, detail=str(err)) from err
    return _normalize(res)


@app.delete("/v1/memories/{memory_id}/")
def delete_memory(memory_id: str) -> dict:
    mem = get_memory()
    try:
        mem.delete(memory_id=memory_id)
    except Exception as err:  # noqa: BLE001
        log.exception("delete failed")
        raise HTTPException(status_code=500, detail=str(err)) from err
    return {"status": "deleted", "id": memory_id}
