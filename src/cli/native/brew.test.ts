import { test, expect } from "bun:test";
import { parseBrewList, pgBinDir } from "./brew.ts";

test("parseBrewList splits formula names", () => {
  expect(parseBrewList("postgresql@17\npython@3.11\n")).toEqual([
    "postgresql@17",
    "python@3.11",
  ]);
});

test("pgBinDir builds the keg-only bin path", () => {
  expect(pgBinDir("/opt/homebrew")).toBe(
    "/opt/homebrew/opt/postgresql@17/bin",
  );
});
