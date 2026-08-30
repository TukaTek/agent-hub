import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { minimatch } from "minimatch";
import { parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";

export const CODEOWNER = "@acepgh";
export const CANARY_RULE_ID = "rakazo-gitleaks-canary";
export const GITLEAKS_CANARY_PATH = "scripts/fixtures/gitleaks-canary.txt";
export const DESKTOP_SANDBOX_PROTECTED_PATHS = Object.freeze([
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
]);

const CANARY_REGEX = "CAAH30_GITLEAKS_CANARY_[A-Z0-9]{32}";
const CANARY_VALUE_REGEX = "^CAAH30_GITLEAKS_CANARY_0123456789ABCDEF0123456789ABCDE[F]$";
const CANARY_ALLOWLIST_PATH = "^scripts/fixtures/gitleaks-canary\\.txt$";
const GITLEAKS_POLICY = {
  title: "Rakazo secret scanning policy",
  extend: { useDefault: true },
  rules: [
    {
      id: CANARY_RULE_ID,
      description: "Repository-owned canary proving the Gitleaks gate executes",
      regex: CANARY_REGEX,
      keywords: ["CAAH30_GITLEAKS_CANARY_"],
    },
  ],
  allowlists: [
    {
      description: "Ignore only the inert committed canary at its canonical path",
      condition: "AND",
      targetRules: [CANARY_RULE_ID],
      regexTarget: "secret",
      regexes: [CANARY_VALUE_REGEX],
      paths: [CANARY_ALLOWLIST_PATH],
    },
  ],
};
const COMMIT_SHA = /^[0-9a-f]{40}$/iu;
const LOCAL_REUSABLE_WORKFLOW =
  /^\.\/\.github\/workflows\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?)\.yml$/u;
const REMOTE_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const REMOTE_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/u;
const REMOTE_PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/u;
const CODEOWNER_IDENTITY = /^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9_.-]+)?$/;
const EXACT_CANDIDATE_REF = ["$", "{{ github.event.pull_request.head.sha || github.sha }}"].join(
  "",
);
const EXACT_IMAGE_CANDIDATE_SHA = [
  "$",
  "{{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
].join("");
const EXACT_IMAGE_CANDIDATE_REF = ["$", "{{ env.CANDIDATE_SHA }}"].join("");
const EXACT_PULL_REQUEST_HEAD_REF = ["$", "{{ github.event.pull_request.head.sha }}"].join("");
const EXACT_METADATA_TAGS_REF = ["$", "{{ steps.meta.outputs.tags }}"].join("");
const EXACT_METADATA_LABELS_REF = ["$", "{{ steps.meta.outputs.labels }}"].join("");
const EXACT_IMAGE_PROVENANCE_VERIFICATION = `set -euo pipefail
if [[ "$GITHUB_EVENT_NAME" == "pull_request" ]]; then
  test -n "$PR_HEAD_SHA"
  test "$CANDIDATE_SHA" = "$PR_HEAD_SHA"
else
  test "$CANDIDATE_SHA" = "$GITHUB_SHA"
fi
checkout_sha="$(git rev-parse HEAD)"
test "$checkout_sha" = "$CANDIDATE_SHA"
printf 'candidate-sha=%s\\ncheckout-sha=%s\\nimage-tag=sha-%s\\noci-revision=%s\\ngit-sha-build-arg=%s\\n' \\
  "$CANDIDATE_SHA" "$checkout_sha" "$CANDIDATE_SHA" "$CANDIDATE_SHA" "$CANDIDATE_SHA"`;
const CANDIDATE_CHECKOUT_REQUIREMENTS = new Map([
  [
    ".github/workflows/ci.yml",
    {
      candidateJobs: ["security", "lint", "check", "build", "test", "test-integration"],
      historyJobs: ["security"],
    },
  ],
  [".github/workflows/playwright.yml", { candidateJobs: ["playwright"], historyJobs: [] }],
  [
    ".github/workflows/publish-server-image.yml",
    {
      candidateJobs: ["validate", "publish"],
      candidateRef: EXACT_IMAGE_CANDIDATE_REF,
      historyJobs: [],
    },
  ],
]);

