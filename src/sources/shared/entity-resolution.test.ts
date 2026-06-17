/**
 * Unit tests for cross-source corroboration / entity resolution.
 * Pure logic only — no DB, network, or subprocess.
 */

import { describe, expect, it } from "bun:test";
import {
  corroborationCounts,
  entityKeyForRow,
  normalizeDomain,
  normalizeFullName,
  normalizeHandle,
  normalizePackageName,
  normalizeText,
  resolveEntities,
  type EntityRow,
  type EmbedFn,
} from "./entity-resolution";

describe("normalizeDomain", () => {
  it("strips protocol, www, path, query and port", () => {
    expect(normalizeDomain("https://www.example.com:443/foo?x=1#y")).toBe(
      "example.com",
    );
  });

  it("tolerates bare hostnames without a scheme", () => {
    expect(normalizeDomain("Example.COM/path")).toBe("example.com");
  });

  it("strips m./mobile./amp. mobile prefixes", () => {
    expect(normalizeDomain("https://m.reddit.com/r/foo")).toBe("reddit.com");
    expect(normalizeDomain("https://amp.cnn.com/article")).toBe("cnn.com");
  });

  it("returns null for empty or unparseable input", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain(null)).toBeNull();
    expect(normalizeDomain(undefined)).toBeNull();
    expect(normalizeDomain("http://")).toBeNull();
  });

  it("collapses subdomains only for known mobile prefixes (keeps others)", () => {
    expect(normalizeDomain("https://blog.example.com")).toBe("blog.example.com");
  });
});

describe("normalizeHandle", () => {
  it("strips leading @ and lowercases", () => {
    expect(normalizeHandle("@FooBar")).toBe("foobar");
  });

  it("extracts handle from a twitter/x profile URL", () => {
    expect(normalizeHandle("https://twitter.com/jack")).toBe("jack");
    expect(normalizeHandle("https://x.com/Elon/status/1")).toBe("elon");
  });

  it("extracts handle from a github profile URL", () => {
    expect(normalizeHandle("https://github.com/torvalds")).toBe("torvalds");
  });

  it("returns null for a bare domain with no path", () => {
    expect(normalizeHandle("https://twitter.com")).toBeNull();
  });

  it("returns null for empty/nullish input", () => {
    expect(normalizeHandle("")).toBeNull();
    expect(normalizeHandle(null)).toBeNull();
    expect(normalizeHandle("@@@")).toBeNull();
  });
});

describe("normalizeFullName", () => {
  it("normalizes owner/repo to lowercase", () => {
    expect(normalizeFullName("Facebook/React")).toBe("facebook/react");
  });

  it("extracts owner/repo from a github URL and strips .git", () => {
    expect(normalizeFullName("https://github.com/vercel/next.js.git")).toBe(
      "vercel/next.js",
    );
  });

  it("returns null for a bare repo name with no owner", () => {
    expect(normalizeFullName("react")).toBeNull();
  });

  it("returns null for empty/nullish input", () => {
    expect(normalizeFullName("")).toBeNull();
    expect(normalizeFullName(null)).toBeNull();
  });
});

describe("normalizePackageName", () => {
  it("preserves npm scope and lowercases", () => {
    expect(normalizePackageName("@Vercel/Analytics")).toBe("@vercel/analytics");
  });

  it("preserves bundle-id dots", () => {
    expect(normalizePackageName("com.Example.App")).toBe("com.example.app");
  });

  it("returns null for empty input", () => {
    expect(normalizePackageName("")).toBeNull();
    expect(normalizePackageName(null)).toBeNull();
  });
});

describe("normalizeText", () => {
  it("lowercases, collapses whitespace and trims punctuation", () => {
    expect(normalizeText("  Hello,   World!  ")).toBe("hello, world");
  });
});

describe("entityKeyForRow priority", () => {
  it("prefers github full_name over everything", () => {
    const row: EntityRow = {
      id: "1",
      source: "github",
      fullName: "facebook/react",
      url: "https://github.com/facebook/react",
      handle: "@react",
      name: "React",
    };
    expect(entityKeyForRow(row)).toBe("github:facebook/react");
  });

  it("falls through package > handle > domain > name", () => {
    expect(
      entityKeyForRow({ id: "a", source: "npm", packageName: "lodash" }),
    ).toBe("package:lodash");
    expect(
      entityKeyForRow({ id: "b", source: "x", handle: "@jack" }),
    ).toBe("handle:jack");
    expect(
      entityKeyForRow({ id: "c", source: "news", url: "https://www.bbc.com/x" }),
    ).toBe("domain:bbc.com");
    expect(
      entityKeyForRow({ id: "d", source: "reddit", name: "Some Theme" }),
    ).toBe("name:some theme");
  });

  it("returns null when no usable identifier exists", () => {
    expect(entityKeyForRow({ id: "z", source: "x" })).toBeNull();
  });
});

