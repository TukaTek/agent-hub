import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { assertGitleaksCanaryReport } from "../../../scripts/gitleaks-canary.mjs";
import {
  assertCandidateCheckoutPolicy,
  assertDependabotPolicy,
  assertGitleaksPolicy,
  assertPinnedWorkflowSource,
  assertProtectedCodeowners,
  assertRepositoryPolicy,
  assertSourceTreeManifestCodeowner,
  CANARY_RULE_ID,
  effectiveCodeowners,
  GITLEAKS_CANARY_PATH,
  parseCodeowners,
  parseGitTrackedEntries,
} from "../../../scripts/repository-policy.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const sha = "0123456789abcdef0123456789abcdef01234567";
const githubExpression = (expression: string) => ["$", `{{ ${expression} }}`].join("");
const exactCandidateRef = githubExpression("github.event.pull_request.head.sha || github.sha");
const imageCandidateSha = githubExpression(
  "github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha",
);
const imageCandidateRef = githubExpression("env.CANDIDATE_SHA");
const absentBuildContext = Symbol("absent build context");
const desktopSandboxBoundary = [
  "apps/api/src/app.ts",
  "apps/api/src/env.test.ts",
  "apps/api/src/env.ts",
  "apps/api/src/router.test.ts",
  "apps/api/src/router.ts",
  "apps/worker/src/index.ts",
  "packages/adapters/src/computer-support.test.ts",
  "packages/adapters/src/computer-support.ts",
  "packages/adapters/src/desktop-sandbox-paths.test.ts",
  "packages/adapters/src/desktop-sandbox-paths.ts",
  "packages/adapters/src/desktop-sandbox-win32-path.ts",
  "packages/adapters/src/desktop-sandbox-write-containment.test.ts",
  "packages/adapters/src/desktop-sandbox.ts",
  "packages/adapters/src/host-aware-sandbox.test.ts",
  "packages/adapters/src/host-aware-sandbox.ts",
  "packages/adapters/src/sandbox-conformance.test.ts",
  "packages/adapters/src/sandbox-factory.test.ts",
  "packages/adapters/src/sandbox-factory.ts",
  "packages/adapters/src/sandbox-faults.test.ts",
  "packages/adapters/src/sandbox-provider-env.test.ts",
  "packages/adapters/src/sandbox-provider-env.ts",
  "packages/contracts/src/domain.ts",
  "packages/contracts/src/rpc.ts",
  "packages/db/src/repos.test.ts",
  "packages/db/src/repos.ts",
  "packages/testkit/src/journeys.test.ts",
];

type ImageCandidatePolicy = (
  source: string,
  filename: string,
  requirements: { candidateJobs: string[] },
) => void;

async function imageCandidatePolicy(): Promise<ImageCandidatePolicy | undefined> {
  const policy = (await import("../../../scripts/repository-policy.mjs")) as unknown as {
    assertImageCandidatePolicy?: ImageCandidatePolicy;
  };
  expect(policy.assertImageCandidatePolicy).toBeTypeOf("function");
  return policy.assertImageCandidatePolicy;
}

function mutateRequired(source: string, expected: string, replacement: string) {
  const mutated = source.replace(expected, replacement);
  expect(mutated, `mutation target ${expected}`).not.toBe(source);
  return mutated;
}

function mutateImageBuildContext(
  source: string,
  jobName: string,
  context: unknown | typeof absentBuildContext,
) {
  const workflow = parseYaml(source) as {
    jobs?: Record<string, { steps?: Array<{ uses?: unknown; with?: Record<string, unknown> }> }>;
  };
  const build = workflow.jobs?.[jobName]?.steps?.find((step) =>
    String(step.uses ?? "").startsWith("docker/build-push-action@"),
  );
  expect(build, `${jobName}: Docker build step`).toBeDefined();
  expect(build?.with, `${jobName}: Docker build inputs`).toBeDefined();

  if (context === absentBuildContext) {
    delete build?.with?.context;
  } else if (build?.with) {
    build.with.context = context;
  }
  return stringifyYaml(workflow);
}

let repositoryFixtureParent: string;
let repositoryFixtureRoot: string;

