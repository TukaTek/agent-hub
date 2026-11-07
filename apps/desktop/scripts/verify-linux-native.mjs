#!/usr/bin/env node
// CAAH-144: fail a Linux package that lacks Koffi's native module. Without it the
// AppImage crashes at launch with "Cannot find the native Koffi module".
// Usage: node scripts/verify-linux-native.mjs <linux-unpacked dir or extracted AppImage root>
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export function findLinuxKoffiNative(packageRoot) {
  const unpacked = path.join(packageRoot, "resources", "app.asar.unpacked");
  if (!existsSync(unpacked)) {
    throw new Error(`Linux package has no resources/app.asar.unpacked under ${packageRoot}`);
  }
  const match = walk(unpacked).find(
    (file) =>
      path.basename(file) === "koffi.node" &&
      file.split(path.sep).includes("koffi-linux-x64") &&
      file.split(path.sep).includes("@koromix"),
  );
  if (!match) {
    throw new Error(
      `app.asar.unpacked has no @koromix/koffi-linux-x64/**/koffi.node under ${unpacked}`,
    );
  }
  return match;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: verify-linux-native.mjs <package root>");
    process.exit(2);
  }
  try {
    console.log(`ok: ${findLinuxKoffiNative(path.resolve(root))}`);
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  }
}
