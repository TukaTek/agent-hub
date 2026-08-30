import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  assertGitleaksHistoryResult,
  runGitleaksHistory,
} from "../../../scripts/gitleaks-history.mjs";
import { GITLEAKS_CANARY_PATH } from "../../../scripts/repository-policy.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const temporaryDirectories: string[] = [];
const githubExpression = (expression: string) => ["$", `{{ ${expression} }}`].join("");
const gitEnvironment = {
  ...process.env,
  GIT_AUTHOR_EMAIL: "policy@example.invalid",
  GIT_AUTHOR_NAME: "Repository Policy",
  GIT_COMMITTER_EMAIL: "policy@example.invalid",
  GIT_COMMITTER_NAME: "Repository Policy",
};

function git(repository: string, ...args: string[]) {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: gitEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function createRepository() {
  const repository = await mkdtemp(path.join(tmpdir(), "rakazo-history-test-"));
  temporaryDirectories.push(repository);
  execFileSync("git", ["init", "--initial-branch=main", repository], {
    env: gitEnvironment,
    stdio: "ignore",
  });
  await commitFile(repository, "README.md", "clean repository\n", "initial commit");
  return { initial: git(repository, "rev-parse", "HEAD"), repository };
}

async function commitFile(repository: string, filename: string, contents: string, message: string) {
  const destination = path.join(repository, filename);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, contents);
  git(repository, "add", "--all");
  git(repository, "commit", "--no-gpg-sign", "-m", message);
  return git(repository, "rev-parse", "HEAD");
}

async function removeAndCommit(
  repository: string,
  filename: string,
  message: string,
  addCleanMarker = false,
) {
  await rm(path.join(repository, filename));
  if (addCleanMarker) await writeFile(path.join(repository, "cleanup-marker.txt"), "clean\n");
  git(repository, "add", "--all");
  git(repository, "commit", "--no-gpg-sign", "-m", message);
  return git(repository, "rev-parse", "HEAD");
}

async function commitMergeResolution(repository: string, contents: string) {
  git(repository, "checkout", "-b", "merge-side");
  await commitFile(repository, "merge-only.txt", "side parent\n", "add side parent");
  git(repository, "checkout", "main");
  await commitFile(repository, "merge-only.txt", "main parent\n", "add main parent");
  const merge = spawnSync(
    "git",
    ["-C", repository, "merge", "--no-ff", "--no-commit", "merge-side"],
    { encoding: "utf8", env: gitEnvironment },
  );
  expect(merge.status, `${merge.stdout}\n${merge.stderr}`).toBe(1);
  await writeFile(path.join(repository, "merge-only.txt"), contents);
  git(repository, "add", "--all");
  git(repository, "commit", "--no-gpg-sign", "-m", "resolve merge");
  return git(repository, "rev-parse", "HEAD");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Gitleaks history CI policy", () => {
  it("keeps current-tree and bounded history scans as distinct exact-head CI gates", async () => {
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const workflow = parseYaml(await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8"));
    const steps = workflow.jobs.security.steps;
    const checkout = steps.find((step: Record<string, unknown>) =>
      String(step.uses ?? "").startsWith("actions/checkout@"),
    );
    const currentTree = steps.findIndex(
      (step: Record<string, unknown>) => step.run === "pnpm security:secrets",
    );
    const history = steps.findIndex(
      (step: Record<string, unknown>) =>
        step.run === 'pnpm security:secrets:history -- . "$GITLEAKS_BASE_SHA" "$GITLEAKS_HEAD_SHA"',
    );

    expect(packageJson.scripts["security:secrets"]).toBe("node scripts/gitleaks-scan.mjs .");
    expect(packageJson.scripts["security:secrets:history"]).toBe(
      "node scripts/gitleaks-history.mjs",
    );
    expect(checkout?.with).toMatchObject({
      "fetch-depth": 0,
      "persist-credentials": false,
      ref: githubExpression("github.event.pull_request.head.sha || github.sha"),
    });
    expect(currentTree).toBeGreaterThan(-1);
    expect(history).toBeGreaterThan(currentTree);
    expect(steps[history].env).toEqual({
      GITLEAKS_BASE_SHA: githubExpression(
        "github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.before",
      ),
      GITLEAKS_HEAD_SHA: githubExpression("github.event.pull_request.head.sha || github.sha"),
    });
  });
});

const describeWithGitleaks = process.env.GITLEAKS_POLICY_TESTS === "1" ? describe : describe.skip;

