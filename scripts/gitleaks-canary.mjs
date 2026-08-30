import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGitleaksDirectory } from "./gitleaks-scan.mjs";
import {
  assertGitleaksPolicy,
  CANARY_RULE_ID,
  GITLEAKS_CANARY_PATH,
} from "./repository-policy.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const configPath = path.join(root, ".gitleaks.toml");

function runGitleaks(args) {
  return spawnSync("gitleaks", args, { encoding: "utf8" });
}

export function assertGitleaksCanaryReport(source, expectedPaths) {
  let findings;
  try {
    findings = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `Gitleaks canary report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(findings)) {
    throw new Error("Gitleaks canary report must contain a JSON array of findings");
  }

  const expected = new Set(expectedPaths.map((file) => path.normalize(file)));
  if (expected.size !== expectedPaths.length || findings.length !== expected.size) {
    throw new Error(
      `Gitleaks canary report must contain exactly ${expected.size} expected findings; found ${findings.length}`,
    );
  }

  for (const finding of findings) {
    if (!finding || typeof finding !== "object" || finding.RuleID !== CANARY_RULE_ID) {
      throw new Error(`Gitleaks canary finding must use exact rule ${CANARY_RULE_ID}`);
    }
    if (typeof finding.File !== "string") {
      throw new Error("Gitleaks canary finding must contain a file path");
    }
    const findingPath = path.normalize(finding.File);
    if (!expected.delete(findingPath)) {
      throw new Error(`Gitleaks canary finding has unexpected path: ${finding.File}`);
    }
  }
  if (expected.size !== 0) {
    throw new Error(
      `Gitleaks canary report is missing expected paths: ${[...expected].join(", ")}`,
    );
  }
  return findings;
}

async function assertReportedCanaries(scanRoot, reportPath, expectedPaths) {
  const detected = await runGitleaksDirectory(scanRoot, { exitCode: 73, reportPath });
  if (detected.status !== 73) {
    throw new Error(
      `Gitleaks did not detect the expected canaries: ${detected.stdout}${detected.stderr}`,
    );
  }
  return assertGitleaksCanaryReport(await readFile(reportPath, "utf8"), expectedPaths);
}

export async function runGitleaksCanary() {
  const version = runGitleaks(["version"]);
  if (version.status !== 0) {
    throw new Error(`Gitleaks is required for the canary test: ${version.stderr || version.error}`);
  }
  assertGitleaksPolicy(await readFile(configPath, "utf8"));

  const fixtureDirectory = await mkdtemp(path.join(tmpdir(), "rakazo-gitleaks-canary-"));
  try {
    const copiedRoot = path.join(fixtureDirectory, "copied-canary");
    const copiedPath = path.join(copiedRoot, "leak.txt");
    await mkdir(copiedRoot);
    await copyFile(path.join(root, GITLEAKS_CANARY_PATH), copiedPath);
    await assertReportedCanaries(copiedRoot, path.join(fixtureDirectory, "copied.json"), [
      path.basename(copiedPath),
    ]);

    const repositoryRoot = path.join(fixtureDirectory, "repository-root");
    const nearMisses = [
      "scripts/fixtures/gitleaks-canary.txt.copy",
      "scripts/fixtures/gitleaks-canary-copy.txt",
      "scripts/fixtures-copy/gitleaks-canary.txt",
      "prefix/scripts/fixtures/gitleaks-canary.txt",
    ];
    const matrixPaths = [GITLEAKS_CANARY_PATH, ...nearMisses];
    for (const relativePath of matrixPaths) {
      const destination = path.join(repositoryRoot, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(root, GITLEAKS_CANARY_PATH), destination);
    }
    await assertReportedCanaries(
      repositoryRoot,
      path.join(fixtureDirectory, "near-misses.json"),
      nearMisses,
    );

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

  console.log(
    `Gitleaks canary found exact rule ${CANARY_RULE_ID} at leak.txt; 4 repository-root near misses detected; nonexistent targets fail closed`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runGitleaksCanary().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
