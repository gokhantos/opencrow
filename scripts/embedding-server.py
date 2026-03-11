"""
Local embedding server for OpenCrow.
Serves Qwen3-Embedding-0.6B (or any sentence-transformers model) via HTTP.

Usage:
  pip install fastapi uvicorn sentence-transformers
  python scripts/embedding-server.py

Environment variables:
  EMBEDDING_MODEL  - HuggingFace model ID (default: Qwen/Qwen3-Embedding-0.6B)
  EMBEDDING_PORT   - Port to listen on (default: 8901)
  EMBEDDING_HOST   - Host to bind to (default: 0.0.0.0)
"""

import os
import time
import logging

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
import uvicorn

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("embedding-server")

MODEL_ID = os.environ.get("EMBEDDING_MODEL", "Qwen/Qwen3-Embedding-0.6B")
PORT = int(os.environ.get("EMBEDDING_PORT", "8901"))
HOST = os.environ.get("EMBEDDING_HOST", "0.0.0.0")

app = FastAPI(title="OpenCrow Embedding Server")

model = None


def get_model():
    global model
    if model is None:
        from sentence_transformers import SentenceTransformer

        logger.info(f"Loading model: {MODEL_ID}")
        start = time.time()
        model = SentenceTransformer(MODEL_ID)
        logger.info(f"Model loaded in {time.time() - start:.1f}s")
    return model


class EmbedRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1, max_length=256)
    dimensions: int = Field(default=512, ge=32, le=4096)


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]


@app.on_event("startup")
async def startup():
    get_model()


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL_ID, "ready": model is not None}


@app.post("/embed", response_model=EmbedResponse)
async def embed(req: EmbedRequest):
    try:
        import numpy as np

        m = get_model()
        raw = m.encode(req.texts, normalize_embeddings=True)

        # MRL: truncate to requested dimensions and re-normalize
        truncated = raw[:, : req.dimensions]
        norms = np.linalg.norm(truncated, axis=1, keepdims=True)
        norms = np.where(norms == 0, 1, norms)
        normalized = truncated / norms

        return EmbedResponse(
            embeddings=[e.tolist() for e in normalized]
        )
    except Exception as e:
        logger.error(f"Embedding failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
