import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const lockfile = readFileSync("pnpm-lock.yaml", "utf8");

/** Packages pinned past a security fix, with the first patched release. */
const PATCHED: Record<string, string> = {
  // elie222/rakazo#4132: fast-uri before 3.1.9 is vulnerable.
  "fast-uri": "3.1.9",
};

function resolvedVersions(name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const pattern = new RegExp(`^ {2}'?${escaped}@(\\d+\\.\\d+\\.\\d+[^':(]*)'?:`, "gm");
  return [...new Set([...lockfile.matchAll(pattern)].map((match) => match[1]!))];
}

function atLeast(version: string, floor: string): boolean {
  const a = version.split(/[.-]/).map(Number);
  const b = floor.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

describe("lockfile security pins", () => {
  it.each(Object.entries(PATCHED))("resolves %s only to %s or later", (name, floor) => {
    const versions = resolvedVersions(name);
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.filter((version) => !atLeast(version, floor))).toEqual([]);
  });
});
