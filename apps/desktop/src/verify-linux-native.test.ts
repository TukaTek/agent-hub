import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM build script without type declarations
import { findLinuxKoffiNative } from "../scripts/verify-linux-native.mjs";

const dirs: string[] = [];
const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "caah144-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "resources"), { recursive: true });
  writeFileSync(path.join(dir, "resources", "app.asar"), "");
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("verify-linux-native (CAAH-144)", () => {
  it("fails when the package has no app.asar.unpacked", () => {
    expect(() => findLinuxKoffiNative(fixture())).toThrow(/app\.asar\.unpacked/);
  });

  it("fails when app.asar.unpacked has no koffi-linux-x64 koffi.node", () => {
    const dir = fixture();
    mkdirSync(path.join(dir, "resources/app.asar.unpacked/node_modules/koffi"), { recursive: true });
    expect(() => findLinuxKoffiNative(dir)).toThrow(/koffi-linux-x64/);
  });

  it("returns the koffi.node path when the native module is unpacked", () => {
    const dir = fixture();
    const native = path.join(
      dir,
      "resources/app.asar.unpacked/node_modules/@koromix/koffi-linux-x64/linux_x64",
    );
    mkdirSync(native, { recursive: true });
    writeFileSync(path.join(native, "koffi.node"), "x");
    expect(findLinuxKoffiNative(dir)).toBe(path.join(native, "koffi.node"));
  });
});