describeWithGitleaks("Gitleaks bounded history scan", () => {
  it("passes a clean candidate range", async () => {
    const { initial, repository } = await createRepository();
    const head = await commitFile(repository, "clean.txt", "still clean\n", "clean change");

    await expect(runGitleaksHistory(repository, initial, head)).resolves.toMatchObject({
      findingCount: 0,
      head,
      mergeBase: initial,
      range: `${initial}..${head}`,
    });
  });

  it("accepts the argument separator forwarded by pnpm", async () => {
    const { initial, repository } = await createRepository();
    const head = await commitFile(repository, "clean.txt", "still clean\n", "clean change");
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts/gitleaks-history.mjs"), "--", repository, initial, head],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${initial}..${head}`);
  });

  it("rejects a canary introduced and deleted inside the candidate range", async () => {
    const { initial, repository } = await createRepository();
    const canary = await readFile(path.join(root, GITLEAKS_CANARY_PATH), "utf8");
    await commitFile(repository, "transient.txt", canary, "introduce transient canary");
    const head = await removeAndCommit(repository, "transient.txt", "delete transient canary");

    await expect(runGitleaksHistory(repository, initial, head)).rejects.toThrow(
      /history scan detected.*transient\.txt/is,
    );
  });

  it("rejects a canary introduced only by merge resolution and deleted later", async () => {
    const { initial, repository } = await createRepository();
    const canary = await readFile(path.join(root, GITLEAKS_CANARY_PATH), "utf8");
    const merge = await commitMergeResolution(repository, canary);
    const head = await removeAndCommit(
      repository,
      "merge-only.txt",
      "delete resolved canary",
      true,
    );

    expect(git(repository, "rev-list", "--parents", "-n", "1", merge).split(" ")).toHaveLength(3);
    expect(git(repository, "show", `${merge}^1:merge-only.txt`)).not.toContain(canary.trim());
    expect(git(repository, "show", `${merge}^2:merge-only.txt`)).not.toContain(canary.trim());
    expect(git(repository, "show", `${merge}:merge-only.txt`)).toBe(canary.trim());
    await expect(runGitleaksHistory(repository, initial, head)).rejects.toThrow(
      /history scan detected.*merge-only\.txt/is,
    );
  });

  it("reports every governed commit as scanned when the candidate range contains a merge", async () => {
    const { initial, repository } = await createRepository();
    await commitMergeResolution(repository, "clean merge resolution\n");
    const head = await removeAndCommit(
      repository,
      "merge-only.txt",
      "delete clean resolution",
      true,
    );

    await expect(runGitleaksHistory(repository, initial, head)).resolves.toMatchObject({
      commitCount: 4,
      mergeCommitCount: 1,
      scannedCommitCount: 4,
    });
  });

  it("does not include a secret that exists only before the selected base", async () => {
    const { repository } = await createRepository();
    const canary = await readFile(path.join(root, GITLEAKS_CANARY_PATH), "utf8");
    await commitFile(repository, "historical.txt", canary, "introduce old canary");
    const selectedBase = await removeAndCommit(repository, "historical.txt", "delete old canary");
    const head = await commitFile(
      repository,
      "candidate.txt",
      "candidate is clean\n",
      "candidate change",
    );

    await expect(runGitleaksHistory(repository, selectedBase, head)).resolves.toMatchObject({
      findingCount: 0,
      mergeBase: selectedBase,
      range: `${selectedBase}..${head}`,
    });
  });

  it("fails closed for missing refs, empty ranges, and nonexistent repositories", async () => {
    const { initial, repository } = await createRepository();

    await expect(runGitleaksHistory(repository, "missing-base", "HEAD")).rejects.toThrow(
      /base ref/i,
    );
    await expect(runGitleaksHistory(repository, initial, initial)).rejects.toThrow(/empty/i);
    await expect(
      runGitleaksHistory(path.join(repository, "missing"), initial, "HEAD"),
    ).rejects.toThrow(/existing Git repository/i);
  });

  it("fails closed for shallow history", async () => {
    const { repository } = await createRepository();
    await commitFile(repository, "second.txt", "second commit\n", "second commit");
    const cloneParent = await mkdtemp(path.join(tmpdir(), "rakazo-history-clone-"));
    temporaryDirectories.push(cloneParent);
    const shallow = path.join(cloneParent, "shallow");
    execFileSync("git", ["clone", "--depth=1", `file://${repository}`, shallow], {
      env: gitEnvironment,
      stdio: "ignore",
    });

    await expect(runGitleaksHistory(shallow, "HEAD^", "HEAD")).rejects.toThrow(/shallow/i);
  });

  it("fails closed for malformed reports, inconsistent results, and scanner errors", () => {
    expect(() => assertGitleaksHistoryResult({ status: 0 }, "not JSON", "base..head")).toThrow(
      /valid JSON/i,
    );
    expect(() =>
      assertGitleaksHistoryResult(
        { status: 0 },
        JSON.stringify([{ RuleID: "rule" }]),
        "base..head",
      ),
    ).toThrow(/finding/i);
    expect(() => assertGitleaksHistoryResult({ status: 73 }, "[]", "base..head")).toThrow(
      /reported no findings/i,
    );
    expect(() =>
      assertGitleaksHistoryResult({ status: 2, stderr: "scanner error" }, "[]", "base..head"),
    ).toThrow(/scanner error/i);
  });
});
