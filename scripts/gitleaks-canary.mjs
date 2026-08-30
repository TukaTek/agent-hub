import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGitleaksDirectory } from "./gitleaks-scan.mjs";
import { assertGitleaksPolicy, GITLEAKS_CANARY_PATH } from "./repository-policy.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const configPath = path.join(root, ".gitleaks.toml");

function runGitleaks(args) {
  return spawnSync("gitleaks", args, { encoding: "utf8" });
}

const version = runGitleaks(["version"]);
if (version.status !== 0) {
  throw new Error(`Gitleaks is required for the canary test: ${version.stderr || version.error}`);
}
assertGitleaksPolicy(await readFile(configPath, "utf8"));

const fixtureDirectory = await mkdtemp(path.join(tmpdir(), "rakazo-gitleaks-canary-"));
try {
  await copyFile(path.join(root, GITLEAKS_CANARY_PATH), path.join(fixtureDirectory, "leak.txt"));
  const detected = await runGitleaksDirectory(fixtureDirectory, { exitCode: 73 });
  if (detected.status !== 73) {
    throw new Error(
      `Gitleaks did not detect the committed canary: ${detected.stdout}${detected.stderr}`,
    );
  }

  let missingRejected = false;
  try {
    await runGitleaksDirectory(path.join(fixtureDirectory, "missing"));
  } catch {
    missingRejected = true;
  }
  if (!missingRejected) {
    throw new Error("Gitleaks did not fail closed for a nonexistent scan target");
  }
} finally {
  await rm(fixtureDirectory, { force: true, recursive: true });
}

console.log("Gitleaks canary detected; nonexistent targets fail closed");
