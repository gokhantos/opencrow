import path from "node:path";

export const REQUIRED_FORMULAE = ["postgresql@17", "python@3.11"] as const;

export function parseBrewList(output: string): readonly string[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function pgBinDir(brewPrefix: string): string {
  return path.join(brewPrefix, "opt", "postgresql@17", "bin");
}
