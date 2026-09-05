import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const retiredProductName = ["ra", "kazo"].join("");
const retiredPositioning = ["grok", "bot"].join(" ");
const attributionFiles = new Set(["LICENSE", "NOTICE"]);

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
}

describe("CortexAI Agent Hub product identity", () => {
  it("keeps the retired product name out of tracked paths and product content", () => {
    const paths = trackedFiles();
    const invalidPaths = paths.filter((path) => path.toLowerCase().includes(retiredProductName));
    const invalidContent = paths.filter((path) => {
      if (!existsSync(path)) return false;
      if (attributionFiles.has(path)) return false;
      return readFileSync(path).toString("utf8").toLowerCase().includes(retiredProductName);
    });

    expect({ invalidPaths, invalidContent }).toEqual({
      invalidPaths: [],
      invalidContent: [],
    });
  });

  it("keeps obsolete competitor positioning out of tracked product content", () => {
    const invalidContent = trackedFiles().filter((path) => {
      if (!existsSync(path)) return false;
      if (attributionFiles.has(path)) return false;
      return readFileSync(path).toString("utf8").toLowerCase().includes(retiredPositioning);
    });

    expect(invalidContent).toEqual([]);
  });
});
