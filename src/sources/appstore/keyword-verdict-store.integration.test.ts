import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { getDb, initDb } from "../../store/db";
import {
  deleteKeywordVerdict,
  getDownweightedKeywords,
  getExcludedKeywords,
  getKeywordVerdicts,
  getStarredKeywords,
  upsertKeywordVerdict,
} from "./keyword-verdict-store";

const TEST_KEYWORDS: readonly string[] = [
  "zzz-verdict-starred",
  "zzz-verdict-dismissed-human",
  "zzz-verdict-killed-human",
  "zzz-verdict-dismissed-pipeline",
  "zzz-verdict-both-sources",
  "zzz-verdict-upsert-overwrite",
  "zzz-verdict-delete-target",
];

async function cleanup(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_keyword_verdicts WHERE keyword IN ${db(TEST_KEYWORDS)}`;
}

describe("keyword-verdict-store (integration)", () => {
  beforeAll(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("upserts a verdict and reads it back via getKeywordVerdicts", async () => {
    await upsertKeywordVerdict({
      keyword: "zzz-verdict-starred",
      verdict: "starred",
      source: "human",
    });
    const byKeyword = await getKeywordVerdicts(["zzz-verdict-starred"]);
    const rows = byKeyword.get("zzz-verdict-starred") ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verdict).toBe("starred");
    expect(rows[0]?.source).toBe("human");
  });

  it("getStarredKeywords returns only source:human verdict:starred keywords", async () => {
    await upsertKeywordVerdict({
      keyword: "zzz-verdict-starred",
      verdict: "starred",
      source: "human",
    });
    await upsertKeywordVerdict({
      keyword: "zzz-verdict-dismissed-human",
      verdict: "dismissed",
      source: "human",
    });

    const starred = await getStarredKeywords(500);
    expect(starred).toContain("zzz-verdict-starred");
    expect(starred).not.toContain("zzz-verdict-dismissed-human");
  });

  it("getExcludedKeywords includes human dismissed/killed but NOT pipeline dismissed", async () => {
    await upsertKeywordVerdict({
      keyword: "zzz-verdict-dismissed-human",
      verdict: "dismissed",
      source: "human",
    });
    await upsertKeywordVerdict({
      keyword: "zzz-verdict-killed-human",
      verdict: "killed",
      source: "human",
    });
    await upsertKeywordVerdict({
      keyword: "zzz-verdict-dismissed-pipeline",
      verdict: "dismissed",
      source: "pipeline",
    });

    const excluded = await getExcludedKeywords();
    expect(excluded.has("zzz-verdict-dismissed-human")).toBe(true);
    expect(excluded.has("zzz-verdict-killed-human")).toBe(true);
    // A PIPELINE-sourced dismissal must never appear in the HARD-exclude set
    // — it is a SOFT downweight signal only (see getDownweightedKeywords).
    expect(excluded.has("zzz-verdict-dismissed-pipeline")).toBe(false);
  });

  it("getDownweightedKeywords includes ONLY pipeline dismissed", async () => {
    await upsertKeywordVerdict({
      keyword: "zzz-verdict-dismissed-pipeline",
      verdict: "dismissed",
      source: "pipeline",
    });
    await upsertKeywordVerdict({
      keyword: "zzz-verdict-dismissed-human",
      verdict: "dismissed",
      source: "human",
    });

    const downweighted = await getDownweightedKeywords();
    expect(downweighted.has("zzz-verdict-dismissed-pipeline")).toBe(true);
    expect(downweighted.has("zzz-verdict-dismissed-human")).toBe(false);
  });

  it("a human verdict and a pipeline verdict for the SAME keyword coexist independently", async () => {
    await upsertKeywordVerdict({
      keyword: "zzz-verdict-both-sources",
      verdict: "starred",
      source: "human",
    });
    await upsertKeywordVerdict({
      keyword: "zzz-verdict-both-sources",
      verdict: "dismissed",
      source: "pipeline",
    });

    const rows = (await getKeywordVerdicts(["zzz-verdict-both-sources"])).get(
      "zzz-verdict-both-sources",
    );
    expect(rows).toHaveLength(2);
    const bySource = new Map(rows?.map((r) => [r.source, r.verdict]));
    expect(bySource.get("human")).toBe("starred");
    expect(bySource.get("pipeline")).toBe("dismissed");
  });

  it("upserting the SAME (keyword, source) again overwrites the verdict", async () => {
    await upsertKeywordVerdict({
      keyword: "zzz-verdict-upsert-overwrite",
      verdict: "starred",
      source: "human",
    });
    await upsertKeywordVerdict({
      keyword: "zzz-verdict-upsert-overwrite",
      verdict: "dismissed",
      source: "human",
    });

    const rows = (await getKeywordVerdicts(["zzz-verdict-upsert-overwrite"])).get(
      "zzz-verdict-upsert-overwrite",
    );
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.verdict).toBe("dismissed");
  });

  it("deleteKeywordVerdict removes only the targeted source's row", async () => {
    await upsertKeywordVerdict({
      keyword: "zzz-verdict-delete-target",
      verdict: "starred",
      source: "human",
    });
    await upsertKeywordVerdict({
      keyword: "zzz-verdict-delete-target",
      verdict: "dismissed",
      source: "pipeline",
    });

    const deleted = await deleteKeywordVerdict("zzz-verdict-delete-target", "human");
    expect(deleted).toBe(true);

    const rows = (await getKeywordVerdicts(["zzz-verdict-delete-target"])).get(
      "zzz-verdict-delete-target",
    );
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.source).toBe("pipeline");
  });

  it("deleteKeywordVerdict returns false for a non-existent verdict", async () => {
    const deleted = await deleteKeywordVerdict("zzz-verdict-never-existed", "human");
    expect(deleted).toBe(false);
  });
});
