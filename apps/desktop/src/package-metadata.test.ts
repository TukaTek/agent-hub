import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
) as {
  productName?: string;
  packageManager?: string;
  build?: { productName?: string };
};

const rootPackageJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../../../package.json"), "utf8"),
) as { packageManager?: string };

describe("desktop package metadata", () => {
  it("shares the customer-facing name between Electron and electron-builder", () => {
    expect(packageJson.productName).toBe("CortexAI Agent Hub");
    expect(packageJson.build?.productName).toBeUndefined();
  });

  // CAAH-144: without this, electron-builder launched via npx falls back to npm,
  // drops pnpm's optional @koromix/koffi-linux-x64 and the AppImage crashes at launch.
  it("pins the same pnpm packageManager as the workspace root so electron-builder detects pnpm", () => {
    expect(rootPackageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(packageJson.packageManager).toBe(rootPackageJson.packageManager);
  });
});
