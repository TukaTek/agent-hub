import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertDependabotPolicy,
  assertGitleaksPolicy,
  assertPinnedWorkflowSource,
  assertProtectedCodeowners,
  assertRepositoryPolicy,
  CANARY_RULE_ID,
  effectiveCodeowners,
  GITLEAKS_CANARY_PATH,
  parseCodeowners,
} from "../../../scripts/repository-policy.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const sha = "0123456789abcdef0123456789abcdef01234567";

describe("GitHub Actions pin policy", () => {
  it("accepts quoted and inline exact-SHA actions plus local workflows", () => {
    const workflow = `
name: pinned
on: push
jobs:
  local:
    "uses": "./.github/workflows/local.yml"
  test:
    runs-on: ubuntu-latest
    steps:
      - { "uses": "actions/checkout@${sha}" }
      - uses: ./.github/actions/local
`;

    expect(() => assertPinnedWorkflowSource(workflow, "pinned.yml")).not.toThrow();
  });

  it("rejects mutable remote action tags hidden in folded scalars", () => {
    const workflow = `
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: >-
          actions/checkout@v5
`;

    expect(() => assertPinnedWorkflowSource(workflow, "folded.yml")).toThrow(
      /actions\/checkout@v5/,
    );
  });

  it("rejects mutable remote refs hidden with YAML escapes", () => {
    const workflow = `
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - "uses": "actions\\u002fcheckout@main"
`;

    expect(() => assertPinnedWorkflowSource(workflow, "escaped.yml")).toThrow(
      /actions\/checkout@main/,
    );
  });

  it("rejects short SHAs, non-string uses, duplicate keys, and malformed YAML", () => {
    expect(() =>
      assertPinnedWorkflowSource(
        `jobs: { test: { runs-on: ubuntu-latest, steps: [{ uses: owner/action@abc123 }] } }`,
        "short.yml",
      ),
    ).toThrow(/owner\/action@abc123/);
    expect(() =>
      assertPinnedWorkflowSource(
        `jobs: { test: { runs-on: ubuntu-latest, steps: [{ uses: 42 }] } }`,
        "number.yml",
      ),
    ).toThrow(/string/);
    expect(() =>
      assertPinnedWorkflowSource(
        `jobs:\n  test:\n    uses: owner/one@${sha}\n    uses: owner/two@${sha}\n`,
        "duplicate.yml",
      ),
    ).toThrow(/duplicate|Map keys must be unique/i);
    expect(() => assertPinnedWorkflowSource("jobs: [", "broken.yml")).toThrow(/broken\.yml/);
  });

  it("rejects remote schemes and local traversal", () => {
    expect(() =>
      assertPinnedWorkflowSource(
        `jobs: { test: { uses: "docker://example.invalid/image:latest" } }`,
        "docker.yml",
      ),
    ).toThrow(/docker:/);
    expect(() =>
      assertPinnedWorkflowSource(`jobs: { test: { uses: "./../outside/action" } }`, "local.yml"),
    ).toThrow(/local action/i);
  });
});

describe("CODEOWNERS policy", () => {
  it("uses the last matching CODEOWNERS rule", () => {
    const rules = parseCodeowners(`
/.github/workflows/ @acepgh
/.github/workflows/release.yml @release-owner
`);

    expect(effectiveCodeowners(rules, ".github/workflows/release.yml")).toEqual(["@release-owner"]);
  });

  it("fails closed on ownerless and unsupported patterns", () => {
    expect(() => parseCodeowners("/.github/workflows/\n")).toThrow(/owner/i);
    expect(() => parseCodeowners("!/.github/workflows/ @acepgh\n")).toThrow(/unsupported/i);
    expect(() => parseCodeowners("/[ab].txt @acepgh\n")).toThrow(/unsupported/i);
  });

  it("detects a later wildcard that steals protected ownership", () => {
    const source = `
/.github/workflows/ @acepgh
* @someone-else
`;

    expect(() =>
      assertProtectedCodeowners(source, [".github/workflows/ci.yml"], "@acepgh"),
    ).toThrow(/\.github\/workflows\/ci\.yml/);
  });
});

describe("Dependabot policy", () => {
  it("requires bounded weekly pnpm and GitHub Actions updates", async () => {
    const source = await readFile(path.join(root, ".github/dependabot.yml"), "utf8");
    expect(assertDependabotPolicy(source)).toEqual(["github-actions", "npm"]);
  });

  it("rejects unbounded or non-weekly update entries", () => {
    expect(() =>
      assertDependabotPolicy(`
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: daily }
    open-pull-requests-limit: 20
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
    open-pull-requests-limit: 5
`),
    ).toThrow(/weekly|bounded/i);
  });
});

describe("Gitleaks policy", () => {
  it("keeps one exact canary allowlist and a canary rule that matches the fixture", async () => {
    const configSource = await readFile(path.join(root, ".gitleaks.toml"), "utf8");
    const canary = (await readFile(path.join(root, GITLEAKS_CANARY_PATH), "utf8")).trim();
    const config = assertGitleaksPolicy(configSource);
    const rule = config.rules.find((candidate) => candidate.id === CANARY_RULE_ID);

    expect(rule).toBeDefined();
    expect(new RegExp(rule!.regex).test(canary)).toBe(true);
  });

  it("rejects broad or extra allowlists", () => {
    expect(() =>
      assertGitleaksPolicy(`
[extend]
useDefault = true
[[rules]]
id = "${CANARY_RULE_ID}"
regex = '''CAAH30_GITLEAKS_CANARY_[A-Z0-9]{32}'''
[[allowlists]]
paths = ['''.*''']
`),
    ).toThrow(/allowlist/i);
    expect(() =>
      assertGitleaksPolicy(`
[extend]
useDefault = true
[[rules]]
id = "${CANARY_RULE_ID}"
regex = '''CAAH30_GITLEAKS_CANARY_[A-Z0-9]{32}'''
[rules.allowlist]
regexes = ['''.*''']
[[allowlists]]
condition = "OR"
paths = ['''^scripts/fixtures/gitleaks-canary\\.txt$''']
`),
    ).toThrow(/allowlist/i);
  });
});

describe("repository policy", () => {
  it("pins every workflow and covers every protected path with the verified owner", async () => {
    await expect(assertRepositoryPolicy(root)).resolves.toMatchObject({
      codeowner: "@acepgh",
      workflowCount: expect.any(Number),
    });
  });
});