const PROTECTED_FILE_GLOBS = [
  ".github/CODEOWNERS",
  ".github/actions/**",
  ".github/dependabot.yml",
  ".github/workflows/**",
  ".gitleaks.toml",
  ".env.example",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "**/package.json",
  "scripts/repository-policy.mjs",
  "scripts/gitleaks-canary.mjs",
  "scripts/gitleaks-history.mjs",
  "scripts/gitleaks-scan.mjs",
  "scripts/{backup,restore}.sh",
  "scripts/publish-playwright-report.sh",
  GITLEAKS_CANARY_PATH,
  "packages/testkit/src/gitleaks-history.test.ts",
  "packages/testkit/src/repository-policy.test.ts",
  "infra/compose/**",
  "infra/updater/**",
  "infra/sandboxes/**/Dockerfile",
  "apps/api/src/app.ts",
  "apps/api/src/{env,router}.{ts,test.ts}",
  "apps/worker/src/index.ts",
  "packages/auth/**",
  "packages/core/src/{model-oauth,screen-lease,secrets-guard,signup-policy}.{ts,test.ts}",
  "packages/adapters/src/{computer-support,desktop-sandbox*,host-aware-sandbox,sandbox-factory}.{ts,test.ts}",
  "packages/adapters/src/sandbox-{conformance,faults}.test.ts",
  "packages/adapters/src/sandbox-provider-env.{ts,test.ts}",
  "packages/contracts/src/{domain,rpc}.ts",
  "packages/db/src/repos.{ts,test.ts}",
  "packages/testkit/src/journeys.test.ts",
  "packages/adapters/src/*connector*.{ts,test.ts}",
  "packages/adapters/src/{computer-control,computer-screens,connector-safety,executor-computer-safety,executor-secret-pi,installed-connectors,mcp-oauth,pi-anthropic-oauth,pi-oauth,run-secret,secrets}.{ts,test.ts}",
  "apps/api/src/screen-proxy.{ts,test.ts}",
  "apps/desktop/src/oauth-callback.{ts,test.ts}",
  "apps/mobile/lib/model-auth.{ts,test.ts}",
  "apps/web/src/lib/{auth,model-auth,use-model-oauth-signin}.{ts,test.ts}",
  "apps/web/src/screen-proxy.{ts,test.ts}",
];

const REQUIRED_PROTECTED_PATHS = [
  ".github/workflows/ci.yml",
  ".github/workflows/publish-server-image.yml",
  ".github/dependabot.yml",
  ".github/CODEOWNERS",
  ".gitleaks.toml",
  "package.json",
  "pnpm-lock.yaml",
  "packages/auth/src/index.ts",
  "packages/core/src/secrets-guard.ts",
  "packages/adapters/src/connector-safety.ts",
  "packages/adapters/src/run-secret.ts",
  "packages/adapters/src/computer-control.ts",
  "apps/api/src/screen-proxy.ts",
  "infra/compose/docker-compose.prod.yml",
  "infra/updater/Dockerfile",
  "scripts/repository-policy.mjs",
  "scripts/gitleaks-history.mjs",
  "scripts/gitleaks-scan.mjs",
  "packages/testkit/src/gitleaks-history.test.ts",
  "packages/testkit/src/repository-policy.test.ts",
  ...DESKTOP_SANDBOX_PROTECTED_PATHS,
];

const REQUIRED_OWNERSHIP_PROBES = [".github/actions/example/action.yml"];

export function assertPinnedWorkflowSource(source, filename) {
  const workflow = parseWorkflowSource(source, filename);
  visitWorkflowValue(workflow, filename, [], new Set());
}

