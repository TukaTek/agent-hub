import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertGitleaksPolicy } from "./repository-policy.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const configPath = path.join(root, ".gitleaks.toml");
const expectedGitleaksVersion = "8.30.1";
const commitId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

function commandOutput(result) {
  return [result.stderr, result.stdout]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim())
    .join("\n");
}

function runGit(repository, args, description) {
  const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8" });
  if (result.error) {
    throw new Error(`${description} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${description} failed${commandOutput(result) ? `: ${commandOutput(result)}` : ""}`,
    );
  }
  return result.stdout.trim();
}

function resolveCommit(repository, reference, role) {
  if (
    typeof reference !== "string" ||
    reference.length === 0 ||
    reference.trim() !== reference ||
    /[\0\s]/u.test(reference)
  ) {
    throw new Error(
      `Gitleaks history ${role} ref must be a non-empty Git revision without whitespace`,
    );
  }
  const resolved = runGit(
    repository,
    ["rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`],
    `Gitleaks history ${role} ref ${reference}`,
  );
  if (!commitId.test(resolved)) {
    throw new Error(`Gitleaks history ${role} ref did not resolve to one commit: ${reference}`);
  }
  return resolved;
}

function assertFinding(finding, index) {
  if (
    !finding ||
    typeof finding !== "object" ||
    typeof finding.RuleID !== "string" ||
    finding.RuleID.length === 0 ||
    typeof finding.File !== "string" ||
    finding.File.length === 0 ||
    typeof finding.Commit !== "string" ||
    finding.Commit.length === 0
  ) {
    throw new Error(`Gitleaks history report finding ${index + 1} is malformed`);
  }
}

export function assertGitleaksHistoryResult(result, reportSource, range) {
  let findings;
  try {
    findings = JSON.parse(reportSource);
  } catch (error) {
    throw new Error(
      `Gitleaks history report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(findings)) {
    throw new Error("Gitleaks history report must contain a JSON array of findings");
  }
  findings.forEach(assertFinding);

  if (result?.error) {
    throw new Error(
      `Gitleaks history scanner failed for ${range}: ${result.error instanceof Error ? result.error.message : String(result.error)}`,
    );
  }
  if (result?.status === 0) {
    if (findings.length !== 0) {
      throw new Error(
        `Gitleaks history scanner exited cleanly but reported ${findings.length} findings for ${range}`,
      );
    }
    return findings;
  }
  if (result?.status === 73) {
    if (findings.length === 0) {
      throw new Error(
        `Gitleaks history scanner reported leaks but reported no findings for ${range}`,
      );
    }
    const files = [...new Set(findings.map((finding) => finding.File))].sort();
    throw new Error(
      `Gitleaks history scan detected ${findings.length} finding(s) in ${range}: ${files.join(", ")}`,
    );
  }

  const details = commandOutput(result ?? {});
  throw new Error(
    `Gitleaks history scanner failed for ${range} with exit status ${result?.status ?? "none"}${details ? `: ${details}` : ""}`,
  );
}

export async function runGitleaksHistory(target, baseRef, headRef) {
  const requestedTarget = path.resolve(target);
  const targetInfo = await stat(requestedTarget).catch(() => undefined);
  if (!targetInfo?.isDirectory()) {
    throw new Error(
      `Gitleaks history target must be an existing Git repository: ${requestedTarget}`,
    );
  }
  const repository = await realpath(requestedTarget);
  const repositoryRoot = runGit(
    repository,
    ["rev-parse", "--show-toplevel"],
    "Gitleaks history target validation",
  );
  if ((await realpath(repositoryRoot)) !== repository) {
    throw new Error(`Gitleaks history target must be the Git repository root: ${requestedTarget}`);
  }
  const shallow = runGit(
    repository,
    ["rev-parse", "--is-shallow-repository"],
    "Gitleaks shallow-history validation",
  );
  if (shallow !== "false") {
    if (shallow === "true") {
      throw new Error("Gitleaks history scan refuses a shallow repository");
    }
    throw new Error(`Git returned an invalid shallow-history result: ${shallow}`);
  }

  const version = spawnSync("gitleaks", ["version"], { encoding: "utf8" });
  if (version.error || version.status !== 0) {
    throw new Error(
      `Gitleaks ${expectedGitleaksVersion} is required for history scanning${commandOutput(version) ? `: ${commandOutput(version)}` : ""}`,
    );
  }
  if (version.stdout.trim() !== expectedGitleaksVersion) {
    throw new Error(
      `Gitleaks history scanning requires version ${expectedGitleaksVersion}; found ${version.stdout.trim() || "unknown"}`,
    );
  }

  const configInfo = await stat(configPath).catch(() => undefined);
  if (!configInfo?.isFile()) throw new Error(`Gitleaks config is missing: ${configPath}`);
  assertGitleaksPolicy(await readFile(configPath, "utf8"));

  const checkedOutHead = resolveCommit(repository, "HEAD", "checked-out head");
  const head = resolveCommit(repository, headRef, "head");
  if (head !== checkedOutHead) {
    throw new Error(
      `Gitleaks history head must equal the checked-out exact head ${checkedOutHead}; found ${head}`,
    );
  }
  const base = resolveCommit(repository, baseRef, "base");
  if (base === head) throw new Error("Gitleaks history range must not be empty");

  const mergeBase = runGit(
    repository,
    ["merge-base", base, head],
    "Gitleaks history merge-base resolution",
  );
  if (!commitId.test(mergeBase) || mergeBase === head) {
    throw new Error("Gitleaks history range must contain at least one candidate commit");
  }
  const range = `${mergeBase}..${head}`;
  const commitCount = Number.parseInt(
    runGit(repository, ["rev-list", "--count", range], "Gitleaks history range validation"),
    10,
  );
  if (!Number.isSafeInteger(commitCount) || commitCount < 1) {
    throw new Error(`Gitleaks history range is empty or invalid: ${range}`);
  }

  const reportDirectory = await mkdtemp(path.join(tmpdir(), "rakazo-gitleaks-history-"));
  try {
    const reportPath = path.join(reportDirectory, "report.json");
    const result = spawnSync(
      "gitleaks",
      [
        "git",
        `--config=${configPath}`,
        "--no-banner",
        "--redact",
        "--exit-code=73",
        "--report-format=json",
        `--report-path=${reportPath}`,
        `--log-opts=${range}`,
        repository,
      ],
      { cwd: repository, encoding: "utf8" },
    );
    if (result.error) {
      throw new Error(`Gitleaks history scanner failed to start: ${result.error.message}`);
    }
    const reportSource = await readFile(reportPath, "utf8").catch((error) => {
      throw new Error(
        `Gitleaks history scanner did not produce a readable JSON report: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    const findings = assertGitleaksHistoryResult(result, reportSource, range);
    return { base, commitCount, findingCount: findings.length, head, mergeBase, range };
  } finally {
    await rm(reportDirectory, { force: true, recursive: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const commandArguments = process.argv.slice(2);
  if (commandArguments[0] === "--") commandArguments.shift();
  const [target, baseRef, headRef, ...extra] = commandArguments;
  if (!target || !baseRef || !headRef || extra.length > 0) {
    console.error(
      "Usage: node scripts/gitleaks-history.mjs <repository-root> <base-ref> <exact-head-ref>",
    );
    process.exitCode = 2;
  } else {
    runGitleaksHistory(target, baseRef, headRef)
      .then(({ commitCount, head, mergeBase, range }) => {
        console.log(
          `Gitleaks history scan passed: ${commitCount} candidate commit(s), merge base ${mergeBase}, exact head ${head}, range ${range}`,
        );
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
