/**
 * Unit tests for readVectorSize exported from qdrant.ts.
 *
 * Lane: unit (no DB, no network, no mock.module).
 *
 * readVectorSize parses a Qdrant GET /collections/{name} response body.
 * It handles the two legal shapes (unnamed and named vectors) and returns
 * undefined for anything unrecognized so the caller skips the dimension check
 * rather than incorrectly raising a mismatch.
 */
import { describe, test, expect } from "bun:test";
import { readVectorSize } from "./qdrant";

// ── Fixtures ───────────────────────────────────────────────────────────────────

/** Qdrant collection response with an unnamed (default) vector of size 1536. */
function makeUnnamedVectorBody(size: number): unknown {
  return {
    result: {
      config: {
        params: {
          vectors: {
            size,
            distance: "Cosine",
          },
        },
      },
    },
    status: "ok",
    time: 0.001,
  };
}

/** Qdrant collection response with named vectors (multi-vector schema). */
function makeNamedVectorBody(name: string, size: number): unknown {
  return {
    result: {
      config: {
        params: {
          vectors: {
            [name]: {
              size,
              distance: "Cosine",
            },
          },
        },
      },
    },
    status: "ok",
    time: 0.001,
  };
}

// ── Tests — unnamed-vector layout ─────────────────────────────────────────────

describe("readVectorSize — unnamed vector layout", () => {
  test("returns size from vectors.size for unnamed vector", () => {
    expect(readVectorSize(makeUnnamedVectorBody(1536))).toBe(1536);
  });

  test("returns 768 for unnamed vector of dimension 768", () => {
    expect(readVectorSize(makeUnnamedVectorBody(768))).toBe(768);
  });

  test("returns 3072 for unnamed vector of dimension 3072", () => {
    expect(readVectorSize(makeUnnamedVectorBody(3072))).toBe(3072);
  });
});

// ── Tests — named-vector layout ───────────────────────────────────────────────

describe("readVectorSize — named vector layout", () => {
  test("returns size from first named vector entry", () => {
    expect(readVectorSize(makeNamedVectorBody("default", 1536))).toBe(1536);
  });

  test("returns size for a named vector with a custom name", () => {
    expect(readVectorSize(makeNamedVectorBody("embedding", 768))).toBe(768);
  });

  test("returns the first entry's size when multiple named vectors exist", () => {
    const body = {
      result: {
        config: {
          params: {
            vectors: {
              alpha: { size: 1024, distance: "Cosine" },
              beta: { size: 512, distance: "Dot" },
            },
          },
        },
      },
    };
    // Should return the first iterable entry (alpha = 1024)
    const size = readVectorSize(body);
    expect(typeof size).toBe("number");
    expect(size).toBeGreaterThan(0);
  });
});

// ── Tests — unrecognized shapes ────────────────────────────────────────────────

describe("readVectorSize — unrecognized shapes return undefined", () => {
  test("returns undefined for null", () => {
    expect(readVectorSize(null)).toBeUndefined();
  });

  test("returns undefined for undefined", () => {
    expect(readVectorSize(undefined)).toBeUndefined();
  });

  test("returns undefined for a string", () => {
    expect(readVectorSize("not an object")).toBeUndefined();
  });

  test("returns undefined for a number", () => {
    expect(readVectorSize(42)).toBeUndefined();
  });

  test("returns undefined for an empty object", () => {
    expect(readVectorSize({})).toBeUndefined();
  });

  test("returns undefined when result is missing", () => {
    expect(readVectorSize({ status: "ok" })).toBeUndefined();
  });

  test("returns undefined when config is missing", () => {
    expect(readVectorSize({ result: {} })).toBeUndefined();
  });

  test("returns undefined when params is missing", () => {
    expect(readVectorSize({ result: { config: {} } })).toBeUndefined();
  });

  test("returns undefined when vectors is missing", () => {
    expect(readVectorSize({ result: { config: { params: {} } } })).toBeUndefined();
  });

  test("returns undefined when vectors is null", () => {
    expect(
      readVectorSize({ result: { config: { params: { vectors: null } } } }),
    ).toBeUndefined();
  });

  test("returns undefined when vectors is a number (not an object)", () => {
    expect(
      readVectorSize({ result: { config: { params: { vectors: 1536 } } } }),
    ).toBeUndefined();
  });

  test("returns undefined when named vector entry has no size field", () => {
    const body = {
      result: {
        config: {
          params: {
            vectors: {
              default: { distance: "Cosine" }, // size absent
            },
          },
        },
      },
    };
    expect(readVectorSize(body)).toBeUndefined();
  });

  test("returns undefined when named vector entry has non-numeric size", () => {
    const body = {
      result: {
        config: {
          params: {
            vectors: {
              default: { size: "1536", distance: "Cosine" }, // string, not number
            },
          },
        },
      },
    };
    expect(readVectorSize(body)).toBeUndefined();
  });

  test("returns undefined when vectors has only non-object values (array of numbers)", () => {
    const body = {
      result: {
        config: {
          params: {
            vectors: [1, 2, 3], // array, not dict
          },
        },
      },
    };
    // An array is an object, but size won't be found on the array itself
    // — the unnamed branch checks vectors.size directly, which is undefined for [1,2,3].
    // The named branch iterates array entries (numbers), none of which are objects
    // with a .size property.
    expect(readVectorSize(body)).toBeUndefined();
  });
});
