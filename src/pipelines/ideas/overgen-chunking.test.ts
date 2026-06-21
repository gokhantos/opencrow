import { describe, expect, test } from "bun:test";
import { chunkIntersections, mergeWithCap } from "./overgen-chunking";

describe("chunkIntersections", () => {
  test("splits evenly: 6 items size 2 -> three pairs", () => {
    const items = [1, 2, 3, 4, 5, 6];
    expect(chunkIntersections(items, 2)).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  test("handles a remainder: 5 items size 2 -> [2,2,1]", () => {
    const items = [1, 2, 3, 4, 5];
    expect(chunkIntersections(items, 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("chunkSize >= N yields a single chunk", () => {
    const items = [1, 2, 3];
    expect(chunkIntersections(items, 10)).toEqual([[1, 2, 3]]);
  });

  test("chunkSize 1 yields N singletons", () => {
    const items = [1, 2, 3];
    expect(chunkIntersections(items, 1)).toEqual([[1], [2], [3]]);
  });

  test("empty input yields []", () => {
    expect(chunkIntersections([], 2)).toEqual([]);
  });

  test("chunkSize < 1 is coerced to >= 1 (treated as 1)", () => {
    const items = [1, 2, 3];
    expect(chunkIntersections(items, 0)).toEqual([[1], [2], [3]]);
    expect(chunkIntersections(items, -5)).toEqual([[1], [2], [3]]);
  });

  test("does not mutate the input array", () => {
    const items = [1, 2, 3, 4];
    const copy = [...items];
    chunkIntersections(items, 2);
    expect(items).toEqual(copy);
  });
});

describe("mergeWithCap", () => {
  test("concatenates chunk arrays preserving order", () => {
    const chunks = [
      ["a", "b"],
      ["c", "d"],
    ];
    expect(mergeWithCap(chunks, 10)).toEqual(["a", "b", "c", "d"]);
  });

  test("truncates the concatenated total at maxCandidates, in order", () => {
    const chunks = [
      ["a", "b", "c"],
      ["d", "e", "f"],
      ["g", "h", "i"],
    ];
    // three chunks of 3 with cap 7 -> 7 kept, in order
    expect(mergeWithCap(chunks, 7)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  test("cap larger than total keeps all", () => {
    const chunks = [["a"], ["b", "c"]];
    expect(mergeWithCap(chunks, 100)).toEqual(["a", "b", "c"]);
  });

  test("empty chunks yield []", () => {
    expect(mergeWithCap([], 10)).toEqual([]);
    expect(mergeWithCap([[], []], 10)).toEqual([]);
  });

  test("a failed chunk ([]) still lets other chunks contribute", () => {
    // Simulates: chunk 2's chat call timed out -> returned [] (caught + skipped),
    // chunks 1 and 3 succeeded. Merged result must still contain their candidates.
    const chunks = [["a", "b"], [], ["c"]];
    expect(mergeWithCap(chunks, 10)).toEqual(["a", "b", "c"]);
  });

  test("cap of 0 yields []", () => {
    expect(mergeWithCap([["a", "b"]], 0)).toEqual([]);
  });
});
