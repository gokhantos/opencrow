/**
 * Integration tests for the Embeddings & Memory config route.
 *
 * Strategy: mount only the route sub-app (no auth middleware) against a real
 * Postgres database so the full request→DB→response cycle is exercised. The
 * config_overrides rows touched here are cleaned up around each test.
 *
 * Lane: *.integration.test.ts — run with `bun run test:integration`
 * Requires: docker compose up -d postgres
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, getDb, initDb } from "../../store/db";
import { createEmbeddingsMemoryRoutes } from "./config-embeddings-memory";

const BASE = "http://localhost";

function makeApp() {
  return createEmbeddingsMemoryRoutes();
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

async function get(app: ReturnType<typeof makeApp>, path: string): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`)));
}

async function put(
  app: ReturnType<typeof makeApp>,
  path: string,
  body: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`${BASE}${path}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
}

async function clearRows() {
  const db = getDb();
  await db.unsafe(
    `DELETE FROM config_overrides WHERE (namespace = 'config' AND key = 'memory') OR (namespace = 'features' AND key = 'embeddings')`,
  );
}

beforeEach(async () => {
  await initDb(process.env.DATABASE_URL);
  await clearRows();
});

afterEach(async () => {
  await clearRows();
  await closeDb();
});

// ---------------------------------------------------------------------------
// GET /
// ---------------------------------------------------------------------------

describe("GET /", () => {
  it("200 + effective memory backend + dimensions", async () => {
    const app = makeApp();
    const res = await get(app, "/");
    expect(res.status).toBe(200);

    const body = await json<{
      success: boolean;
      data: {
        memory: { backend: string; source: string };
        embeddings: { dimensions: number };
      };
    }>(res);
    expect(body.success).toBe(true);
    expect(["qdrant", "mem0"]).toContain(body.data.memory.backend);
    expect(body.data.memory.source).toBe("default");
    expect(typeof body.data.embeddings.dimensions).toBe("number");
  });

  it("reflects a persisted memory override as source=override", async () => {
    const app = makeApp();
    await put(app, "/memory", { backend: "mem0" });

    const res = await get(app, "/");
    const body = await json<{
      data: { memory: { backend: string; source: string } };
    }>(res);
    expect(body.data.memory.backend).toBe("mem0");
    expect(body.data.memory.source).toBe("override");
  });
});

// ---------------------------------------------------------------------------
// PUT /memory
// ---------------------------------------------------------------------------

describe("PUT /memory", () => {
  it("200 + persists qdrant backend", async () => {
    const app = makeApp();
    const res = await put(app, "/memory", { backend: "qdrant" });
    expect(res.status).toBe(200);

    const body = await json<{ success: boolean; data: { backend: string } }>(res);
    expect(body.success).toBe(true);
    expect(body.data.backend).toBe("qdrant");
  });

  it("400 on invalid backend value", async () => {
    const app = makeApp();
    const res = await put(app, "/memory", { backend: "pinecone" });
    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 on malformed JSON body", async () => {
    const app = makeApp();
    const res = await Promise.resolve(
      app.fetch(
        new Request(`${BASE}/memory`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: "{{broken",
        }),
      ),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// PUT /embeddings/dimensions — guarded
// ---------------------------------------------------------------------------

describe("PUT /embeddings/dimensions", () => {
  async function currentDimensions(app: ReturnType<typeof makeApp>): Promise<number> {
    const res = await get(app, "/");
    const body = await json<{ data: { embeddings: { dimensions: number } } }>(res);
    return body.data.embeddings.dimensions;
  }

  it("200 + no-op when dimensions are unchanged", async () => {
    const app = makeApp();
    const dims = await currentDimensions(app);
    const res = await put(app, "/embeddings/dimensions", { dimensions: dims });
    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; data: { changed: boolean } }>(res);
    expect(body.success).toBe(true);
    expect(body.data.changed).toBe(false);
  });

  it("409 when changing dimensions without confirmReindex", async () => {
    const app = makeApp();
    const dims = await currentDimensions(app);
    const res = await put(app, "/embeddings/dimensions", { dimensions: dims + 256 });
    expect(res.status).toBe(409);
    const body = await json<{ success: boolean; requiresConfirmation?: boolean }>(res);
    expect(body.success).toBe(false);
    expect(body.requiresConfirmation).toBe(true);
  });

  it("200 + applies change when confirmReindex is true", async () => {
    const app = makeApp();
    const dims = await currentDimensions(app);
    const target = dims === 768 ? 1024 : 768;
    const res = await put(app, "/embeddings/dimensions", {
      dimensions: target,
      confirmReindex: true,
    });
    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; data: { dimensions: number; changed: boolean } }>(
      res,
    );
    expect(body.success).toBe(true);
    expect(body.data.changed).toBe(true);
    expect(body.data.dimensions).toBe(target);

    // Persisted: a subsequent GET reflects the new effective dimensions.
    expect(await currentDimensions(app)).toBe(target);
  });

  it("400 on out-of-range dimensions", async () => {
    const app = makeApp();
    const res = await put(app, "/embeddings/dimensions", {
      dimensions: 999999,
      confirmReindex: true,
    });
    expect(res.status).toBe(400);
  });

  it("400 on malformed JSON body", async () => {
    const app = makeApp();
    const res = await Promise.resolve(
      app.fetch(
        new Request(`${BASE}/embeddings/dimensions`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: "not-json",
        }),
      ),
    );
    expect(res.status).toBe(400);
  });
});
