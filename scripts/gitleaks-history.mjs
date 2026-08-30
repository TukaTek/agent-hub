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

function gitleaksReportedCommitCount(result, range, scanInputCommitCount) {
  const matches = [...commandOutput(result).matchAll(/\b([0-9]+) commits scanned\./gu)];
  if (matches.length > 1) {
    throw new Error(
      `Gitleaks history scanner reported multiple scanned commit counts for ${range}`,
    );
  }
  if (matches.length === 0) return undefined;
  const count = Number.parseInt(matches[0][1], 10);
  if (!Number.isSafeInteger(count) || count < 1 || count > scanInputCommitCount) {
    throw new Error(`Gitleaks history scanner reported an invalid commit count for ${range}`);
  }
  return count;
}

function commitList(output, description) {
  const commits = output.length === 0 ? [] : output.split("\n");
  if (
    commits.some((commit) => !commitId.test(commit)) ||
    new Set(commits).size !== commits.length
  ) {
    throw new Error(`${description} returned invalid or duplicate commits`);
  }
  return commits;
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
  const scanLogOptions = `--diff-merges=first-parent ${range}`;
  const governedCommits = commitList(
    runGit(repository, ["rev-list", range], "Gitleaks history range validation"),
    "Gitleaks history range validation",
  );
  const commitCount = governedCommits.length;
  if (commitCount < 1) {
    throw new Error(`Gitleaks history range is empty or invalid: ${range}`);
  }
  const mergeCommits = commitList(
    runGit(repository, ["rev-list", "--merges", range], "Gitleaks history merge-count validation"),
    "Gitleaks history merge-count validation",
  );
  const mergeCommitCount = mergeCommits.length;
  if (mergeCommitCount > commitCount) {
    throw new Error(`Gitleaks history merge count is invalid: ${range}`);
  }
  const scanInputCommits = commitList(
    runGit(
      repository,
      ["log", "--format=%H", "--no-patch", "--diff-merges=first-parent", range],
      "Gitleaks history scanner-input validation",
    ),
    "Gitleaks history scanner-input validation",
  );
  if (
    scanInputCommits.length !== commitCount ||
    scanInputCommits.some((commit, index) => commit !== governedCommits[index])
  ) {
    throw new Error(`Gitleaks history scanner input does not match the governed range: ${range}`);
  }
  const scanInputCommitCount = scanInputCommits.length;

  const reportDirectory = await mkdtemp(path.join(tmpdir(), "rakazo-gitleaks-history-"));
  try {
    const reportPath = path.join(reportDirectory, "report.json");
    const result = spawnSync(
      "gitleaks",
      [
        "git",
        `--config=${configPath}`,
        "--no-banner",
        "--no-color",
        "--log-level=info",
        "--redact",
        "--exit-code=73",
        "--report-format=json",
        `--report-path=${reportPath}`,
        `--log-opts=${scanLogOptions}`,
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
    const reportedScannedCommitCount = gitleaksReportedCommitCount(
      result,
      range,
      scanInputCommitCount,
    );
    return {
      base,
      commitCount,
      findingCount: findings.length,
      head,
      mergeBase,
      mergeCommitCount,
      range,
      reportedScannedCommitCount,
      scanInputCommitCount,
    };
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
      .then(
        ({
          commitCount,
          head,
          mergeBase,
          mergeCommitCount,
          range,
          reportedScannedCommitCount,
          scanInputCommitCount,
        }) => {
          const reported =
            reportedScannedCommitCount === undefined
              ? "Gitleaks emitted no advisory addition-bearing commit count"
              : `Gitleaks reported ${reportedScannedCommitCount} commit(s) with additions`;
          console.log(
            `Gitleaks history scan passed: ${commitCount} governed candidate commit(s) including ${mergeCommitCount} merge commit(s), all ${scanInputCommitCount} commit(s) selected by the explicit merge-aware scanner input, ${reported}, merge base ${mergeBase}, exact head ${head}, range ${range}`,
          );
        },
      )
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