function parseWorkflowSource(source, filename) {
  const document = parseDocument(source, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  const diagnostics = [...document.errors, ...document.warnings];
  if (diagnostics.length > 0) {
    throw new Error(`${filename}: ${diagnostics.map((error) => error.message).join("; ")}`);
  }

  let workflow;
  try {
    workflow = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    throw new Error(`${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return workflow;
}

function visitWorkflowValue(value, filename, location, seen) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) {
    throw new Error(`${filename}: cyclic YAML value at ${formatWorkflowLocation(location)}`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      visitWorkflowValue(child, filename, [...location, index], seen);
    }
  } else {
    for (const [key, child] of Object.entries(value)) {
      const childLocation = [...location, key];
      if (key === "uses") {
        assertPinnedUse(
          child,
          filename,
          formatWorkflowLocation(childLocation),
          isJobLevelUse(childLocation),
        );
      }
      visitWorkflowValue(child, filename, childLocation, seen);
    }
  }
  seen.delete(value);
}

function formatWorkflowLocation(location) {
  return location.reduce(
    (formatted, segment) =>
      typeof segment === "number" ? `${formatted}[${segment}]` : `${formatted}.${segment}`,
    "$",
  );
}

function isJobLevelUse(location) {
  return (
    location.length === 3 &&
    location[0] === "jobs" &&
    typeof location[1] === "string" &&
    location[2] === "uses"
  );
}

function isCanonicalLocalReusableWorkflow(value) {
  const match = LOCAL_REUSABLE_WORKFLOW.exec(value);
  return Boolean(match && !match[1].includes(".."));
}

function assertPinnedUse(value, filename, location, jobLevel) {
  if (typeof value !== "string") {
    throw new Error(`${filename}: ${location} uses must be a string`);
  }
  if (jobLevel && isCanonicalLocalReusableWorkflow(value)) return;
  if (value.startsWith("./") && !jobLevel) {
    throw new Error(
      `${filename}: ${location} local actions are forbidden in steps; local reusable workflows are allowed only at jobs.<job>.uses`,
    );
  }
  const at = value.lastIndexOf("@");
  const source = value.slice(0, at);
  const ref = value.slice(at + 1);
  const segments = source.split("/");
  const pinnedRemote =
    at > 0 &&
    value.indexOf("@") === at &&
    COMMIT_SHA.test(ref) &&
    segments.length >= 2 &&
    REMOTE_OWNER.test(segments[0] ?? "") &&
    REMOTE_REPOSITORY.test(segments[1] ?? "") &&
    segments
      .slice(2)
      .every((segment) => segment !== "." && segment !== ".." && REMOTE_PATH_SEGMENT.test(segment));
  if (!pinnedRemote) {
    const localRequirement = jobLevel
      ? "; job-level local reusable workflows must match ./.github/workflows/<bounded-name>.yml exactly"
      : "";
    throw new Error(
      `${filename}: ${location} action or reusable workflow ${value} must use a remote owner/repository path and an exact 40-hex commit SHA${localRequirement}`,
    );
  }
}

export function assertCandidateCheckoutPolicy(source, filename, requirements) {
  const workflow = parseWorkflowSource(source, filename);
  const jobs = workflow?.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
    throw new Error(`${filename}: candidate workflow must define jobs`);
  }
  const historyJobs = new Set(requirements.historyJobs ?? []);
  const exactRef = requirements.candidateRef ?? EXACT_CANDIDATE_REF;
  for (const jobName of requirements.candidateJobs) {
    const job = jobs[jobName];
    if (!job || !Array.isArray(job.steps)) {
      throw new Error(`${filename}: candidate validation job ${jobName} must define steps`);
    }
    const checkouts = job.steps.filter(
      (step) =>
        step &&
        typeof step === "object" &&
        typeof step.uses === "string" &&
        step.uses.startsWith("actions/checkout@"),
    );
    if (checkouts.length !== 1) {
      throw new Error(
        `${filename}: candidate validation job ${jobName} must have exactly one actions/checkout step`,
      );
    }
    const checkout = checkouts[0];
    const ref = checkout.with?.ref;
    if (ref !== exactRef) {
      const reason =
        typeof ref === "string" && /refs\/pull\/|github\.ref/u.test(ref)
          ? "synthetic merge refs are forbidden"
          : `expected ${exactRef}`;
      throw new Error(
        `${filename}: candidate validation job ${jobName} must checkout the exact candidate head; ${reason}`,
      );
    }
    if (historyJobs.has(jobName) && checkout.with?.["fetch-depth"] !== 0) {
      throw new Error(
        `${filename}: candidate validation job ${jobName} requires full history with fetch-depth: 0`,
      );
    }
  }
  for (const historyJob of historyJobs) {
    if (!requirements.candidateJobs.includes(historyJob)) {
      throw new Error(`${filename}: history job ${historyJob} is not a candidate validation job`);
    }
  }
}

export function assertImageCandidatePolicy(source, filename, requirements) {
  const workflow = parseWorkflowSource(source, filename);
  const jobs = workflow?.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
    throw new Error(`${filename}: image candidate workflow must define jobs`);
  }
  if (workflow?.env?.CANDIDATE_SHA !== EXACT_IMAGE_CANDIDATE_SHA) {
    throw new Error(
      `${filename}: image candidate SHA must be the exact pull-request head with github.sha only as the non-PR fallback`,
    );
  }

  const expectedJobs = [...requirements.candidateJobs];
  if (new Set(expectedJobs).size !== expectedJobs.length || expectedJobs.length === 0) {
    throw new Error(`${filename}: image candidate jobs must be a non-empty unique manifest`);
  }
  const buildJobs = Object.entries(jobs)
    .filter(([, job]) =>
      job?.steps?.some((step) => String(step?.uses ?? "").startsWith("docker/build-push-action@")),
    )
    .map(([jobName]) => jobName)
    .sort();
  if (!isDeepStrictEqual(buildJobs, [...expectedJobs].sort())) {
    throw new Error(
      `${filename}: every image build job must be in the exact candidate provenance manifest; expected ${expectedJobs.join(", ")}, found ${buildJobs.join(", ") || "none"}`,
    );
  }

  assertCandidateCheckoutPolicy(source, filename, {
    candidateJobs: expectedJobs,
    candidateRef: EXACT_IMAGE_CANDIDATE_REF,
    historyJobs: [],
  });
  for (const jobName of expectedJobs) {
    const job = jobs[jobName];
    if (job?.env && Object.hasOwn(job.env, "CANDIDATE_SHA")) {
      throw new Error(
        `${filename}: image candidate job ${jobName} must not override CANDIDATE_SHA`,
      );
    }
    const steps = job.steps;
    for (const step of steps) {
      if (step?.env && Object.hasOwn(step.env, "CANDIDATE_SHA")) {
        throw new Error(
          `${filename}: image candidate job ${jobName} must not override CANDIDATE_SHA`,
        );
      }
    }

    const verification = exactlyOneStep(
      steps,
      (step) => step?.name === "Verify exact candidate provenance",
      filename,
      jobName,
      "exact candidate verification",
    );
    if (
      verification.shell !== "bash" ||
      !isDeepStrictEqual(verification.env, { PR_HEAD_SHA: EXACT_PULL_REQUEST_HEAD_REF }) ||
      typeof verification.run !== "string" ||
      verification.run.trim() !== EXACT_IMAGE_PROVENANCE_VERIFICATION
    ) {
      throw new Error(
        `${filename}: image candidate job ${jobName} must use the exact event-aware candidate verification`,
      );
    }

    const metadata = exactlyOneStep(
      steps,
      (step) => String(step?.uses ?? "").startsWith("docker/metadata-action@"),
      filename,
      jobName,
      "Docker metadata",
    );
    if (metadata.id !== "meta") {
      throw new Error(`${filename}: image candidate job ${jobName} metadata step must use id meta`);
    }
    const candidateTags = scalarLines(metadata.with?.tags).filter(
      (line) => line.startsWith("type=sha") || line.startsWith("type=raw,value=sha-"),
    );
    const expectedTag = `type=raw,value=sha-${EXACT_IMAGE_CANDIDATE_REF}`;
    if (!isDeepStrictEqual(candidateTags, [expectedTag])) {
      throw new Error(
        `${filename}: image candidate job ${jobName} must generate exactly one full candidate SHA tag`,
      );
    }
    const revisionLabels = scalarLines(metadata.with?.labels).filter((line) =>
      line.startsWith("org.opencontainers.image.revision="),
    );
    const expectedRevision = `org.opencontainers.image.revision=${EXACT_IMAGE_CANDIDATE_REF}`;
    if (!isDeepStrictEqual(revisionLabels, [expectedRevision])) {
      throw new Error(
        `${filename}: image candidate job ${jobName} must set exactly one candidate OCI revision label`,
      );
    }

    const build = exactlyOneStep(
      steps,
      (step) => String(step?.uses ?? "").startsWith("docker/build-push-action@"),
      filename,
      jobName,
      "Docker build",
    );
    if (build.with?.tags !== EXACT_METADATA_TAGS_REF) {
      throw new Error(
        `${filename}: image candidate job ${jobName} build tags must come only from candidate metadata`,
      );
    }
    if (build.with?.labels !== EXACT_METADATA_LABELS_REF) {
      throw new Error(
        `${filename}: image candidate job ${jobName} build labels must come only from candidate metadata`,
      );
    }
    const gitShaArguments = scalarLines(build.with?.["build-args"]).filter((line) =>
      line.startsWith("GIT_SHA="),
    );
    if (!isDeepStrictEqual(gitShaArguments, [`GIT_SHA=${EXACT_IMAGE_CANDIDATE_REF}`])) {
      throw new Error(
        `${filename}: image candidate job ${jobName} must set exactly one candidate GIT_SHA build argument`,
      );
    }
  }
}

function exactlyOneStep(steps, predicate, filename, jobName, description) {
  const matches = steps.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(
      `${filename}: image candidate job ${jobName} must have exactly one ${description} step`,
    );
  }
  return matches[0];
}

function scalarLines(value) {
  if (typeof value !== "string") return [];
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export function parseCodeowners(source) {
  const rules = [];
  const patternLines = new Map();
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const tokens = line.split(/\s+/u);
    const comment = tokens.findIndex((token) => token.startsWith("#"));
    if (comment >= 0) tokens.splice(comment);
    const [pattern, ...owners] = tokens;
    if (!pattern || owners.length === 0) {
      throw new Error(`CODEOWNERS line ${index + 1} must include an owner`);
    }
    if (pattern.startsWith("!") || pattern.includes("[") || pattern.includes("]")) {
      throw new Error(`CODEOWNERS line ${index + 1} uses an unsupported pattern: ${pattern}`);
    }
    if (pattern.includes("\\") || pattern.split("/").includes("..")) {
      throw new Error(`CODEOWNERS line ${index + 1} uses an unsafe pattern: ${pattern}`);
    }
    if (!owners.every((owner) => CODEOWNER_IDENTITY.test(owner))) {
      throw new Error(`CODEOWNERS line ${index + 1} contains an invalid owner`);
    }
    const previousLine = patternLines.get(pattern);
    if (previousLine !== undefined) {
      throw new Error(
        `CODEOWNERS line ${index + 1} duplicates pattern ${pattern} from line ${previousLine}`,
      );
    }
    patternLines.set(pattern, index + 1);
    rules.push({ line: index + 1, owners, pattern });
  }
  if (rules.length === 0) throw new Error("CODEOWNERS must contain at least one rule");
  return rules;
}

export function assertDependabotPolicy(source) {
  const document = parseDocument(source, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  const diagnostics = [...document.errors, ...document.warnings];
  if (diagnostics.length > 0) {
    throw new Error(
      `.github/dependabot.yml: ${diagnostics.map((error) => error.message).join("; ")}`,
    );
  }
  const config = document.toJS({ maxAliasCount: 0 });
  if (config?.version !== 2 || !Array.isArray(config.updates)) {
    throw new Error("Dependabot policy must use version 2 with update entries");
  }
  const expected = ["github-actions", "npm"];
  const ecosystems = config.updates.map((update) => update?.["package-ecosystem"]);
  if (
    ecosystems.length !== expected.length ||
    [...ecosystems].sort().some((ecosystem, index) => ecosystem !== expected[index])
  ) {
    throw new Error("Dependabot policy must configure npm and github-actions exactly once");
  }
  for (const update of config.updates) {
    if (update.directory !== "/" || update.schedule?.interval !== "weekly") {
      throw new Error("Dependabot updates must run weekly from the workspace root");
    }
    const limit = update["open-pull-requests-limit"];
    if (!Number.isInteger(limit) || limit < 1 || limit > 5) {
      throw new Error(
        "Dependabot updates must use a bounded open pull request limit of 1 through 5",
      );
    }
  }
  return [...ecosystems].sort();
}

export function effectiveCodeowners(rules, repositoryPath) {
  const normalized = repositoryPath.replaceAll(path.sep, "/").replace(/^\.\//u, "");
  let owners = [];
  for (const rule of rules) {
    if (matchesCodeownersPattern(normalized, rule.pattern)) owners = rule.owners;
  }
  return owners;
}

function matchesCodeownersPattern(repositoryPath, pattern) {
  const rooted = pattern.startsWith("/");
  let glob = rooted ? pattern.slice(1) : pattern;
  const directory = glob.endsWith("/");
  if (directory) glob = `${glob}**`;
  if (!rooted && glob.includes("/")) glob = `**/${glob}`;
  return minimatch(repositoryPath, glob, {
    dot: true,
    matchBase: !rooted && !glob.includes("/"),
    nocase: false,
  });
}

export function assertProtectedCodeowners(source, protectedPaths, expectedOwner) {
  const rules = parseCodeowners(source);
  for (const protectedPath of protectedPaths) {
    const owners = effectiveCodeowners(rules, protectedPath);
    if (owners.length !== 1 || owners[0] !== expectedOwner) {
      throw new Error(
        `${protectedPath} must be effectively owned only by ${expectedOwner}; found ${owners.join(", ") || "no owner"}`,
      );
    }
  }
}

export function assertGitleaksPolicy(source) {
  let config;
  try {
    config = parseToml(source);
  } catch (error) {
    throw new Error(
      `Invalid .gitleaks.toml: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isDeepStrictEqual(config, GITLEAKS_POLICY)) {
    throw new Error(
      "Gitleaks policy must match the exact approved configuration: default extension, one canary rule, and one narrow allowlist",
    );
  }
  return config;
}

export async function assertRepositoryPolicy(root) {
  const workflowsRoot = path.join(root, ".github/workflows");
  const workflowFiles = (await listFiles(workflowsRoot))
    .filter((filename) => /\.ya?ml$/iu.test(filename))
    .sort();
  if (workflowFiles.length === 0) throw new Error("No GitHub Actions workflows found");
  for (const repositoryFilename of CANDIDATE_CHECKOUT_REQUIREMENTS.keys()) {
    const filename = repositoryFilename.slice(".github/workflows/".length);
    if (!workflowFiles.includes(filename)) {
      throw new Error(`Required candidate workflow is missing: ${repositoryFilename}`);
    }
  }
  for (const filename of workflowFiles) {
    const repositoryFilename = `.github/workflows/${filename}`;
    const source = await readFile(path.join(workflowsRoot, filename), "utf8");
    assertPinnedWorkflowSource(source, repositoryFilename);
    const checkoutRequirements = CANDIDATE_CHECKOUT_REQUIREMENTS.get(repositoryFilename);
    if (checkoutRequirements) {
      assertCandidateCheckoutPolicy(source, repositoryFilename, checkoutRequirements);
    }
    if (repositoryFilename === ".github/workflows/publish-server-image.yml") {
      assertImageCandidatePolicy(source, repositoryFilename, checkoutRequirements);
    }
  }
  assertDependabotPolicy(await readFile(path.join(root, ".github/dependabot.yml"), "utf8"));

  const allFiles = await listFiles(root, new Set([".git", ".turbo", "node_modules"]));
  const protectedPaths = new Set([...REQUIRED_PROTECTED_PATHS, ...REQUIRED_OWNERSHIP_PROBES]);
  for (const filename of allFiles) {
    if (PROTECTED_FILE_GLOBS.some((glob) => minimatch(filename, glob, { dot: true }))) {
      protectedPaths.add(filename);
    }
  }
  for (const filename of REQUIRED_PROTECTED_PATHS) {
    const info = await stat(path.join(root, filename)).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`Required protected file is missing: ${filename}`);
  }

  const codeownersSource = await readFile(path.join(root, ".github/CODEOWNERS"), "utf8");
  assertProtectedCodeowners(codeownersSource, [...protectedPaths].sort(), CODEOWNER);

  const gitleaksSource = await readFile(path.join(root, ".gitleaks.toml"), "utf8");
  const gitleaks = assertGitleaksPolicy(gitleaksSource);
  const canary = (await readFile(path.join(root, GITLEAKS_CANARY_PATH), "utf8")).trim();
  const canaryRule = gitleaks.rules.find((rule) => rule.id === CANARY_RULE_ID);
  if (!new RegExp(canaryRule.regex).test(canary)) {
    throw new Error("Committed Gitleaks canary does not match its detection rule");
  }

  return {
    codeowner: CODEOWNER,
    protectedPathCount: protectedPaths.size,
    workflowCount: workflowFiles.length,
  };
}

async function listFiles(root, ignoredDirectories = new Set()) {
  const files = [];
  async function visit(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        throw new Error(`Policy input must not be a symlink: ${relative}`);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name))
          await visit(path.join(directory, entry.name), relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }
  await visit(root, "");
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  assertRepositoryPolicy(root)
    .then(({ codeowner, protectedPathCount, workflowCount }) => {
      console.log(
        `Repository policy passed: ${workflowCount} workflows, ${protectedPathCount} protected paths, owner ${codeowner}`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