describe("resolveEntities — distinct source counting", () => {
  it("counts distinct sources, not distinct rows, per entity", async () => {
    const rows: EntityRow[] = [
      { id: "r1", source: "github", fullName: "facebook/react" },
      // same source + same entity => still 1 distinct source
      { id: "r2", source: "github", fullName: "Facebook/React" },
      // different source, same entity => 2 distinct sources
      { id: "r3", source: "reddit", url: "https://github.com/facebook/react" },
    ];
    const { entities, sourceCountByKey, corroborationByRowId } =
      await resolveEntities(rows);

    // r3 resolves via domain (github.com), NOT via owner/repo, so it forms a
    // separate entity. Verify the github cluster has 1 distinct source.
    const ghKey = "github:facebook/react";
    expect([...(entities.get(ghKey)?.rowIds ?? [])].sort()).toEqual([
      "r1",
      "r2",
    ]);
    expect(sourceCountByKey.get(ghKey)).toBe(1);
    expect(corroborationByRowId.get("r1")).toBe(1);
    expect(corroborationByRowId.get("r2")).toBe(1);
  });

  it("corroborates the same entity across distinct sources", async () => {
    const rows: EntityRow[] = [
      { id: "a", source: "hackernews", url: "https://openai.com/blog/x" },
      { id: "b", source: "reddit", url: "https://www.openai.com/research" },
      { id: "c", source: "x", url: "https://openai.com/" },
    ];
    const counts = await corroborationCounts(rows);
    expect(counts.get("domain:openai.com")).toBe(3);
  });

  it("returns empty maps for empty input", async () => {
    const result = await resolveEntities([]);
    expect(result.entities.size).toBe(0);
    expect(result.sourceCountByKey.size).toBe(0);
    expect(result.corroborationByRowId.size).toBe(0);
  });

  it("skips rows with no usable identifier", async () => {
    const rows: EntityRow[] = [
      { id: "x1", source: "x" },
      { id: "x2", source: "github", fullName: "a/b" },
    ];
    const { corroborationByRowId } = await resolveEntities(rows);
    expect(corroborationByRowId.has("x1")).toBe(false);
    expect(corroborationByRowId.get("x2")).toBe(1);
  });
});

describe("resolveEntities — optional embedding name-match", () => {
  it("does not run name-match when no embed fn is provided", async () => {
    const rows: EntityRow[] = [
      { id: "1", source: "reddit", name: "AI code review" },
      { id: "2", source: "hackernews", name: "ai code-review" },
    ];
    const { entities } = await resolveEntities(rows);
    // Distinct normalized names => two separate entities, no merge.
    expect(entities.size).toBe(2);
  });

  it("merges near-duplicate names when embed groups them", async () => {
    const rows: EntityRow[] = [
      { id: "1", source: "reddit", name: "alpha" },
      { id: "2", source: "hackernews", name: "alpha-prime" },
      { id: "3", source: "x", name: "totally different" },
    ];
    // Fake embedder: alpha-ish names get near-identical vectors.
    const embed: EmbedFn = async (texts) =>
      texts.map((t) =>
        t.startsWith("alpha") ? [1, 0, 0] : [0, 1, 0],
      );

    const { entities, corroborationByRowId } = await resolveEntities(rows, {
      embed,
      nameMatchThreshold: 0.9,
    });

    // alpha + alpha-prime merge into one entity (2 distinct sources);
    // "totally different" stays separate.
    expect(entities.size).toBe(2);
    expect(corroborationByRowId.get("1")).toBe(2);
    expect(corroborationByRowId.get("2")).toBe(2);
    expect(corroborationByRowId.get("3")).toBe(1);
  });

  it("degrades to deterministic result when embed throws", async () => {
    const rows: EntityRow[] = [
      { id: "1", source: "reddit", name: "alpha" },
      { id: "2", source: "hackernews", name: "beta" },
    ];
    const embed: EmbedFn = async () => {
      throw new Error("embed offline");
    };
    const { entities } = await resolveEntities(rows, { embed });
    expect(entities.size).toBe(2);
  });

  it("does not merge strong-identifier clusters via embedding", async () => {
    const rows: EntityRow[] = [
      { id: "1", source: "github", fullName: "a/b" },
      { id: "2", source: "reddit", fullName: "c/d" },
    ];
    const embed: EmbedFn = async (texts) => texts.map(() => [1, 0, 0]);
    const { entities } = await resolveEntities(rows, { embed });
    // No name: clusters exist, so embedding pass is a no-op.
    expect(entities.size).toBe(2);
  });
});