function runGit(repository: string, ...arguments_: string[]) {
  return execFileSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function stageFixture() {
  runGit(repositoryFixtureRoot, "add", "-A");
}

async function prepareRepositoryFixture() {
  repositoryFixtureParent = await mkdtemp(path.join(tmpdir(), "rakazo-repository-policy-"));
  repositoryFixtureRoot = path.join(repositoryFixtureParent, "repository");
  const trackedOutput = execFileSync("git", ["-C", root, "ls-files", "-z"]);
  const trackedFiles = new Set(trackedOutput.toString("utf8").split("\0").filter(Boolean));
  const trackedDirectories = new Set<string>();
  for (const filename of trackedFiles) {
    let directory = path.posix.dirname(filename);
    while (directory !== ".") {
      trackedDirectories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  await cp(root, repositoryFixtureRoot, {
    filter: (source) => {
      const relative = path.relative(root, source).split(path.sep).join("/");
      return relative === "" || trackedFiles.has(relative) || trackedDirectories.has(relative);
    },
    recursive: true,
  });
  runGit(repositoryFixtureRoot, "init", "--quiet");
  runGit(repositoryFixtureRoot, "config", "user.email", "policy-tests@example.invalid");
  runGit(repositoryFixtureRoot, "config", "user.name", "Repository Policy Tests");
  stageFixture();
  runGit(repositoryFixtureRoot, "commit", "--quiet", "-m", "test fixture");
}

async function withWorkflowSources(
  workflows: Record<string, string>,
  assertion: () => Promise<void>,
) {
  const originals = new Map<string, string | undefined>();
  try {
    const manifest = path.join(repositoryFixtureRoot, ".github/ci-executable-surface.json");
    originals.set(manifest, await readFile(manifest, "utf8").catch(() => undefined));
    for (const [filename, source] of Object.entries(workflows)) {
      const target = path.join(repositoryFixtureRoot, ".github/workflows", filename);
      originals.set(target, await readFile(target, "utf8").catch(() => undefined));
      await writeFile(target, source);
    }
    await assertion();
  } finally {
    for (const [target, original] of originals) {
      if (original === undefined) await rm(target, { force: true });
      else await writeFile(target, original);
    }
    stageFixture();
  }
}

async function regenerateSourceTreeManifest() {
  stageFixture();
  const policy = (await import("../../../scripts/repository-policy.mjs")) as unknown as {
    writeSourceTreeManifest?: (root: string) => Promise<void>;
  };
  await policy.writeSourceTreeManifest?.(repositoryFixtureRoot);
}

function actionBuildWorkflow(context?: unknown) {
  const workflow = {
    name: "unmanifested-image",
    on: "workflow_dispatch",
    jobs: {
      image: {
        "runs-on": "ubuntu-latest",
        steps: [
          {
            uses: `docker/build-push-action@${sha}`,
            ...(context === undefined ? {} : { with: { context } }),
          },
        ],
      },
    },
  };
  return stringifyYaml(workflow);
}

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
    ["an absolute path", "/.github/workflows/playwright.yml"],
    ["traversal", "./.github/workflows/../playwright.yml"],
    ["an expression", githubExpression("inputs.action")],
  ])("rejects step-level %s", (_name, action) => {
    const workflow = `jobs: { test: { runs-on: ubuntu-latest, steps: [{ uses: ${JSON.stringify(action)} }] } }`;

    expect(() => assertPinnedWorkflowSource(workflow, "untrusted-step.yml")).toThrow();
  });

  it.each(["./.github/actions/bridge", `./.github/actions/${sha}`])(
    "accepts canonical local action %s for manifest resolution",
    (action) => {
      const workflow = `jobs: { test: { runs-on: ubuntu-latest, steps: [{ uses: ${JSON.stringify(action)} }] } }`;

      expect(() => assertPinnedWorkflowSource(workflow, "local-action.yml")).not.toThrow();
    },
  );

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

  it("uses one exact candidate SHA for image checkout, tags, OCI revision, and GIT_SHA", async () => {
    const workflow = parseYaml(
      await readFile(path.join(root, ".github/workflows/publish-server-image.yml"), "utf8"),
    );

    expect(workflow.env.CANDIDATE_SHA).toBe(imageCandidateSha);
    for (const jobName of ["validate", "publish"]) {
      const steps = workflow.jobs[jobName].steps as Record<string, unknown>[];
      const checkout = steps.find((step) =>
        String(step.uses ?? "").startsWith("actions/checkout@"),
      );
      const verification = steps.find((step) => step.name === "Verify exact candidate provenance");
      const metadata = steps.find((step) =>
        String(step.uses ?? "").startsWith("docker/metadata-action@"),
      );
      const build = steps.find((step) =>
        String(step.uses ?? "").startsWith("docker/build-push-action@"),
      );

      expect(checkout?.with?.ref, `${jobName}:checkout`).toBe(imageCandidateRef);
      expect(verification?.env, `${jobName}:verification`).toEqual({
        PR_HEAD_SHA: githubExpression("github.event.pull_request.head.sha"),
      });
      expect(String(verification?.run ?? ""), `${jobName}:verification`).toContain(
        'test "$checkout_sha" = "$CANDIDATE_SHA"',
      );
      expect(String(metadata?.with?.tags ?? ""), `${jobName}:tags`).toContain(
        `type=raw,value=sha-${imageCandidateRef}`,
      );
      expect(String(metadata?.with?.labels ?? ""), `${jobName}:labels`).toContain(
        `org.opencontainers.image.revision=${imageCandidateRef}`,
      );
      expect(build?.with?.tags, `${jobName}:build tags`).toBe(
        githubExpression("steps.meta.outputs.tags"),
      );
      expect(build?.with?.labels, `${jobName}:build labels`).toBe(
        githubExpression("steps.meta.outputs.labels"),
      );
      expect(build?.with?.context, `${jobName}:build context`).toBe(".");
      expect(build?.with?.["build-args"], `${jobName}:GIT_SHA`).toBe(
        `GIT_SHA=${imageCandidateRef}`,
      );
    }
  });

  it.each([
    [
      "pull_request",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ],
    [
      "push",
      undefined,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ],
    [
      "workflow_dispatch",
      undefined,
      "cccccccccccccccccccccccccccccccccccccccc",
      "cccccccccccccccccccccccccccccccccccccccc",
    ],
  ])(
    "selects the correct immutable image candidate for %s",
    async (eventName, pullRequestHead, eventSha, expected) => {
      const workflow = parseYaml(
        await readFile(path.join(root, ".github/workflows/publish-server-image.yml"), "utf8"),
      );
      expect(workflow.env.CANDIDATE_SHA).toBe(imageCandidateSha);

      const resolved = eventName === "pull_request" ? pullRequestHead : eventSha;
      expect(resolved).toBe(expected);
    },
  );

  it("enforces image candidate checkout and provenance in the repository policy", async () => {
    const source = await readFile(
      path.join(root, ".github/workflows/publish-server-image.yml"),
      "utf8",
    );
    const assertImageCandidatePolicy = await imageCandidatePolicy();
    if (!assertImageCandidatePolicy) return;

    expect(() =>
      assertImageCandidatePolicy(source, ".github/workflows/publish-server-image.yml", {
        candidateJobs: ["validate", "publish"],
      }),
    ).not.toThrow();
  });

  it.each(
    ["validate", "publish"].flatMap((jobName) =>
      [
        ["an absent context", absentBuildContext],
        ["a remote URL/ref context", "https://github.com/TukaTek/agent-hub.git#main"],
        ["the explicit default Git context", "{{defaultContext}}"],
        ["a dynamic expression context", githubExpression("inputs.build_context")],
        ["a direct github.sha context", githubExpression("github.sha")],
        [
          "a pull-request synthetic merge context",
          "https://github.com/TukaTek/agent-hub.git#refs/pull/1/merge",
        ],
        ["a YAML null context", null],
        ["a YAML boolean context", true],
        ["a YAML numeric context", 0],
        ["a YAML mapping context", { path: "." }],
      ].map(([name, context]) => [jobName, name, context] as const),
    ),
  )("rejects %s image builds with %s", async (jobName, _name, context) => {
    const source = await readFile(
      path.join(root, ".github/workflows/publish-server-image.yml"),
      "utf8",
    );
    const assertImageCandidatePolicy = await imageCandidatePolicy();
    if (!assertImageCandidatePolicy) return;
    const mutated = mutateImageBuildContext(source, jobName, context);

    expect(() =>
      assertImageCandidatePolicy(mutated, ".github/workflows/publish-server-image.yml", {
        candidateJobs: ["validate", "publish"],
      }),
    ).toThrow(/build context|checked-out context|context.*exact/i);
  });

  it.each([
    [
      "a missing central candidate",
      `  CANDIDATE_SHA: ${imageCandidateSha}\n`,
      "",
      /candidate SHA/i,
    ],
    [
      "a dynamic candidate",
      imageCandidateSha,
      githubExpression("inputs.candidate_sha"),
      /candidate SHA/i,
    ],
    [
      "an event SHA-only candidate",
      imageCandidateSha,
      githubExpression("github.sha"),
      /candidate SHA/i,
    ],
    [
      "a missing checkout ref",
      `          ref: ${imageCandidateRef}\n`,
      "",
      /checkout|exact candidate/i,
    ],
    [
      "a synthetic merge checkout",
      imageCandidateRef,
      "refs/pull/1/merge",
      /synthetic|exact candidate/i,
    ],
    [
      "a direct event SHA checkout",
      imageCandidateRef,
      githubExpression("github.sha"),
      /checkout|exact candidate/i,
    ],
    [
      "a direct PR head checkout that bypasses the shared candidate",
      imageCandidateRef,
      githubExpression("github.event.pull_request.head.sha"),
      /checkout|exact candidate/i,
    ],
    [
      "a drifting image tag",
      `type=raw,value=sha-${imageCandidateRef}`,
      `type=raw,value=sha-${githubExpression("github.sha")}`,
      /tag|candidate/i,
    ],
    [
      "a drifting OCI revision",
      `org.opencontainers.image.revision=${imageCandidateRef}`,
      `org.opencontainers.image.revision=${githubExpression("github.sha")}`,
      /revision|label|candidate/i,
    ],
    [
      "a drifting GIT_SHA",
      `GIT_SHA=${imageCandidateRef}`,
      `GIT_SHA=${githubExpression("github.sha")}`,
      /GIT_SHA|build argument|candidate/i,
    ],
    [
      "a drifting build tag input",
      `tags: ${githubExpression("steps.meta.outputs.tags")}`,
      `tags: sha-${githubExpression("github.sha")}`,
      /tag|metadata/i,
    ],
    [
      "a drifting build label input",
      `labels: ${githubExpression("steps.meta.outputs.labels")}`,
      `labels: org.opencontainers.image.revision=${githubExpression("github.sha")}`,
      /label|metadata/i,
    ],
    [
      "a removed checkout verification",
      "      - name: Verify exact candidate provenance",
      "      - name: Unverified candidate provenance",
      /verification|candidate/i,
    ],
  ])("rejects image validation with %s", async (_name, expected, replacement, error) => {
    const source = await readFile(
      path.join(root, ".github/workflows/publish-server-image.yml"),
      "utf8",
    );
    const assertImageCandidatePolicy = await imageCandidatePolicy();
    if (!assertImageCandidatePolicy) return;
    const mutated = mutateRequired(source, expected, replacement);

    expect(() =>
      assertImageCandidatePolicy(mutated, ".github/workflows/publish-server-image.yml", {
        candidateJobs: ["validate", "publish"],
      }),
    ).toThrow(error);
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

type SourceTreeEntry = {
  path: string;
  gitMode: "100644" | "100755";
  gitType: "blob";
  byteLength: number;
  sha256: string;
};

type SourceTreeManifest = {
  schemaVersion: number;
  exclusions: string[];
  entryCount: number;
  treeSha256: string;
  entries: SourceTreeEntry[];
};

type ManifestWriterFileSystem = {
  lstat: typeof lstat;
  open: typeof open;
  rename: typeof rename;
  unlink: typeof unlink;
};

type ManifestWriterOptions = {
  fileSystem?: ManifestWriterFileSystem;
  nonceFactory?: () => string;
  platform?: NodeJS.Platform;
};

type ManifestFailureStage = "create" | "write" | "sync" | "close" | "rename";

const manifestBasename = "ci-executable-surface.json";
const manifestRelativePath = `.github/${manifestBasename}`;
const manifestTempPrefix = `.${manifestBasename}.${process.pid}.`;

function manifestTempPath(repository: string, nonce: string) {
  return path.join(repository, ".github", `${manifestTempPrefix}${nonce}.tmp`);
}

async function manifestTempEntries(repository: string) {
  return (await readdir(path.join(repository, ".github"))).filter(
    (entry) => entry.startsWith(manifestTempPrefix) && entry.endsWith(".tmp"),
  );
}

function sha256(content: Uint8Array) {
  return createHash("sha256").update(content).digest("hex");
}

function injectedManifestFileSystem(stage: ManifestFailureStage) {
  let partialBytesWritten = 0;
  let tempCloseFailed = false;
  const fileSystem: ManifestWriterFileSystem = {
    lstat,
    open: (async (...arguments_: Parameters<typeof open>) => {
      const filename = String(arguments_[0]);
      const isTemp = path.basename(filename).startsWith(manifestTempPrefix);
      if (isTemp && stage === "create") {
        throw new Error("injected create failure");
      }
      const handle = await open(...arguments_);
      if (!isTemp) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "write" && stage === "write") {
            return async (buffer: Uint8Array, offset: number, length: number, position: number) => {
              if (partialBytesWritten === 0) {
                const partialLength = Math.min(1024, length);
                const result = await target.write(buffer, offset, partialLength, position);
                partialBytesWritten = result.bytesWritten;
                return result;
              }
              throw new Error("injected write failure after partial write");
            };
          }
          if (property === "sync" && stage === "sync") {
            return async () => {
              throw new Error("injected sync failure");
            };
          }
          if (property === "close" && stage === "close" && !tempCloseFailed) {
            return async () => {
              tempCloseFailed = true;
              await target.close();
              throw new Error("injected close failure");
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Awaited<ReturnType<typeof open>>;
    }) as typeof open,
    rename: async (oldPath, newPath) => {
      if (stage === "rename") throw new Error("injected rename failure");
      await rename(oldPath, newPath);
    },
    unlink,
  };
  return {
    fileSystem,
    partialBytesWritten: () => partialBytesWritten,
  };
}

async function sourceTreePolicy() {
  const policy = (await import("../../../scripts/repository-policy.mjs")) as unknown as {
    assertSourceTreeManifest: (root: string) => Promise<SourceTreeManifest>;
    createSourceTreeManifest: (root: string) => Promise<SourceTreeManifest>;
    serializeSourceTreeManifest: (manifest: SourceTreeManifest) => string;
    writeSourceTreeManifest: (
      root: string,
      options?: ManifestWriterOptions,
    ) => Promise<SourceTreeManifest>;
  };
  expect(policy.assertSourceTreeManifest).toBeTypeOf("function");
  expect(policy.createSourceTreeManifest).toBeTypeOf("function");
  expect(policy.writeSourceTreeManifest).toBeTypeOf("function");
  return policy;
}

async function writeRepositoryFiles(
  repository: string,
  files: Record<string, string | Uint8Array>,
) {
  for (const [filename, content] of Object.entries(files)) {
    const target = path.join(repository, filename);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function withGitRepository(
  files: Record<string, string | Uint8Array>,
  assertion: (repository: string) => Promise<void>,
) {
  const parent = await mkdtemp(path.join(tmpdir(), "rakazo-source-tree-policy-"));
  const repository = path.join(parent, "repository");
  await mkdir(path.join(repository, ".github"), { recursive: true });
  runGit(repository, "init", "--quiet");
  runGit(repository, "config", "user.email", "policy-tests@example.invalid");
  runGit(repository, "config", "user.name", "Repository Policy Tests");
  await writeRepositoryFiles(repository, files);
  runGit(repository, "add", "-A");
  runGit(repository, "commit", "--quiet", "-m", "fixture");
  try {
    await assertion(repository);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
}

async function writeAndTrackSourceTreeManifest(repository: string) {
  const policy = await sourceTreePolicy();
  const manifest = await policy.writeSourceTreeManifest(repository);
  runGit(repository, "add", ".github/ci-executable-surface.json");
  return manifest;
}

function gitIndexRecord(mode: string, repositoryPath: string, stage = "0") {
  return Buffer.concat([
    Buffer.from(`${mode} ${"0".repeat(40)} ${stage}\t`, "utf8"),
    Buffer.from(repositoryPath, "utf8"),
    Buffer.from([0]),
  ]);
}

function gitIndexRecords(...records: Array<[string, string, string?]>) {
  return Buffer.concat(
    records.map(([mode, repositoryPath, stage]) => gitIndexRecord(mode, repositoryPath, stage)),
  );
}

beforeAll(prepareRepositoryFixture);

afterAll(async () => {
  await rm(repositoryFixtureParent, { force: true, recursive: true });
});

describe("content-addressed source tree policy", () => {
  it("accepts the checked-in whole-tree manifest and keeps check mode read-only", async () => {
    const filename = path.join(repositoryFixtureRoot, ".github/ci-executable-surface.json");
    const before = await readFile(filename);

    await expect(assertRepositoryPolicy(repositoryFixtureRoot)).resolves.toMatchObject({
      workflowCount: 6,
      sourceTreeEntryCount: expect.any(Number),
      sourceTreeSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    await expect(readFile(filename)).resolves.toEqual(before);
  });

  it("binds every tracked regular file in deterministic UTF-8 path order and excludes only itself", async () => {
    const files = {
      ".github/not-the-manifest.json": "{}\n",
      "arbitrary/deep/data.bin": new Uint8Array([0, 1, 2, 255]),
      "café/日本語.txt": "non-ASCII\n",
      "empty-file": new Uint8Array(),
      "generated/tracked.out": "tracked generated bytes\n",
      "line-endings/crlf.txt": new Uint8Array([0x61, 0x0d, 0x0a, 0x62, 0x0d, 0x0a]),
      "src/application.ts": "export const application = true;\n",
    };

    await withGitRepository(files, async (repository) => {
      const policy = await sourceTreePolicy();
      await writeAndTrackSourceTreeManifest(repository);
      const manifest = await policy.createSourceTreeManifest(repository);
      const paths = manifest.entries.map((entry) => entry.path);
      const expectedPaths = Object.keys(files).sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      );

      expect(manifest).toMatchObject({
        schemaVersion: 2,
        exclusions: [".github/ci-executable-surface.json"],
        entryCount: expectedPaths.length,
        treeSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
      expect(paths).toEqual(expectedPaths);
      expect(paths).not.toContain(".github/ci-executable-surface.json");
      expect(paths).toContain(".github/not-the-manifest.json");
      expect(manifest.entries.find((entry) => entry.path === "empty-file")).toMatchObject({
        byteLength: 0,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      });
      expect(
        manifest.entries.find((entry) => entry.path === "arbitrary/deep/data.bin"),
      ).toMatchObject({
        byteLength: 4,
        gitMode: "100644",
        gitType: "blob",
      });
      for (const entry of manifest.entries) {
        expect(Object.keys(entry).sort()).toEqual(
          ["byteLength", "gitMode", "gitType", "path", "sha256"].sort(),
        );
      }
    });
  });

  it.each([
    [
      "tracked content in application source",
      async (repository: string) => {
        await writeFile(
          path.join(repository, "src/application.ts"),
          "export const changed = true;\n",
        );
      },
      /tracked content drift.*src\/application\.ts/iu,
    ],
    [
      "a tracked file added in an arbitrary directory",
      async (repository: string) => {
        await writeRepositoryFiles(repository, { "arbitrary/new/file.txt": "new\n" });
        runGit(repository, "add", "arbitrary/new/file.txt");
      },
      /tracked file added.*arbitrary\/new\/file\.txt/iu,
    ],
    [
      "a tracked file removed",
      async (repository: string) => {
        await rm(path.join(repository, "src/application.ts"));
        runGit(repository, "add", "-A");
      },
      /tracked file removed.*src\/application\.ts/iu,
    ],
    [
      "a tracked file renamed",
      async (repository: string) => {
        await mkdir(path.join(repository, "arbitrary"), { recursive: true });
        runGit(repository, "mv", "src/application.ts", "arbitrary/renamed.ts");
      },
      /tracked file added|tracked file removed|renamed/iu,
    ],
  ])("rejects %s anywhere in the repository", async (_name, mutate, expectedError) => {
    await withGitRepository(
      { "src/application.ts": "export const application = true;\n" },
      async (repository) => {
        const policy = await sourceTreePolicy();
        await writeAndTrackSourceTreeManifest(repository);
        await mutate(repository);
        await expect(policy.assertSourceTreeManifest(repository)).rejects.toThrow(expectedError);
      },
    );
  });

  it.skipIf(process.platform === "win32")(
    "rejects both checkout mode drift and a staged tracked mode change",
    async () => {
      await withGitRepository({ "scripts/tool": "exit 0\n" }, async (repository) => {
        const policy = await sourceTreePolicy();
        await writeAndTrackSourceTreeManifest(repository);

        await chmod(path.join(repository, "scripts/tool"), 0o755);
        await expect(policy.createSourceTreeManifest(repository)).rejects.toThrow(
          /mode drift.*scripts\/tool/iu,
        );

        runGit(repository, "add", "scripts/tool");
        await expect(policy.assertSourceTreeManifest(repository)).rejects.toThrow(
          /Git mode drift.*scripts\/tool/iu,
        );
      });
    },
  );

  it("fails closed when a tracked file is missing from the checkout", async () => {
    await withGitRepository({ "tracked/missing.txt": "present\n" }, async (repository) => {
      const policy = await sourceTreePolicy();
      await writeAndTrackSourceTreeManifest(repository);
      await rm(path.join(repository, "tracked/missing.txt"));

      await expect(policy.createSourceTreeManifest(repository)).rejects.toThrow(
        /tracked file is missing.*tracked\/missing\.txt/iu,
      );
    });
  });

  it.each([
    ["env -u", ".github/workflows/ci.yml", "run: env -u CI ./scripts/wrapper\n"],
    ["parenthesized invocation", ".github/workflows/ci.yml", "run: (./scripts/wrapper)\n"],
    ["xargs", ".github/workflows/ci.yml", "run: printf input | xargs ./scripts/wrapper\n"],
    [
      "nested interpreted no-shebang wrapper",
      "scripts/inner-wrapper",
      "sh ./scripts/deeper-wrapper\n",
    ],
    [
      "direct extensionless wrapper",
      "scripts/direct-wrapper",
      "buildctl build --frontend dockerfile.v0\n",
    ],
    [
      "buildctl invocation",
      ".github/workflows/ci.yml",
      "run: buildctl-daemonless.sh build --frontend dockerfile.v0\n",
    ],
    ["script indirection", "scripts/indirect.sh", "env -u CI ./scripts/deeper-wrapper\n"],
  ])(
    "catches the prior %s bypass solely as whole-tree content drift",
    async (_name, target, changed) => {
      await withGitRepository(
        { [target]: "intentionally reviewed bytes\n" },
        async (repository) => {
          const policy = await sourceTreePolicy();
          await writeAndTrackSourceTreeManifest(repository);
          await writeFile(path.join(repository, target), changed);

          await expect(policy.assertSourceTreeManifest(repository)).rejects.toThrow(
            /tracked content drift/iu,
          );
        },
      );
    },
  );

  it("accepts inert heredoc, comment, and echo text once intentionally manifested", async () => {
    const inert = `# ./scripts/comment-only
echo "./scripts/echo-only"
cat <<'PAYLOAD'
./scripts/heredoc-only
buildctl-daemonless.sh build
PAYLOAD
`;
    await withGitRepository({ ".github/workflows/inert.txt": inert }, async (repository) => {
      const policy = await sourceTreePolicy();
      await writeAndTrackSourceTreeManifest(repository);

      await expect(policy.assertSourceTreeManifest(repository)).resolves.toBeDefined();
    });
  });

  it.each([
    [
      "a duplicate root key",
      (source: string) =>
        mutateRequired(
          source,
          '{\n  "schemaVersion": 2,',
          '{\n  "schemaVersion": 999,\n  "schemaVersion": 2,',
        ),
    ],
    [
      "a duplicate nested entry key",
      (source: string) =>
        mutateRequired(source, '{\n      "path":', '{\n      "path": "ignored",\n      "path":'),
    ],
    [
      "an escaped-equivalent key",
      (source: string) =>
        mutateRequired(
          source,
          '{\n  "schemaVersion": 2,',
          '{\n  "schema\\u0056ersion": 999,\n  "schemaVersion": 2,',
        ),
    ],
    ["malformed JSON", (source: string) => source.slice(0, -2)],
    ["trailing content", (source: string) => `${source}true\n`],
  ])("rejects %s in check and regeneration without rewriting", async (_name, mutate) => {
    await withGitRepository({ "tracked.txt": "tracked\n" }, async (repository) => {
      const policy = await sourceTreePolicy();
      await writeAndTrackSourceTreeManifest(repository);
      const filename = path.join(repository, ".github/ci-executable-surface.json");
      const malformed = mutate(await readFile(filename, "utf8"));
      await writeFile(filename, malformed);

      await expect(policy.assertSourceTreeManifest(repository)).rejects.toThrow(
        /duplicate|invalid|JSON|unexpected|source-tree manifest/iu,
      );
      await expect(policy.writeSourceTreeManifest(repository)).rejects.toThrow(
        /refusing to regenerate.*invalid source-tree manifest/iu,
      );
      await expect(readFile(filename, "utf8")).resolves.toBe(malformed);
    });
  });

  it("allows explicit regeneration of a valid stale manifest", async () => {
    await withGitRepository({ "tracked.txt": "before\n" }, async (repository) => {
      const policy = await sourceTreePolicy();
      await writeAndTrackSourceTreeManifest(repository);
      await writeFile(path.join(repository, "tracked.txt"), "after\n");

      await expect(policy.assertSourceTreeManifest(repository)).rejects.toThrow(
        /tracked content drift/iu,
      );
      await expect(policy.writeSourceTreeManifest(repository)).resolves.toBeDefined();
      await expect(policy.assertSourceTreeManifest(repository)).resolves.toBeDefined();
    });
  });

  it("bootstraps a missing manifest and produces byte-identical repeated regeneration", async () => {
    await withGitRepository({ "tracked.txt": "tracked\n" }, async (repository) => {
      const policy = await sourceTreePolicy();
      const filename = path.join(repository, ".github/ci-executable-surface.json");

      await expect(policy.writeSourceTreeManifest(repository)).resolves.toBeDefined();
      runGit(repository, "add", ".github/ci-executable-surface.json");
      const first = await readFile(filename);
      await policy.writeSourceTreeManifest(repository);
      const second = await readFile(filename);
      await policy.writeSourceTreeManifest(repository);
      const third = await readFile(filename);

      expect(second).toEqual(first);
      expect(third).toEqual(first);
    });
  });

  it.each(["create", "write", "sync", "close", "rename"] as const)(
    "preserves the previous manifest and cleans its temp file after an injected %s failure",
    async (stage) => {
      const files = Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [`tracked-${index}.txt`, "before\n"]),
      );
      await withGitRepository(files, async (repository) => {
        const policy = await sourceTreePolicy();
        await writeAndTrackSourceTreeManifest(repository);
        const filename = path.join(repository, manifestRelativePath);
        const before = await readFile(filename);
        const beforeHash = sha256(before);
        await writeFile(path.join(repository, "tracked-0.txt"), "after\n");
        const injection = injectedManifestFileSystem(stage);

        await expect(
          policy.writeSourceTreeManifest(repository, {
            fileSystem: injection.fileSystem,
            nonceFactory: () => "0".repeat(32),
            platform: "linux",
          }),
        ).rejects.toThrow(new RegExp(`injected ${stage} failure`, "iu"));

        const after = await readFile(filename);
        expect(after).toEqual(before);
        expect(sha256(after)).toBe(beforeHash);
        expect(await manifestTempEntries(repository)).toEqual([]);
        if (stage === "write") expect(injection.partialBytesWritten()).toBe(1024);
      });
    },
  );

  it("creates its temp file exclusively with mode 0600 and O_NOFOLLOW", async () => {
    await withGitRepository({ "tracked.txt": "tracked\n" }, async (repository) => {
      const policy = await sourceTreePolicy();
      const opened: Array<{ filename: string; flags: number; mode?: number }> = [];
      const fileSystem: ManifestWriterFileSystem = {
        lstat,
        open: (async (...arguments_: Parameters<typeof open>) => {
          const [filename, flags, mode] = arguments_;
          if (path.basename(String(filename)).startsWith(manifestTempPrefix)) {
            opened.push({ filename: String(filename), flags: Number(flags), mode });
          }
          return open(...arguments_);
        }) as typeof open,
        rename,
        unlink,
      };

      await policy.writeSourceTreeManifest(repository, {
        fileSystem,
        nonceFactory: () => "1".repeat(32),
        platform: "linux",
      });

      expect(opened).toHaveLength(1);
      expect(opened[0]?.mode).toBe(0o600);
      expect(opened[0]!.flags & constants.O_CREAT).toBe(constants.O_CREAT);
      expect(opened[0]!.flags & constants.O_EXCL).toBe(constants.O_EXCL);
      if (constants.O_NOFOLLOW !== undefined) {
        expect(opened[0]!.flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      }
      expect(await manifestTempEntries(repository)).toEqual([]);
    });
  });

  it("leaves a pre-existing colliding temp path untouched and retries with a new nonce", async () => {
    await withGitRepository({ "tracked.txt": "tracked\n" }, async (repository) => {
      const policy = await sourceTreePolicy();
      const collisionNonce = "2".repeat(32);
      const replacementNonce = "3".repeat(32);
      const collision = manifestTempPath(repository, collisionNonce);
      const collisionBytes = Buffer.from("pre-existing collision\n");
      await writeFile(collision, collisionBytes);
      const nonces = [collisionNonce, replacementNonce];

      await policy.writeSourceTreeManifest(repository, {
        nonceFactory: () => nonces.shift() ?? replacementNonce,
        platform: "linux",
      });

      expect(await readFile(collision)).toEqual(collisionBytes);
      expect(await manifestTempEntries(repository)).toEqual([path.basename(collision)]);
      runGit(repository, "add", manifestRelativePath);
      await expect(policy.assertSourceTreeManifest(repository)).resolves.toBeDefined();
    });
  });

  it.skipIf(process.platform === "win32")(
    "does not follow a pre-existing colliding temp symlink",
    async () => {
      await withGitRepository({ "tracked.txt": "tracked\n" }, async (repository) => {
        const policy = await sourceTreePolicy();
        const collisionNonce = "4".repeat(32);
        const replacementNonce = "5".repeat(32);
        const collision = manifestTempPath(repository, collisionNonce);
        const linkTarget = path.join(repository, "collision-target.txt");
        await writeFile(linkTarget, "do not overwrite\n");
        await symlink(linkTarget, collision);
        const nonces = [collisionNonce, replacementNonce];

        await policy.writeSourceTreeManifest(repository, {
          nonceFactory: () => nonces.shift() ?? replacementNonce,
          platform: "linux",
        });

        expect((await lstat(collision)).isSymbolicLink()).toBe(true);
        await expect(readFile(linkTarget, "utf8")).resolves.toBe("do not overwrite\n");
        runGit(repository, "add", manifestRelativePath);
        await expect(policy.assertSourceTreeManifest(repository)).resolves.toBeDefined();
      });
    },
  );

  it.each(["symlink", "directory"] as const)(
    "does not rename or unlink a temp path replaced with a %s after creation",
    async (replacementKind) => {
      if (replacementKind === "symlink" && process.platform === "win32") return;
      await withGitRepository({ "tracked.txt": "before\n" }, async (repository) => {
        const policy = await sourceTreePolicy();
        await writeAndTrackSourceTreeManifest(repository);
        const filename = path.join(repository, manifestRelativePath);
        const before = await readFile(filename);
        const nonce = "a".repeat(32);
        const temporaryFilename = manifestTempPath(repository, nonce);
        const displacedTemp = `${temporaryFilename}.displaced`;
        const symlinkTarget = path.join(repository, "attacker-target.txt");
        await writeFile(symlinkTarget, "do not overwrite or unlink\n");
        await writeFile(path.join(repository, "tracked.txt"), "after\n");
        let replaced = false;
        const fileSystem: ManifestWriterFileSystem = {
          lstat: (async (...arguments_: Parameters<typeof lstat>) => {
            const [candidate] = arguments_;
            if (!replaced && path.resolve(String(candidate)) === temporaryFilename) {
              replaced = true;
              await rename(temporaryFilename, displacedTemp);
              if (replacementKind === "symlink") await symlink(symlinkTarget, temporaryFilename);
              else await mkdir(temporaryFilename);
            }
            return lstat(...arguments_);
          }) as typeof lstat,
          open,
          rename,
          unlink,
        };

        await expect(
          policy.writeSourceTreeManifest(repository, {
            fileSystem,
            nonceFactory: () => nonce,
            platform: "linux",
          }),
        ).rejects.toThrow(/temp path changed.*cleanup also failed/iu);

        expect(await readFile(filename)).toEqual(before);
        await expect(readFile(symlinkTarget, "utf8")).resolves.toBe("do not overwrite or unlink\n");
        const replacementInfo = await lstat(temporaryFilename);
        expect(
          replacementKind === "symlink"
            ? replacementInfo.isSymbolicLink()
            : replacementInfo.isDirectory(),
        ).toBe(true);
        expect((await lstat(displacedTemp)).isFile()).toBe(true);
      });
    },
  );

  it.each(["symlink", "directory"] as const)(
    "refuses an existing manifest target that is a %s without replacing it",
    async (targetKind) => {
      if (targetKind === "symlink" && process.platform === "win32") return;
      await withGitRepository({ "tracked.txt": "tracked\n" }, async (repository) => {
        const policy = await sourceTreePolicy();
        const filename = path.join(repository, manifestRelativePath);
        if (targetKind === "symlink") {
          const target = path.join(repository, "outside-manifest.json");
          await writeFile(target, "outside\n");
          await symlink(target, filename);
        } else {
          await mkdir(filename);
        }

        await expect(policy.writeSourceTreeManifest(repository)).rejects.toThrow(/non-regular/iu);
        const info = await lstat(filename);
        expect(targetKind === "symlink" ? info.isSymbolicLink() : info.isDirectory()).toBe(true);
        expect(await manifestTempEntries(repository)).toEqual([]);
      });
    },
  );

  it.each(["symlink", "directory"] as const)(
    "rejects a manifest target that becomes a %s before rename",
    async (targetKind) => {
      if (targetKind === "symlink" && process.platform === "win32") return;
      await withGitRepository({ "tracked.txt": "before\n" }, async (repository) => {
        const policy = await sourceTreePolicy();
        await writeAndTrackSourceTreeManifest(repository);
        const filename = path.join(repository, manifestRelativePath);
        const preserved = `${filename}.preserved`;
        const before = await readFile(filename);
        await writeFile(path.join(repository, "tracked.txt"), "after\n");
        let targetLstatCalls = 0;
        const fileSystem: ManifestWriterFileSystem = {
          lstat: (async (...arguments_: Parameters<typeof lstat>) => {
            const [candidate] = arguments_;
            if (path.resolve(String(candidate)) === filename) {
              targetLstatCalls += 1;
              if (targetLstatCalls === 2) {
                await rename(filename, preserved);
                if (targetKind === "symlink") await symlink(preserved, filename);
                else await mkdir(filename);
              }
            }
            return lstat(...arguments_);
          }) as typeof lstat,
          open,
          rename,
          unlink,
        };

        await expect(
          policy.writeSourceTreeManifest(repository, {
            fileSystem,
            nonceFactory: () => "9".repeat(32),
            platform: "linux",
          }),
        ).rejects.toThrow(/non-regular/iu);

        expect(await readFile(preserved)).toEqual(before);
        const targetInfo = await lstat(filename);
        expect(
          targetKind === "symlink" ? targetInfo.isSymbolicLink() : targetInfo.isDirectory(),
        ).toBe(true);
        expect(await manifestTempEntries(repository)).toEqual([]);
      });
    },
  );

  it("allows concurrent regenerators to install identical complete bytes without temp residue", async () => {
    await withGitRepository({ "tracked.txt": "tracked\n" }, async (repository) => {
      const policy = await sourceTreePolicy();

      await Promise.all([
        policy.writeSourceTreeManifest(repository, {
          nonceFactory: () => "6".repeat(32),
          platform: "linux",
        }),
        policy.writeSourceTreeManifest(repository, {
          nonceFactory: () => "7".repeat(32),
          platform: "linux",
        }),
      ]);

      const installed = await readFile(path.join(repository, manifestRelativePath), "utf8");
      expect(policy.serializeSourceTreeManifest).toBeTypeOf("function");
      expect(installed).toBe(
        policy.serializeSourceTreeManifest(await policy.createSourceTreeManifest(repository)),
      );
      expect(await manifestTempEntries(repository)).toEqual([]);
    });
  });

  it("reports a post-rename directory-sync failure without rolling back the installed manifest", async () => {
    await withGitRepository({ "tracked.txt": "before\n" }, async (repository) => {
      const policy = await sourceTreePolicy();
      await writeAndTrackSourceTreeManifest(repository);
      const filename = path.join(repository, manifestRelativePath);
      const before = await readFile(filename);
      await writeFile(path.join(repository, "tracked.txt"), "after\n");
      const githubDirectory = path.join(repository, ".github");
      const fileSystem: ManifestWriterFileSystem = {
        lstat,
        open: (async (...arguments_: Parameters<typeof open>) => {
          const handle = await open(...arguments_);
          if (path.resolve(String(arguments_[0])) !== githubDirectory) return handle;
          return new Proxy(handle, {
            get(target, property) {
              if (property === "sync") {
                return async () => {
                  throw new Error("injected directory sync failure");
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }) as Awaited<ReturnType<typeof open>>;
        }) as typeof open,
        rename,
        unlink,
      };

      await expect(
        policy.writeSourceTreeManifest(repository, {
          fileSystem,
          nonceFactory: () => "8".repeat(32),
          platform: "linux",
        }),
      ).rejects.toThrow(/replacement completed.*directory sync.*injected/iu);

      expect(await readFile(filename)).not.toEqual(before);
      await expect(policy.assertSourceTreeManifest(repository)).resolves.toBeDefined();
      expect(await manifestTempEntries(repository)).toEqual([]);
    });
  });

  it("makes raw CLI and documented regeneration write the same canonical bytes", async () => {
    const filename = path.join(repositoryFixtureRoot, manifestRelativePath);
    const original = await readFile(filename);
    const environment = {
      ...process.env,
      npm_config_engine_strict: "false",
      PATH: `${path.join(root, "node_modules/.bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    };
    try {
      await symlink(
        path.join(root, "node_modules"),
        path.join(repositoryFixtureRoot, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
      stageFixture();
      execFileSync(
        process.execPath,
        ["scripts/repository-policy.mjs", "--write-source-tree-manifest"],
        {
          cwd: repositoryFixtureRoot,
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const raw = await readFile(filename);
      execFileSync(
        path.join(root, "node_modules/.bin/biome"),
        ["format", "--write", manifestRelativePath],
        { cwd: repositoryFixtureRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
      const canonical = await readFile(filename);

      await writeFile(filename, original);
      execFileSync("pnpm", ["policy:manifest"], {
        cwd: repositoryFixtureRoot,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const documented = await readFile(filename);
      const packageJson = JSON.parse(
        await readFile(path.join(repositoryFixtureRoot, "package.json"), "utf8"),
      );

      expect(raw).toEqual(canonical);
      expect(documented).toEqual(raw);
      expect(packageJson.scripts["policy:manifest"]).toBe(
        "node scripts/repository-policy.mjs --write-source-tree-manifest && node scripts/repository-policy.mjs --check-source-tree-manifest",
      );
    } finally {
      await rm(path.join(repositoryFixtureRoot, "node_modules"), { force: true });
      await writeFile(filename, original);
      stageFixture();
    }
  });

  it("ignores untracked node_modules and generated files", async () => {
    await withGitRepository({ "tracked.txt": "tracked\n" }, async (repository) => {
      const policy = await sourceTreePolicy();
      await writeAndTrackSourceTreeManifest(repository);
      await writeRepositoryFiles(repository, {
        "node_modules/untracked/package.json": "{}\n",
        "generated-untracked/output.bin": new Uint8Array([0, 255]),
      });

      await expect(policy.assertSourceTreeManifest(repository)).resolves.toBeDefined();
    });
  });

  it("passes in a clean Git clone", async () => {
    await withGitRepository({ "tracked.txt": "tracked\n" }, async (repository) => {
      const policy = await sourceTreePolicy();
      await writeAndTrackSourceTreeManifest(repository);
      runGit(repository, "commit", "--quiet", "-m", "add source-tree manifest");
      const clone = path.join(path.dirname(repository), "clean-clone");
      execFileSync("git", ["clone", "--quiet", repository, clone]);

      await expect(policy.assertSourceTreeManifest(clone)).resolves.toBeDefined();
    });
  });

  it("fails closed in a metadata-free archive directory", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-no-git-policy-"));
    try {
      await writeFile(path.join(parent, "tracked.txt"), "not actually tracked\n");
      const policy = await sourceTreePolicy();
      await expect(policy.createSourceTreeManifest(parent)).rejects.toThrow(
        /Git metadata is required|not a git repository/iu,
      );
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("accepts normalized non-ASCII paths and rejects duplicate, case, Unicode, and traversal collisions", () => {
    expect(parseGitTrackedEntries(gitIndexRecord("100644", "café/日本語.txt"))).toEqual([
      { path: "café/日本語.txt", gitMode: "100644", gitType: "blob" },
    ]);
    expect(() =>
      parseGitTrackedEntries(gitIndexRecords(["100644", "Case.txt"], ["100644", "case.txt"])),
    ).toThrow(/case-fold.*collision/iu);
    expect(() =>
      parseGitTrackedEntries(gitIndexRecords(["100644", "Straße.txt"], ["100644", "STRASSE.txt"])),
    ).toThrow(/case-fold.*collision/iu);
    expect(() =>
      parseGitTrackedEntries(gitIndexRecords(["100644", "café.txt"], ["100644", "cafe\u0301.txt"])),
    ).toThrow(/Unicode-normalization.*collision/iu);
    expect(() =>
      parseGitTrackedEntries(
        gitIndexRecords(["100644", "duplicate.txt"], ["100644", "duplicate.txt"]),
      ),
    ).toThrow(/duplicate tracked path/iu);
    for (const invalidPath of ["../outside", "/absolute", "dir/../escape", "dir\\windows"]) {
      expect(() => parseGitTrackedEntries(gitIndexRecord("100644", invalidPath))).toThrow(
        /normalized in-root POSIX path/iu,
      );
    }
  });

  it.each([
    ["tracked symlink", "120000", /symlink/iu],
    ["gitlink/submodule", "160000", /gitlink|submodule/iu],
    ["non-regular mode", "100664", /non-regular/iu],
  ])("rejects a %s from Git index metadata", (_name, mode, expectedError) => {
    expect(() => parseGitTrackedEntries(gitIndexRecord(mode, "unsafe-entry"))).toThrow(
      expectedError,
    );
  });

  it.skipIf(process.platform === "win32")(
    "rejects actual tracked symlinks and gitlinks",
    async () => {
      await withGitRepository({ "target.txt": "target\n" }, async (repository) => {
        const policy = await sourceTreePolicy();
        await symlink("target.txt", path.join(repository, "tracked-link"));
        runGit(repository, "add", "tracked-link");
        await expect(policy.createSourceTreeManifest(repository)).rejects.toThrow(/symlink/iu);

        runGit(repository, "reset", "--quiet", "HEAD", "--", "tracked-link");
        await rm(path.join(repository, "tracked-link"));
        const head = runGit(repository, "rev-parse", "HEAD");
        runGit(
          repository,
          "update-index",
          "--add",
          "--cacheinfo",
          `160000,${head},vendor/submodule`,
        );
        await expect(policy.createSourceTreeManifest(repository)).rejects.toThrow(
          /gitlink|submodule/iu,
        );
      });
    },
  );
});

describe("authorized image build policy", () => {
  it.each([
    ["local context", "."],
    ["remote URL/ref context", "https://github.com/TukaTek/agent-hub.git#main"],
    ["dynamic context", githubExpression("inputs.build_context")],
    ["default context", undefined],
  ])("rejects an additional workflow build-push action with %s", async (_name, context) => {
    await withWorkflowSources(
      { "unmanifested-image.yml": actionBuildWorkflow(context) },
      async () => {
        await regenerateSourceTreeManifest();
        await expect(assertRepositoryPolicy(repositoryFixtureRoot)).rejects.toThrow(
          /workflow set|image build|authorized image/i,
        );
      },
    );
  });

  it("rejects an additional build-push job in the governed workflow", async () => {
    const source = await readFile(
      path.join(root, ".github/workflows/publish-server-image.yml"),
      "utf8",
    );
    const mutated = `${source}\n  unmanifested:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: docker/build-push-action@${sha}\n        with:\n          context: .\n`;

    await withWorkflowSources({ "publish-server-image.yml": mutated }, async () => {
      await regenerateSourceTreeManifest();
      await expect(assertRepositoryPolicy(repositoryFixtureRoot)).rejects.toThrow(
        /image build|manifest|authorized/i,
      );
    });
  });

  it("rejects an additional build-push step in a governed job", async () => {
    const source = await readFile(
      path.join(root, ".github/workflows/publish-server-image.yml"),
      "utf8",
    );
    const workflow = parseYaml(source) as {
      jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
    };
    workflow.jobs.validate?.steps.push({
      uses: `docker/build-push-action@${sha}`,
      with: { context: "." },
    });

    await withWorkflowSources({ "publish-server-image.yml": stringifyYaml(workflow) }, async () => {
      await regenerateSourceTreeManifest();
      await expect(assertRepositoryPolicy(repositoryFixtureRoot)).rejects.toThrow(
        /image build|exactly one|authorized/i,
      );
    });
  });

  it.each([
    [
      "a renamed authorized job",
      (workflow: { jobs: Record<string, { steps: Array<Record<string, unknown>> }> }) => {
        workflow.jobs["validate-renamed"] = workflow.jobs.validate!;
        delete workflow.jobs.validate;
      },
    ],
    [
      "a relocated authorized build step",
      (workflow: { jobs: Record<string, { steps: Array<Record<string, unknown>> }> }) => {
        workflow.jobs.validate?.steps.unshift({ run: "echo safe" });
      },
    ],
    [
      "a differently pinned build action",
      (workflow: { jobs: Record<string, { steps: Array<Record<string, unknown>> }> }) => {
        const build = workflow.jobs.validate?.steps.find((step) =>
          String(step.uses ?? "").startsWith("docker/build-push-action@"),
        );
        expect(build).toBeDefined();
        if (build) build.uses = `docker/build-push-action@${sha}`;
      },
    ],
  ])("rejects %s outside the exact step manifest", async (_name, mutate) => {
    const source = await readFile(
      path.join(root, ".github/workflows/publish-server-image.yml"),
      "utf8",
    );
    const workflow = parseYaml(source) as {
      jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
    };
    mutate(workflow);

    await withWorkflowSources({ "publish-server-image.yml": stringifyYaml(workflow) }, async () => {
      await regenerateSourceTreeManifest();
      await expect(assertRepositoryPolicy(repositoryFixtureRoot)).rejects.toThrow(
        /image build|manifest|authorized|candidate job/i,
      );
    });
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

  it("protects the exact desktop sandbox boundary and its security regressions", async () => {
    const source = await readFile(path.join(root, ".github/CODEOWNERS"), "utf8");
    const rules = parseCodeowners(source);

    expect(() =>
      assertProtectedCodeowners(source, desktopSandboxBoundary, "@acepgh"),
    ).not.toThrow();
    for (const protectedPath of desktopSandboxBoundary) {
      expect(effectiveCodeowners(rules, protectedPath), protectedPath).toEqual(["@acepgh"]);
    }
  });

  it("keeps the desktop sandbox boundary as an exact repository-policy manifest", async () => {
    const policy = (await import("../../../scripts/repository-policy.mjs")) as unknown as {
      DESKTOP_SANDBOX_PROTECTED_PATHS?: string[];
    };

    expect(policy.DESKTOP_SANDBOX_PROTECTED_PATHS).toEqual(desktopSandboxBoundary);
  });

  it("rejects later wildcard, direct override, and duplicate rules for sandbox protection", async () => {
    const source = await readFile(path.join(root, ".github/CODEOWNERS"), "utf8");

    for (const override of [
      "* @someone-else\n",
      "/packages/adapters/src/desktop-sandbox.ts @someone-else\n",
    ]) {
      expect(() =>
        assertProtectedCodeowners(`${source}\n${override}`, desktopSandboxBoundary, "@acepgh"),
      ).toThrow(/desktop-sandbox|app\.ts|index\.ts/i);
    }
    expect(() => parseCodeowners(`${source}\n/.github/CODEOWNERS @acepgh\n`)).toThrow(/duplicate/i);

    const omitted = mutateRequired(source, "/packages/adapters/src/desktop-sandbox* @acepgh\n", "");
    expect(() => assertProtectedCodeowners(omitted, desktopSandboxBoundary, "@acepgh")).toThrow(
      /desktop-sandbox/i,
    );
  });

  it("protects future local action manifests", async () => {
    const source = await readFile(path.join(root, ".github/CODEOWNERS"), "utf8");
    const probe = ".github/actions/bridge/action.yml";

    expect(effectiveCodeowners(parseCodeowners(source), probe)).toEqual(["@acepgh"]);
    expect(() => assertProtectedCodeowners(source, [probe], "@acepgh")).not.toThrow();
  });

  it("requires the whole-tree manifest to have one exact @acepgh CODEOWNERS rule", async () => {
    const source = await readFile(path.join(root, ".github/CODEOWNERS"), "utf8");
    expect(source.match(/^\/\.github\/ci-executable-surface\.json @acepgh$/gmu)).toHaveLength(1);
    expect(() => assertSourceTreeManifestCodeowner(source)).not.toThrow();
  });

  it("rejects omission, wrong ownership, later overrides, and duplicate manifest rules", async () => {
    const source = await readFile(path.join(root, ".github/CODEOWNERS"), "utf8");
    const exactRule = "/.github/ci-executable-surface.json @acepgh\n";
    for (const mutated of [
      mutateRequired(source, exactRule, ""),
      mutateRequired(source, exactRule, "/.github/ci-executable-surface.json @someone-else\n"),
      `${source}\n* @someone-else\n`,
    ]) {
      expect(() => assertSourceTreeManifestCodeowner(mutated)).toThrow(
        /ci-executable-surface|exact CODEOWNERS|effectively owned/iu,
      );
    }
    expect(() => assertSourceTreeManifestCodeowner(`${source}\n${exactRule}`)).toThrow(
      /duplicate/iu,
    );
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
