import { test, expect, describe } from "bun:test";
import { excludeConsumed } from "./collectors";

interface Row {
  readonly id: string;
  readonly title: string;
}

const id = (r: Row) => r.id;

// ── excludeConsumed (consumed-source dedup) ────────────────────────────────

describe("excludeConsumed", () => {
  test("returns all rows when nothing has been consumed", () => {
    const rows: Row[] = [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ];
    const result = excludeConsumed(rows, new Set<string>(), id, 10);
    expect(result.selected).toEqual(rows);
    expect(result.selectedIds).toEqual(["a", "b"]);
  });

  test("filters out already-consumed rows", () => {
    const rows: Row[] = [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
      { id: "c", title: "C" },
    ];
    const consumed = new Set(["b"]);
    const result = excludeConsumed(rows, consumed, id, 10);
    expect(result.selectedIds).toEqual(["a", "c"]);
    expect(result.selected.map((r) => r.id)).toEqual(["a", "c"]);
  });

  test("caps the result at the target count", () => {
    const rows: Row[] = [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
      { id: "c", title: "C" },
      { id: "d", title: "D" },
    ];
    const result = excludeConsumed(rows, new Set<string>(), id, 2);
    expect(result.selected).toHaveLength(2);
    expect(result.selectedIds).toEqual(["a", "b"]);
  });

  test("returns empty when every fresh row is consumed", () => {
    const rows: Row[] = [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ];
    const consumed = new Set(["a", "b"]);
    const result = excludeConsumed(rows, consumed, id, 10);
    expect(result.selected).toEqual([]);
    expect(result.selectedIds).toEqual([]);
  });

  test("applies the consumed filter before the target cap", () => {
    const rows: Row[] = [
      { id: "a", title: "A" }, // consumed
      { id: "b", title: "B" },
      { id: "c", title: "C" },
      { id: "d", title: "D" },
    ];
    const consumed = new Set(["a"]);
    // After excluding 'a', the first 2 fresh rows are b and c.
    const result = excludeConsumed(rows, consumed, id, 2);
    expect(result.selectedIds).toEqual(["b", "c"]);
  });

  test("preserves input order and does not mutate the source array", () => {
    const rows: Row[] = [
      { id: "c", title: "C" },
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ];
    const snapshot = [...rows];
    const result = excludeConsumed(rows, new Set<string>(), id, 10);
    expect(result.selectedIds).toEqual(["c", "a", "b"]);
    expect(rows).toEqual(snapshot);
  });

  test("handles an empty input array", () => {
    const result = excludeConsumed<Row>([], new Set<string>(), id, 5);
    expect(result.selected).toEqual([]);
    expect(result.selectedIds).toEqual([]);
  });

  test("supports a custom id extractor", () => {
    const rows = [
      { uuid: "x1" },
      { uuid: "x2" },
    ];
    const result = excludeConsumed(rows, new Set(["x1"]), (r) => r.uuid, 10);
    expect(result.selectedIds).toEqual(["x2"]);
  });
});
