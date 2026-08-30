import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { assertGitleaksCanaryReport } from "../../../scripts/gitleaks-canary.mjs";
import {
  assertCandidateCheckoutPolicy,
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
const githubExpression = (expression: string) => ["$", `{{ ${expression} }}`].join("");
const exactCandidateRef = githubExpression("github.event.pull_request.head.sha || github.sha");

describe("GitHub Actions pin policy", () => {
  it("accepts quoted and inline exact-SHA actions and reusable workflows", () => {
    const workflow = `
name: pinned
on: push
jobs:
  reusable:
    "uses": "TukaTek/agent-hub/.github/workflows/playwright.yml@${sha}"
  test:
    runs-on: ubuntu-latest
    steps:
      - { "uses": "actions/checkout@${sha}" }
`;

    expect(() => assertPinnedWorkflowSource(workflow, "pinned.yml")).not.toThrow();
  });

  it.each([
    ["plain syntax", `jobs:\n  reusable:\n    uses: ./.github/workflows/playwright.yml\n`],
    [
      "an escaped uses key",
      `jobs:\n  reusable:\n    "us\\u0065s": ./.github/workflows/playwright.yml\n`,
    ],
    [
      "an explicit uses key",
      `jobs:\n  reusable:\n    ? uses\n    : ./.github/workflows/playwright.yml\n`,
    ],
    [
      "an aliased uses value",
      `jobs:\n  first:\n    uses: &workflow ./.github/workflows/playwright.yml\n  second:\n    uses: *workflow\n`,
    ],
  ])("accepts a canonical job-level local reusable workflow with %s", (_name, workflow) => {
    expect(() => assertPinnedWorkflowSource(workflow, "local-reusable.yml")).not.toThrow();
  });

  it.each([
    ["plain syntax", `uses: ./.github/workflows/playwright.yml`],
    ["an escaped uses key", `"us\\u0065s": ./.github/workflows/playwright.yml`],
    ["an explicit uses key", `? uses\n        : ./.github/workflows/playwright.yml`],
    [
      "an aliased uses value",
      `uses: &workflow ./.github/workflows/playwright.yml\n      - uses: *workflow`,
    ],
  ])("rejects a workflow-looking step-level local action with %s", (_name, usesEntry) => {
    const workflow = `jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - ${usesEntry}\n`;

    expect(() => assertPinnedWorkflowSource(workflow, "local-step.yml")).toThrow(/local|step/i);
  });

  it.each([
    ["a local action", "./.github/actions/bridge"],
    ["an absolute path", "/.github/workflows/playwright.yml"],
    ["traversal", "./.github/workflows/../playwright.yml"],
    ["an expression", githubExpression("inputs.action")],
    ["a SHA-looking local action", `./.github/actions/${sha}`],
  ])("rejects step-level %s", (_name, action) => {
    const workflow = `jobs: { test: { runs-on: ubuntu-latest, steps: [{ uses: ${JSON.stringify(action)} }] } }`;

    expect(() => assertPinnedWorkflowSource(workflow, "untrusted-step.yml")).toThrow();
  });

  it("enforces a bounded canonical local reusable workflow filename", () => {
    const bounded = `./.github/workflows/${"a".repeat(64)}.yml`;
    const tooLong = `./.github/workflows/${"a".repeat(65)}.yml`;
    const workflow = (uses: string) => `jobs: { call: { uses: ${JSON.stringify(uses)} } }`;

    expect(() => assertPinnedWorkflowSource(workflow(bounded), "bounded.yml")).not.toThrow();
    for (const invalid of [
      tooLong,
      "./.github/workflows/playwright.yaml",
      "./.github/workflows/playwright..backup.yml",
      "./.github/workflows/playwright.yml?ref=main",
      "./.github/workflows/playwright.yml#fragment",
    ]) {
      expect(() => assertPinnedWorkflowSource(workflow(invalid), "unbounded.yml")).toThrow(
        /bounded-name/i,
      );
    }
  });

  it.each([
    ["a local action", "./.github/actions/bridge"],
    ["a local action with a SHA-looking name", `./.github/actions/${sha}`],
    [
      "a local reusable workflow with a SHA-looking suffix",
      `./.github/workflows/playwright.yml@${sha}`,
    ],
    ["an absolute path", "/.github/actions/bridge"],
    ["a bare relative path", ".github/actions/bridge"],
    ["parent traversal", "../outside/action"],
    ["nested traversal", "./.github/actions/../bridge"],
    ["workflow traversal", "./.github/workflows/../playwright.yml"],
    ["a percent-encoded separator", "./.github%2Fworkflows/playwright.yml"],
    ["a backslash separator", ".\\.github\\workflows\\playwright.yml"],
    ["an extra suffix", "./.github/workflows/playwright.yml.backup"],
    ["an extra ref suffix", `./.github/workflows/playwright.yml@${sha}`],
    ["a nested workflow path", "./.github/workflows/nested/playwright.yml"],
    ["an expression", githubExpression("inputs.action")],
    ["an expression-like ref", `owner/action@${githubExpression("inputs.ref")}`],
  ])("rejects %s", (_name, action) => {
    const workflow = `jobs: { test: { uses: ${JSON.stringify(action)} } }`;

    expect(() => assertPinnedWorkflowSource(workflow, "untrusted.yml")).toThrow(
      /exact 40-hex commit SHA/i,
    );
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
    ).toThrow(/exact 40-hex commit SHA/i);
  });

  it("uses the candidate commit's local Playwright workflow from every repository caller", async () => {
    const ci = parseYaml(await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8"));
    const nightly = parseYaml(
      await readFile(path.join(root, ".github/workflows/nightly-verification.yml"), "utf8"),
    );

    expect(ci.jobs["test-e2e"].uses).toBe("./.github/workflows/playwright.yml");
    expect(nightly.jobs["visual-web"].uses).toBe("./.github/workflows/playwright.yml");
  });
});

describe("exact candidate checkout policy", () => {
  it("checks out the exact candidate head in every functional validation job", async () => {
    const matrix = {
      "ci.yml": ["security", "lint", "check", "build", "test", "test-integration"],
      "playwright.yml": ["playwright"],
    };

    for (const [filename, jobNames] of Object.entries(matrix)) {
      const workflow = parseYaml(
        await readFile(path.join(root, ".github/workflows", filename), "utf8"),
      );
      for (const jobName of jobNames) {
        const checkout = workflow.jobs[jobName].steps.find((step: Record<string, unknown>) =>
          String(step.uses ?? "").startsWith("actions/checkout@"),
        );
        expect(checkout?.with?.ref, `${filename}:${jobName}`).toBe(exactCandidateRef);
      }
    }
  });

  it("keeps full history on the exact-head security checkout", async () => {
    const workflow = parseYaml(await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8"));
    const checkout = workflow.jobs.security.steps.find((step: Record<string, unknown>) =>
      String(step.uses ?? "").startsWith("actions/checkout@"),
    );

    expect(checkout?.with).toMatchObject({
      "fetch-depth": 0,
      ref: exactCandidateRef,
    });
  });

  it("keeps the workflow_run publisher on the trusted default branch", async () => {
    const workflow = parseYaml(
      await readFile(path.join(root, ".github/workflows/publish-playwright-report.yml"), "utf8"),
    );
    const checkout = workflow.jobs.publish.steps.find((step: Record<string, unknown>) =>
      String(step.uses ?? "").startsWith("actions/checkout@"),
    );

    expect(checkout?.with?.ref).toBe(githubExpression("github.event.repository.default_branch"));
  });

  it.each([
    [
      "a missing ref",
      `jobs:\n  candidate:\n    steps:\n      - uses: actions/checkout@${sha}\n        with:\n          fetch-depth: 0\n`,
      /exact candidate head/i,
    ],
    [
      "a synthetic merge ref",
      `jobs:\n  candidate:\n    steps:\n      - uses: actions/checkout@${sha}\n        with:\n          fetch-depth: 0\n          ref: refs/pull/123/merge\n`,
      /synthetic merge/i,
    ],
    [
      "shallow history",
      `jobs:\n  candidate:\n    steps:\n      - uses: actions/checkout@${sha}\n        with:\n          fetch-depth: 1\n          ref: ${exactCandidateRef}\n`,
      /full history/i,
    ],
  ])("rejects candidate validation with %s", (_name, workflow, expectedError) => {
    expect(() =>
      assertCandidateCheckoutPolicy(workflow, "candidate.yml", {
        candidateJobs: ["candidate"],
        historyJobs: ["candidate"],
      }),
    ).toThrow(expectedError);
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

  it("protects future local action manifests", async () => {
    const source = await readFile(path.join(root, ".github/CODEOWNERS"), "utf8");
    const probe = ".github/actions/bridge/action.yml";

    expect(effectiveCodeowners(parseCodeowners(source), probe)).toEqual(["@acepgh"]);
    expect(() => assertProtectedCodeowners(source, [probe], "@acepgh")).not.toThrow();
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
  it("accepts the exact policy through semantic TOML formatting variants", () => {
    expect(() =>
      assertGitleaksPolicy(`
title='Rakazo secret scanning policy'
extend = { useDefault=true }

[[ rules ]]
keywords=["CAAH30_GITLEAKS_CANARY_"]
regex='CAAH30_GITLEAKS_CANARY_[A-Z0-9]{32}'
description='Repository-owned canary proving the Gitleaks gate executes'
id='${CANARY_RULE_ID}'

[[ allowlists ]]
targetRules=['${CANARY_RULE_ID}']
paths=['''^scripts/fixtures/gitleaks-canary\\.txt$''']
regexTarget='secret'
regexes=['''^CAAH30_GITLEAKS_CANARY_0123456789ABCDEF0123456789ABCDE[F]$''']
condition='AND'
description='Ignore only the inert committed canary at its canonical path'
`),
    ).not.toThrow();
  });

  it("keeps one exact canary allowlist and a canary rule that matches the fixture", async () => {
    const configSource = await readFile(path.join(root, ".gitleaks.toml"), "utf8");
    const canary = (await readFile(path.join(root, GITLEAKS_CANARY_PATH), "utf8")).trim();
    const config = assertGitleaksPolicy(configSource);
    const rule = config.rules.find((candidate) => candidate.id === CANARY_RULE_ID);

    expect(rule).toBeDefined();
    expect(new RegExp(rule!.regex).test(canary)).toBe(true);
    expect(config.allowlists).toEqual([
      {
        condition: "AND",
        description: "Ignore only the inert committed canary at its canonical path",
        paths: ["^scripts/fixtures/gitleaks-canary\\.txt$"],
        regexes: ["^CAAH30_GITLEAKS_CANARY_0123456789ABCDEF0123456789ABCDE[F]$"],
        regexTarget: "secret",
        targetRules: [CANARY_RULE_ID],
      },
    ]);
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

  it.each([
    [
      "an external extension path",
      (source: string) =>
        source.replace("useDefault = true", 'useDefault = true\npath = "/tmp/attacker.toml"'),
    ],
    [
      "dotted external extension syntax",
      (source: string) =>
        source.replace(
          "[extend]\nuseDefault = true",
          'extend.useDefault=true\nextend.path="/tmp/attacker.toml"',
        ),
    ],
    [
      "disabled default rules",
      (source: string) =>
        source.replace(
          "useDefault = true",
          'useDefault=true\ndisabledRules = [\n  "generic-api-key",\n]',
        ),
    ],
    [
      "disabled default rules without spaces",
      (source: string) =>
        source.replace("useDefault = true", 'useDefault=true\ndisabledRules=["generic-api-key"]'),
    ],
    [
      "useDefault=false",
      (source: string) => source.replace("useDefault = true", "useDefault=false"),
    ],
    [
      "an extra rule",
      (source: string) => `${source}\n[[rules]]\nid = "attacker"\nregex = '''NEVER_MATCH'''\n`,
    ],
    [
      "an extra rule using spaced table syntax",
      (source: string) => `${source}\n[[ rules ]]\nid="attacker"\nregex='NEVER_MATCH'\n`,
    ],
    [
      "an unexpected top-level section",
      (source: string) => `${source}\n[attacker]\nenabled = true\n`,
    ],
    [
      "an unexpected rule key",
      (source: string) =>
        source.replace(
          'keywords = ["CAAH30_GITLEAKS_CANARY_"]',
          'keywords = ["CAAH30_GITLEAKS_CANARY_"]\nentropy = 0',
        ),
    ],
    [
      "a singular global allowlist",
      (source: string) => `${source}\n[allowlist]\npaths = ['''.*''']\n`,
    ],
    [
      "a nested plural rule allowlist",
      (source: string) =>
        source.replace(
          "[[allowlists]]",
          "[[rules.allowlists]]\nregexes = ['''.*''']\n\n[[allowlists]]",
        ),
    ],
  ])("rejects unsupported customization: %s", async (_name, mutate) => {
    const configSource = await readFile(path.join(root, ".gitleaks.toml"), "utf8");

    expect(() => assertGitleaksPolicy(mutate(configSource))).toThrow(/Gitleaks policy/i);
  });
});

describe("Gitleaks canary report", () => {
  const expectedPath = path.join(root, "copied-canary", "leak.txt");
  const finding = (ruleId = CANARY_RULE_ID, file = expectedPath) => ({
    RuleID: ruleId,
    File: file,
  });

  it("requires exactly the expected canary rule and copied path", () => {
    expect(assertGitleaksCanaryReport(JSON.stringify([finding()]), [expectedPath])).toMatchObject([
      finding(),
    ]);
  });

  it("rejects a different rule at the copied canary path", () => {
    expect(() =>
      assertGitleaksCanaryReport(JSON.stringify([finding("generic-api-key")]), [expectedPath]),
    ).toThrow(/rule/i);
  });

  it("rejects the canary rule at a different path", () => {
    expect(() =>
      assertGitleaksCanaryReport(
        JSON.stringify([finding(CANARY_RULE_ID, path.join(root, "other", "leak.txt"))]),
        [expectedPath],
      ),
    ).toThrow(/path/i);
  });

  it("rejects unexpected additional findings", () => {
    expect(() =>
      assertGitleaksCanaryReport(
        JSON.stringify([finding(), finding("generic-api-key", path.join(root, "other.txt"))]),
        [expectedPath],
      ),
    ).toThrow(/finding/i);
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
