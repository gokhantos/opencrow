/**
 * Isolated tests for QdrantDimensionMismatchError propagation in qdrant.ts.
 *
 * Lane: isolated (own process) — required because global fetch is replaced via
 * mock.module (actually via globalThis.fetch reassignment in beforeEach) and
 * that must not leak into other test processes.
 *
 * What we assert: when an existing Qdrant collection has a vector dimension that
 * does NOT match the `vectorSize` argument passed to `ensureCollection()`, the
 * function throws `QdrantDimensionMismatchError` rather than silently
 * proceeding (which would corrupt search results).
 *
 * Because the real fetch goes to a network URL we can't reach in CI/unit runs,
 * we override globalThis.fetch with a deterministic stub before each test and
 * restore it after.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createQdrantClient, QdrantDimensionMismatchError } from "./qdrant";

// ── Fetch stub infrastructure ─────────────────────────────────────────────────

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Build a fake Response with a JSON body and optional ok/status. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Install a multi-call fetch stub. The stub is called in order for each
 * sequential fetch, cycling if more calls than responses are provided.
 *
 * For createQdrantClient the sequence is:
 *   1. probeHealth → GET /healthz (must return ok=true to mark available)
 *   2. ensureCollection check → GET /collections/{name} (returns existing config)
 *   3. ensureCollection resp.json() → reads the collection body
 *
 * Because fetch is called with a Request/URL and the same Response can only be
 * read once (body stream), we create a new Response for each call.
 */
function installFetchSequence(stubs: FetchStub[]): void {
  let callIndex = 0;
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const handler = stubs[callIndex % stubs.length]!;
    callIndex++;
    return handler(input, init);
  };
  // Cast required: Bun's `typeof fetch` includes the `fetch.preconnect` namespace
  // extension which a plain async function doesn't satisfy. The stub is only used
  // inside these tests and never calls preconnect, so the cast is safe.
  globalThis.fetch = stub as unknown as typeof globalThis.fetch;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build a fake Qdrant collection-info body with the given vector size. */
function collectionInfoBody(size: number): unknown {
  return {
    result: {
      config: {
        params: {
          vectors: { size, distance: "Cosine" },
        },
      },
    },
    status: "ok",
    time: 0.001,
  };
}

/** Create a healthy Qdrant client pointed at a fake URL. */
async function makeClient(): Promise<Awaited<ReturnType<typeof createQdrantClient>>> {
  return createQdrantClient({ url: "http://qdrant.local:6333" });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("QdrantDimensionMismatchError propagation", () => {
  test("throws QdrantDimensionMismatchError when existing collection has wrong dimension", async () => {
    const existingDim = 768;
    const requestedDim = 1536;

    // Fetch sequence:
    // 1. /healthz → ok (so client marks itself available)
    // 2. /collections/test → ok (collection exists) — first call in ensureCollection
    // 3. /collections/test json() read — returns body with size 768

    const collectionBody = collectionInfoBody(existingDim);

    installFetchSequence([
      // healthz probe
      async () => new Response("{}", { status: 200 }),
      // collection existence check — ok=true means collection exists
      async () => jsonResponse(collectionBody, 200),
      // The code does resp.json() on the same Response object, so the second
      // fetch call is the PATCH /collections/{name} for optimizers_config or
      // the PUT /collections/{name}/index — but we throw before those.
      // (Providing a fallback stub anyway to prevent unhandled promise rejections)
      async () => jsonResponse({ result: true }, 200),
    ]);

    const client = await makeClient();

    await expect(
      client.ensureCollection("test", requestedDim),
    ).rejects.toThrow(QdrantDimensionMismatchError);
  });

  test("error message contains collection name, actual size and requested size", async () => {
    const existingDim = 768;
    const requestedDim = 1536;
    const collectionBody = collectionInfoBody(existingDim);

    installFetchSequence([
      async () => new Response("{}", { status: 200 }),
      async () => jsonResponse(collectionBody, 200),
      async () => jsonResponse({ result: true }, 200),
    ]);

    const client = await makeClient();

    let caughtError: Error | undefined;
    try {
      await client.ensureCollection("memories", requestedDim);
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).toBeInstanceOf(QdrantDimensionMismatchError);
    expect(caughtError!.message).toContain("memories");
    expect(caughtError!.message).toContain(String(existingDim));
    expect(caughtError!.message).toContain(String(requestedDim));
  });

  test("does not throw when existing collection dimension matches requested", async () => {
    const matchingDim = 1536;
    const collectionBody = collectionInfoBody(matchingDim);

    // For the matching-dimension path the code proceeds to:
    // PATCH /collections/{name} (optimizers_config)
    // PUT /collections/{name}/index (×9 keyword + 2 numeric indices = 11 calls)
    // We provide a generic stub that accepts all of them.
    installFetchSequence([
      async () => new Response("{}", { status: 200 }),
      async () => jsonResponse(collectionBody, 200),
      // All subsequent calls (PATCH + PUT index) → succeed
      async () => jsonResponse({ result: true }, 200),
    ]);

    const client = await makeClient();
    // Should not throw
    const result = await client.ensureCollection("test", matchingDim);
    expect(result).toBe(true);
  });

  test("QdrantDimensionMismatchError is instanceof Error", () => {
    const err = new QdrantDimensionMismatchError("test message");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(QdrantDimensionMismatchError);
    expect(err.name).toBe("QdrantDimensionMismatchError");
    expect(err.message).toBe("test message");
  });

  test("does not throw (skips dimension check) when readVectorSize returns undefined", async () => {
    // An unrecognized collection body shape → readVectorSize returns undefined →
    // the mismatch guard is skipped (actualSize !== undefined is false).
    const unknownBody = { result: { some: "unexpected structure" }, status: "ok" };

    installFetchSequence([
      async () => new Response("{}", { status: 200 }),
      async () => jsonResponse(unknownBody, 200),
      async () => jsonResponse({ result: true }, 200),
    ]);

    const client = await makeClient();
    // Should not throw even though we're passing a different dimension
    const result = await client.ensureCollection("test", 1536);
    expect(result).toBe(true);
  });
});
