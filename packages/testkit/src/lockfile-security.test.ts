import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// From this file, so the package's own test script (run from packages/testkit) finds it too.
const lockfile = readFileSync(path.resolve(import.meta.dirname, "../../../pnpm-lock.yaml"), "utf8");

/** Packages pinned past a security fix, with the first patched release. */
const PATCHED: Record<string, string> = {
  // fast-uri before 3.1.9 is vulnerable.
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
