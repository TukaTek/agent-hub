import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { minimatch } from "minimatch";
import { parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";

export const CODEOWNER = "@acepgh";
export const CANARY_RULE_ID = "rakazo-gitleaks-canary";
export const GITLEAKS_CANARY_PATH = "scripts/fixtures/gitleaks-canary.txt";
export const EXECUTABLE_SURFACE_MANIFEST_PATH = ".github/ci-executable-surface.json";
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
const LOCAL_ACTION =
  /^\.\/\.github\/actions\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?)*$/u;
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
const EXACT_MATRIX_DOCKERFILE_REF = ["$", "{{ matrix.dockerfile }}"].join("");
const EXACT_MATRIX_NAME_REF = ["$", "{{ matrix.name }}"].join("");
const EXACT_PULL_REQUEST_NUMBER_REF = ["$", "{{ github.event.pull_request.number }}"].join("");
const EXACT_IMAGE_PLATFORMS_REF = [
  "$",
  "{{ (github.event_name == 'workflow_dispatch' || startsWith(github.ref, 'refs/tags/v')) && 'linux/amd64,linux/arm64' || 'linux/amd64' }}",
].join("");
const IMAGE_BUILD_WORKFLOW = ".github/workflows/publish-server-image.yml";
const EXACT_BUILD_PUSH_ACTION = "docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8";
const AUTHORIZED_IMAGE_BUILD_STEPS = Object.freeze([
  {
    job: "validate",
    stepIndex: 4,
    workflow: IMAGE_BUILD_WORKFLOW,
    step: {
      uses: EXACT_BUILD_PUSH_ACTION,
      with: {
        context: ".",
        file: EXACT_MATRIX_DOCKERFILE_REF,
        push: false,
        tags: EXACT_METADATA_TAGS_REF,
        labels: EXACT_METADATA_LABELS_REF,
        "build-args": `GIT_SHA=${EXACT_IMAGE_CANDIDATE_REF}`,
        "cache-from": `type=gha,scope=${EXACT_MATRIX_NAME_REF}`,
        "cache-to": `type=gha,mode=max,scope=pr-${EXACT_PULL_REQUEST_NUMBER_REF}-${EXACT_MATRIX_NAME_REF}`,
        provenance: false,
        sbom: false,
      },
    },
  },
  {
    job: "publish",
    stepIndex: 6,
    workflow: IMAGE_BUILD_WORKFLOW,
    step: {
      id: "build",
      uses: EXACT_BUILD_PUSH_ACTION,
      with: {
        context: ".",
        file: EXACT_MATRIX_DOCKERFILE_REF,
        push: true,
        tags: EXACT_METADATA_TAGS_REF,
        labels: EXACT_METADATA_LABELS_REF,
        platforms: EXACT_IMAGE_PLATFORMS_REF,
        "build-args": `GIT_SHA=${EXACT_IMAGE_CANDIDATE_REF}`,
        "cache-from": `type=gha,scope=${EXACT_MATRIX_NAME_REF}`,
        "cache-to": `type=gha,mode=max,scope=${EXACT_MATRIX_NAME_REF}`,
        provenance: "mode=max",
        sbom: true,
      },
    },
  },
]);
const IMAGE_BUILD_ACTION_SOURCES = new Set([
  "docker/bake-action",
  "docker/build-push-action",
  "redhat-actions/buildah-build",
]);
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
    IMAGE_BUILD_WORKFLOW,
    {
      candidateJobs: AUTHORIZED_IMAGE_BUILD_STEPS.map(({ job }) => job),
      candidateRef: EXACT_IMAGE_CANDIDATE_REF,
      historyJobs: [],
    },
  ],
]);

const PROTECTED_FILE_GLOBS = [
  ".github/CODEOWNERS",
  EXECUTABLE_SURFACE_MANIFEST_PATH,
  ".github/actions/**",
  ".github/dependabot.yml",
  ".github/workflows/**",
  ".gitleaks.toml",
  ".env.example",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "**/package.json",
  "scripts/**",
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
  IMAGE_BUILD_WORKFLOW,
  ".github/dependabot.yml",
  ".github/CODEOWNERS",
  EXECUTABLE_SURFACE_MANIFEST_PATH,
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

const REQUIRED_OWNERSHIP_PROBES = [
  ".github/actions/example/action.yml",
  "scripts/future-extensionless-wrapper",
  "scripts/nested/future wrapper",
];

export function assertPinnedWorkflowSource(source, filename) {
  const workflow = parseWorkflowSource(source, filename);
  assertPinnedWorkflow(workflow, filename);
}

function assertPinnedWorkflow(workflow, filename) {
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

function isCanonicalLocalAction(value) {
  return LOCAL_ACTION.test(value) && !value.split("/").includes("..");
}

function assertPinnedUse(value, filename, location, jobLevel) {
  if (typeof value !== "string") {
    throw new Error(`${filename}: ${location} uses must be a string`);
  }
  if (jobLevel && isCanonicalLocalReusableWorkflow(value)) return;
  if (!jobLevel && isCanonicalLocalAction(value)) return;
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

function imageBuildIdentity(workflow, job, stepIndex) {
  return `${workflow}:jobs.${job}.steps[${stepIndex}]`;
}

function imageBuildActionSource(value) {
  if (typeof value !== "string") return undefined;
  const at = value.lastIndexOf("@");
  if (at <= 0) return undefined;
  const source = value.slice(0, at).toLowerCase();
  return IMAGE_BUILD_ACTION_SOURCES.has(source) ? source : undefined;
}

function assertRepositoryImageBuildPolicy(workflows) {
  assertReusableWorkflowInventory(workflows);

  const manifest = new Map(
    AUTHORIZED_IMAGE_BUILD_STEPS.map((entry) => [
      imageBuildIdentity(entry.workflow, entry.job, entry.stepIndex),
      entry,
    ]),
  );
  const discovered = new Set();

  for (const [workflowFilename, workflow] of workflows) {
    const jobs = workflow?.jobs;
    if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) continue;
    for (const [jobName, job] of Object.entries(jobs)) {
      if (!job || typeof job !== "object" || !Array.isArray(job.steps)) continue;
      for (const [stepIndex, step] of job.steps.entries()) {
        if (!step || typeof step !== "object" || Array.isArray(step)) continue;
        const location = imageBuildIdentity(workflowFilename, jobName, stepIndex);
        const actionSource = imageBuildActionSource(step.uses);
        if (actionSource) {
          const authorized = manifest.get(location);
          if (!authorized) {
            throw new Error(
              `${location}: image build action ${actionSource} is outside the exact authorized image-build manifest`,
            );
          }
          if (!isDeepStrictEqual(step, authorized.step)) {
            throw new Error(
              `${location}: authorized image build action and inputs must exactly match the repository manifest`,
            );
          }
          discovered.add(location);
        }
        if (Object.hasOwn(step, "run") && typeof step.run !== "string") {
          throw new Error(`${location}.run: workflow run commands must be strings`);
        }
      }
    }
  }

  for (const identity of manifest.keys()) {
    if (!discovered.has(identity)) {
      throw new Error(
        `Authorized image build is missing from the exact manifest location ${identity}`,
      );
    }
  }
}

function assertReusableWorkflowInventory(workflows) {
  const states = new Map();

  function visit(workflowFilename, callers) {
    const state = states.get(workflowFilename);
    if (state === "visited") return;
    if (state === "visiting") {
      throw new Error(
        `Local reusable workflow inventory contains a cycle: ${[...callers, workflowFilename].join(" -> ")}`,
      );
    }
    states.set(workflowFilename, "visiting");
    const workflow = workflows.get(workflowFilename);
    const jobs = workflow?.jobs;
    if (jobs && typeof jobs === "object" && !Array.isArray(jobs)) {
      for (const [jobName, job] of Object.entries(jobs)) {
        if (!job || typeof job !== "object" || Array.isArray(job) || !Object.hasOwn(job, "uses")) {
          continue;
        }
        const uses = job.uses;
        if (typeof uses === "string" && isCanonicalLocalReusableWorkflow(uses)) {
          const target = uses.slice(2);
          if (!workflows.has(target)) {
            throw new Error(
              `${workflowFilename}:jobs.${jobName}.uses references missing local reusable workflow ${target}; image-build inventory cannot inspect it`,
            );
          }
          visit(target, [...callers, workflowFilename]);
          continue;
        }
        throw new Error(
          `${workflowFilename}:jobs.${jobName}.uses invokes an opaque remote reusable workflow; repository image-build inventory permits only inspectable local reusable workflows`,
        );
      }
    }
    states.set(workflowFilename, "visited");
  }

  for (const workflowFilename of workflows.keys()) visit(workflowFilename, []);
}

const EXECUTABLE_SURFACE_SCHEMA_VERSION = 1;
const STATIC_REPOSITORY_FILE =
  /(?:^|[\s'"=(])((?:scripts|packages|apps|infra)\/[A-Za-z0-9_./-]+\.(?:cjs|js|mjs|ps1|py|rb|sh|ts|tsx))(?=$|[\s'"),;])/gu;
const STATIC_LOCAL_MODULE =
  /^\s*(?:import\s*(?:[^"'`\n]*?\sfrom\s*)?|export\s+[^"'`\n]*?\sfrom\s*|\}\s*from\s*)["'](\.{1,2}\/[^"'`]+)["']/gmu;
const STATIC_LOCAL_LOADER =
  /^\s*(?:(?:const|let|var)\s+[^=\n]+?=\s*)?(?:(?:await\s+)?import|require)\(\s*["'](\.{1,2}\/[^"'`]+)["']/gmu;
const DYNAMIC_EXECUTION_TARGET =
  /\b(?:bash|bun|dash|node|python3?|sh|tsx|zsh)\s+(?:-[A-Za-z0-9-]+\s+)*(?:["']?\$\{\{|["']?\$[A-Za-z_])/u;
const PACKAGE_MANAGER_FILES = [".npmrc", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
const STATIC_EXECUTORS = new Set([
  "bash",
  "bun",
  "dash",
  "node",
  "python",
  "python2",
  "python3",
  "sh",
  "tsx",
  "zsh",
]);
const REPOSITORY_PATH_PREFIXES = [".github/", "apps/", "infra/", "packages/", "scripts/"];

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function normalizedRepositoryPath(value) {
  return value.split(path.sep).join("/").replace(/^\.\//u, "");
}

function stripStaticQuotes(value) {
  const trimmed = value
    .trim()
    .replace(/^[["',]+/u, "")
    .replace(/[\]"',);\\]+$/u, "");
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed.trim();
}

function staticWords(source) {
  return (source.match(/"[^"]*"|'[^']*'|[^\s]+/gu) ?? []).map(stripStaticQuotes).filter(Boolean);
}

function staticCommandSegments(source) {
  return source
    .replace(/\\\r?\n/gu, " ")
    .split(/\r?\n|&&|\|\||[;|]/u)
    .map((segment) => staticWords(segment))
    .filter((words) => words.length > 0);
}

function isRepositoryExecutionPath(value) {
  const candidate = stripStaticQuotes(value).replaceAll("\\", "/");
  return (
    candidate.startsWith("./") ||
    candidate.startsWith("../") ||
    REPOSITORY_PATH_PREFIXES.some((prefix) => candidate.startsWith(prefix))
  );
}

function directRepositoryExecutionTargets(source) {
  const targets = [];
  for (const words of staticCommandSegments(source)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*\$\(/u.test(words[0] ?? "")) continue;
    let index = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index] ?? "")) index += 1;

    if (words[index] === "command" || words[index] === "exec") {
      index += 1;
      while (words[index]?.startsWith("-")) index += 1;
    } else if (words[index] === "env" || words[index] === "cross-env") {
      index += 1;
      while (
        words[index]?.startsWith("-") ||
        /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index] ?? "")
      ) {
        index += 1;
      }
    }

    const candidate = words[index];
    if (candidate && isRepositoryExecutionPath(candidate)) targets.push(candidate);
  }
  return targets;
}

function interpretedRepositoryExecutionTargets(source) {
  const targets = [];
  for (const words of staticCommandSegments(source)) {
    for (const [index, word] of words.entries()) {
      if (!STATIC_EXECUTORS.has(word)) continue;
      const candidate = words.slice(index + 1).find(isRepositoryExecutionPath);
      if (candidate) targets.push(candidate);
    }
  }
  return targets;
}

export function parseStrictJson(source, filename = "JSON input") {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `${filename}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let offset = 0;
  function skipWhitespace() {
    while (/\s/u.test(source[offset] ?? "")) offset += 1;
  }

  function readString() {
    const start = offset;
    offset += 1;
    while (offset < source.length) {
      if (source[offset] === "\\") {
        offset += 2;
        continue;
      }
      if (source[offset] === '"') {
        offset += 1;
        return JSON.parse(source.slice(start, offset));
      }
      offset += 1;
    }
    throw new Error(`${filename}: invalid JSON string`);
  }

  function readValue() {
    skipWhitespace();
    if (source[offset] === "{") {
      readObject();
      return;
    }
    if (source[offset] === "[") {
      readArray();
      return;
    }
    if (source[offset] === '"') {
      readString();
      return;
    }
    while (offset < source.length && !/[\s,\]}]/u.test(source[offset])) offset += 1;
  }

  function readObject() {
    offset += 1;
    skipWhitespace();
    const keys = new Set();
    if (source[offset] === "}") {
      offset += 1;
      return;
    }
    while (offset < source.length) {
      skipWhitespace();
      const key = readString();
      if (keys.has(key)) {
        throw new Error(`${filename}: duplicate JSON object key ${JSON.stringify(key)}`);
      }
      keys.add(key);
      skipWhitespace();
      offset += 1;
      readValue();
      skipWhitespace();
      if (source[offset] === "}") {
        offset += 1;
        return;
      }
      offset += 1;
    }
  }

  function readArray() {
    offset += 1;
    skipWhitespace();
    if (source[offset] === "]") {
      offset += 1;
      return;
    }
    while (offset < source.length) {
      readValue();
      skipWhitespace();
      if (source[offset] === "]") {
        offset += 1;
        return;
      }
      offset += 1;
    }
  }

  readValue();
  return parsed;
}

function manifestEntriesByPath(entries) {
  return new Map(
    Array.isArray(entries)
      ? entries
          .filter((entry) => entry && typeof entry === "object" && typeof entry.path === "string")
          .map((entry) => [entry.path, entry])
      : [],
  );
}

function describeExecutableManifestDrift(actual, expected) {
  if (actual?.schemaVersion !== EXECUTABLE_SURFACE_SCHEMA_VERSION) {
    return `schemaVersion must be ${EXECUTABLE_SURFACE_SCHEMA_VERSION}`;
  }
  const actualWorkflows = manifestEntriesByPath(actual.workflows);
  const expectedWorkflows = manifestEntriesByPath(expected.workflows);
  for (const workflowPath of expectedWorkflows.keys()) {
    if (!actualWorkflows.has(workflowPath)) return `missing workflow ${workflowPath}`;
  }
  for (const workflowPath of actualWorkflows.keys()) {
    if (!expectedWorkflows.has(workflowPath)) return `extra workflow ${workflowPath}`;
  }
  for (const [workflowPath, expectedEntry] of expectedWorkflows) {
    if (actualWorkflows.get(workflowPath)?.sha256 !== expectedEntry.sha256) {
      return `workflow content digest drift: ${workflowPath}`;
    }
  }

  const actualSurfaces = manifestEntriesByPath(actual.surfaces);
  const expectedSurfaces = manifestEntriesByPath(expected.surfaces);
  for (const surfacePath of expectedSurfaces.keys()) {
    if (!actualSurfaces.has(surfacePath)) return `missing reachable surface ${surfacePath}`;
  }
  for (const surfacePath of actualSurfaces.keys()) {
    if (!expectedSurfaces.has(surfacePath)) return `extra unreachable surface ${surfacePath}`;
  }
  for (const [surfacePath, expectedEntry] of expectedSurfaces) {
    if (actualSurfaces.get(surfacePath)?.sha256 !== expectedEntry.sha256) {
      return `executable surface content digest drift: ${surfacePath}`;
    }
  }
  if (!isDeepStrictEqual(actual.localActions, expected.localActions)) {
    return "local action inventory or entrypoint drift";
  }
  if (!isDeepStrictEqual(actual.packageScripts, expected.packageScripts)) {
    return "reachable package script inventory drift";
  }
  return "manifest metadata drift";
}

export async function createExecutableSurfaceManifest(root) {
  const canonicalRoot = await realpath(root);
  const allFiles = await listFiles(canonicalRoot, new Set([".git", ".turbo", "node_modules"]));
  const fileSet = new Set(allFiles);
  const workflowPaths = allFiles
    .filter((filename) => filename.startsWith(".github/workflows/") && /\.ya?ml$/iu.test(filename))
    .sort();
  for (const workflowPath of workflowPaths) {
    if (!/^\.github\/workflows\/[^/]+\.yml$/u.test(workflowPath)) {
      throw new Error(`Workflow path must be a canonical top-level .yml file: ${workflowPath}`);
    }
  }
  if (workflowPaths.length === 0) throw new Error("No GitHub Actions workflows found");

  const packagePaths = allFiles.filter(
    (filename) => filename === "package.json" || filename.endsWith("/package.json"),
  );
  const packages = new Map();
  const packageByName = new Map();
  for (const packagePath of packagePaths.sort()) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(canonicalRoot, packagePath), "utf8"));
    } catch (error) {
      throw new Error(
        `${packagePath}: invalid package manifest: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    packages.set(packagePath, manifest);
    if (typeof manifest.name === "string") {
      if (packageByName.has(manifest.name)) {
        throw new Error(`Duplicate package name ${manifest.name} in executable-surface inventory`);
      }
      packageByName.set(manifest.name, packagePath);
    }
  }

  const workflowSources = new Map();
  const workflows = new Map();
  for (const workflowPath of workflowPaths) {
    const source = await readFile(path.join(canonicalRoot, workflowPath));
    workflowSources.set(workflowPath, source);
    workflows.set(workflowPath, parseWorkflowSource(source.toString("utf8"), workflowPath));
  }

  const actionManifestByDirectory = new Map();
  for (const filename of allFiles) {
    if (!/^\.github\/actions\/.+\/action\.ya?ml$/u.test(filename)) continue;
    const directory = path.posix.dirname(filename);
    if (actionManifestByDirectory.has(directory)) {
      throw new Error(`${directory}: local action must have exactly one action.yml or action.yaml`);
    }
    actionManifestByDirectory.set(directory, filename);
  }

  const surfaceReasons = new Map();
  const surfaceDigests = new Map();
  const packageScriptNames = new Map();
  const packageScriptStates = new Map();
  const actionStates = new Map();
  const actionEntrypoints = new Map();
  const workflowStates = new Map();
  const fileStates = new Map();

  function repositoryPath(candidate, baseDirectory, location) {
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw new Error(`${location}: execution target must be a non-empty static string`);
    }
    if (/\$\{\{|\$[A-Za-z_]|`/u.test(candidate)) {
      throw new Error(`${location}: dynamic first-party execution targets are forbidden`);
    }
    const unquoted = stripStaticQuotes(candidate).replaceAll("\\", "/");
    if (path.posix.isAbsolute(unquoted)) {
      throw new Error(`${location}: execution target is outside the repository root: ${candidate}`);
    }
    const relative = path.posix.normalize(path.posix.join(baseDirectory, unquoted));
    if (relative === ".." || relative.startsWith("../")) {
      throw new Error(`${location}: execution target is outside the repository root: ${candidate}`);
    }
    return relative.replace(/^\.\//u, "");
  }

  async function readSurface(relative, reason, requireExecutable = false) {
    const normalized = normalizedRepositoryPath(relative);
    const absolute = path.resolve(canonicalRoot, normalized);
    if (absolute !== canonicalRoot && !absolute.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new Error(`${reason}: execution target is outside the repository root: ${relative}`);
    }
    const info = await lstat(absolute).catch(() => undefined);
    if (!info) throw new Error(`${reason}: unresolved first-party execution target ${normalized}`);
    if (info.isSymbolicLink()) {
      throw new Error(`${reason}: executable surface must not be a symlink: ${normalized}`);
    }
    if (!info.isFile()) {
      throw new Error(`${reason}: executable surface must be a regular file: ${normalized}`);
    }
    if (requireExecutable && process.platform !== "win32" && (info.mode & 0o111) === 0) {
      throw new Error(
        `${reason}: directly executed first-party path lacks executable permission: ${normalized}`,
      );
    }
    const resolved = await realpath(absolute);
    if (resolved !== canonicalRoot && !resolved.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new Error(
        `${reason}: executable surface resolves outside the repository root: ${normalized}`,
      );
    }
    const source = await readFile(absolute);
    surfaceDigests.set(normalized, sha256(source));
    const reasons = surfaceReasons.get(normalized) ?? new Set();
    reasons.add(reason);
    surfaceReasons.set(normalized, reasons);
    return source;
  }

  async function addIfPresent(relative, reason) {
    if (fileSet.has(relative)) await visitFile(relative, reason, path.posix.dirname(relative));
  }

  function selectedPackagePath(selector, location) {
    const normalized = selector.replace(/^\.\.\./u, "").replace(/\.\.\.$/u, "");
    if (/\$\{\{|\$[A-Za-z_]|\*/u.test(normalized)) {
      throw new Error(`${location}: dynamic or wildcard package filters are not auditable`);
    }
    const selected = packageByName.get(normalized);
    if (!selected) throw new Error(`${location}: unresolved workspace package ${selector}`);
    return selected;
  }

  async function addToolConfiguration(source, baseDirectory, location) {
    if (/\bturbo\b/u.test(source)) await addIfPresent("turbo.json", `${location}: turbo config`);
    if (/\bbiome\b/u.test(source)) await addIfPresent("biome.json", `${location}: Biome config`);
    if (/\bvitest\b/u.test(source)) {
      await addIfPresent("vitest.config.ts", `${location}: Vitest config`);
      await addIfPresent("packages/testkit/src/pin-test-env.ts", `${location}: Vitest setup file`);
    }
    if (/\bprisma\b/u.test(source)) {
      await addIfPresent(
        path.posix.join(baseDirectory, "prisma.config.ts"),
        `${location}: Prisma executable config`,
      );
      await addIfPresent(
        "packages/db/prisma/schema.prisma",
        `${location}: Prisma generator config`,
      );
    }
    if (/\bvite\b/u.test(source)) {
      await addIfPresent(
        path.posix.join(baseDirectory, "vite.config.ts"),
        `${location}: Vite config`,
      );
      await addIfPresent(
        path.posix.join(baseDirectory, "lingui.config.ts"),
        `${location}: Lingui config`,
      );
    }
    if (/\bastro\b/u.test(source)) {
      await addIfPresent(
        path.posix.join(baseDirectory, "astro.config.mjs"),
        `${location}: Astro config`,
      );
    }
    if (/\bplaywright\b/u.test(source)) {
      const explicit = /(?:--config(?:=|\s+))([^\s;&|]+)/u.exec(source)?.[1];
      const config = explicit
        ? repositoryPath(explicit, baseDirectory, `${location}: Playwright config`)
        : path.posix.join(baseDirectory, "playwright.config.ts");
      await addIfPresent(config, `${location}: Playwright config`);
    }
    const typescriptConfig = /\btsc\b[^\n;&|]*?(?:-p|--project)\s+([^\s;&|]+)/u.exec(source)?.[1];
    if (typescriptConfig) {
      const config = repositoryPath(
        typescriptConfig,
        baseDirectory,
        `${location}: TypeScript config`,
      );
      await visitFile(config, `${location}: TypeScript config`, path.posix.dirname(config));
    }
  }

  async function visitPackageScript(packagePath, scriptName, reason) {
    const key = `${packagePath}#${scriptName}`;
    const state = packageScriptStates.get(key);
    if (state === "visiting") throw new Error(`Package script execution cycle at ${key}`);
    const names = packageScriptNames.get(packagePath) ?? new Set();
    names.add(scriptName);
    packageScriptNames.set(packagePath, names);
    if (state === "visited") return;

    const command = packages.get(packagePath)?.scripts?.[scriptName];
    if (typeof command !== "string") {
      throw new Error(`${reason}: unresolved package script ${key}`);
    }
    packageScriptStates.set(key, "visiting");
    const baseDirectory = path.posix.dirname(packagePath);
    await scanExecutionText(command, {
      baseDirectory: baseDirectory === "." ? "" : baseDirectory,
      location: `package-script:${key}`,
      packagePath,
    });
    packageScriptStates.set(key, "visited");
  }

  async function visitPnpmInvocation(words, context) {
    let selector;
    let index = 0;
    while (index < words.length && words[index].startsWith("-")) {
      const option = words[index];
      if (option === "--filter" || option === "-F") {
        selector = words[index + 1];
        if (!selector) throw new Error(`${context.location}: pnpm --filter needs a value`);
        index += 2;
      } else {
        index += 1;
      }
    }
    let command = words[index];
    if (!command) return;
    if (command === "run") {
      index += 1;
      command = words[index];
      if (!command) throw new Error(`${context.location}: pnpm run needs a static script name`);
    }
    const selectedPackage = selector
      ? selectedPackagePath(selector, context.location)
      : (context.packagePath ?? "package.json");
    const selectedDirectory = path.posix.dirname(selectedPackage);

    if (command === "exec") {
      await addToolConfiguration(
        words.slice(index + 1).join(" "),
        selectedDirectory === "." ? "" : selectedDirectory,
        `${context.location}: pnpm exec`,
      );
      return;
    }
    if (
      [
        "add",
        "audit",
        "config",
        "dlx",
        "fetch",
        "install",
        "list",
        "outdated",
        "remove",
        "why",
      ].includes(command)
    ) {
      return;
    }
    if (/\$\{\{|\$[A-Za-z_]|["'`]/u.test(command)) {
      throw new Error(`${context.location}: dynamic package script references are forbidden`);
    }
    await visitPackageScript(selectedPackage, command, context.location);
  }

  async function scanExecutionText(source, context) {
    if (DYNAMIC_EXECUTION_TARGET.test(source)) {
      throw new Error(`${context.location}: dynamic first-party execution target is forbidden`);
    }

    async function visitStaticCandidate(candidate, requireExecutable = false) {
      const explicitlyRelative = candidate.startsWith("./") || candidate.startsWith("../");
      const packageRelative = repositoryPath(
        candidate,
        context.baseDirectory,
        `${context.location}: first-party execution target`,
      );
      const resolved =
        explicitlyRelative || fileSet.has(packageRelative) ? packageRelative : candidate;
      await visitFile(
        resolved,
        `${context.location}: static file reference`,
        context.baseDirectory,
        false,
        requireExecutable,
        requireExecutable,
      );
    }
    for (const candidate of directRepositoryExecutionTargets(source)) {
      await visitStaticCandidate(candidate, true);
    }
    for (const candidate of interpretedRepositoryExecutionTargets(source)) {
      await visitStaticCandidate(candidate);
    }
    for (const match of source.matchAll(STATIC_REPOSITORY_FILE)) {
      await visitStaticCandidate(match[1]);
    }

    for (const match of source.matchAll(/(?<![A-Za-z0-9_-])pnpm(?![A-Za-z0-9_-])([^\n;&|]*)/gu)) {
      await visitPnpmInvocation(staticWords(match[1]), context);
    }

    for (const match of source.matchAll(/\bturbo\s+(?:run\s+)?([A-Za-z0-9:_-]+)/gu)) {
      const scriptName = match[1];
      for (const [packagePath, manifest] of packages) {
        if (packagePath !== "package.json" && typeof manifest.scripts?.[scriptName] === "string") {
          await visitPackageScript(
            packagePath,
            scriptName,
            `${context.location}: turbo ${scriptName}`,
          );
        }
      }
    }
    await addToolConfiguration(source, context.baseDirectory, context.location);
  }

  async function visitFile(
    relative,
    reason,
    baseDirectory = "",
    followStaticModules = false,
    requireExecutable = false,
    followExecutionReferences = false,
  ) {
    const normalized = repositoryPath(relative, "", reason);
    const state = fileStates.get(normalized);
    if (state === "visiting")
      throw new Error(`First-party executable reference cycle at ${normalized}`);
    const source = await readSurface(normalized, reason, requireExecutable);
    if (state === "visited") return;
    fileStates.set(normalized, "visiting");
    const text = source.toString("utf8");
    const moduleDirectory = path.posix.dirname(normalized);
    const executableModuleRoot =
      normalized.startsWith(".github/actions/") ||
      normalized.startsWith("scripts/") ||
      normalized.includes("/scripts/") ||
      /(?:^|\.)config\.(?:[cm]?js|tsx?)$/u.test(path.posix.basename(normalized));
    if (/\.(?:[cm]?js|tsx?)$/u.test(normalized) && (followStaticModules || executableModuleRoot)) {
      for (const match of [
        ...text.matchAll(STATIC_LOCAL_MODULE),
        ...text.matchAll(STATIC_LOCAL_LOADER),
      ]) {
        const unresolved = repositoryPath(
          match[1],
          moduleDirectory === "." ? "" : moduleDirectory,
          `file:${normalized}: static local module`,
        );
        const extension = path.posix.extname(unresolved);
        const stem = extension ? unresolved.slice(0, -extension.length) : unresolved;
        const candidates = [
          unresolved,
          ...(extension === ".js" ? [`${stem}.ts`, `${stem}.tsx`] : []),
          ...(!extension
            ? [
                `${unresolved}.ts`,
                `${unresolved}.tsx`,
                `${unresolved}.js`,
                `${unresolved}.mjs`,
                `${unresolved}.cjs`,
                `${unresolved}/index.ts`,
                `${unresolved}/index.tsx`,
                `${unresolved}/index.js`,
              ]
            : []),
        ];
        const target = candidates.find((candidate) => fileSet.has(candidate));
        if (!target) {
          throw new Error(`file:${normalized}: unresolved static local module ${match[1]}`);
        }
        await visitFile(
          target,
          `file:${normalized}: static local module`,
          path.posix.dirname(target),
          true,
        );
      }
    }
    if (/^tsconfig(?:\.[A-Za-z0-9_-]+)?\.json$/u.test(path.posix.basename(normalized))) {
      let config;
      try {
        config = JSON.parse(text);
      } catch (error) {
        throw new Error(
          `${normalized}: invalid TypeScript config: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (typeof config.extends === "string" && config.extends.startsWith(".")) {
        const target = repositoryPath(
          config.extends,
          moduleDirectory === "." ? "" : moduleDirectory,
          `file:${normalized}: TypeScript config extends`,
        );
        await visitFile(
          path.posix.extname(target) ? target : `${target}.json`,
          `file:${normalized}: TypeScript config extends`,
          path.posix.dirname(target),
        );
      }
    }
    if (
      followExecutionReferences ||
      normalized.endsWith(".sh") ||
      path.posix.basename(normalized) === "Dockerfile" ||
      /^#![^\n]*\b(?:bash|dash|sh|zsh)\b/u.test(text)
    ) {
      await scanExecutionText(text, {
        baseDirectory,
        location: `file:${normalized}`,
        packagePath: "package.json",
      });
    }
    fileStates.set(normalized, "visited");
  }

  function localActionDirectory(value, callerDirectory, location) {
    if (typeof value !== "string" || /\$\{\{|\$[A-Za-z_]|`/u.test(value)) {
      throw new Error(`${location}: local action reference must be static`);
    }
    const target = value.startsWith("./.github/actions/")
      ? value.slice(2)
      : path.posix.normalize(path.posix.join(callerDirectory, value));
    if (!target.startsWith(".github/actions/") || target.split("/").includes("..")) {
      throw new Error(`${location}: local action target is outside .github/actions: ${value}`);
    }
    return target;
  }

  async function visitLocalAction(directory, callers = []) {
    const state = actionStates.get(directory);
    if (state === "visited") return;
    if (state === "visiting") {
      throw new Error(`Local action execution cycle: ${[...callers, directory].join(" -> ")}`);
    }
    const manifestPath = actionManifestByDirectory.get(directory);
    if (!manifestPath) throw new Error(`Unresolved local action manifest: ${directory}`);
    actionStates.set(directory, "visiting");
    const source = await readFile(path.join(canonicalRoot, manifestPath));
    const manifest = parseWorkflowSource(source.toString("utf8"), manifestPath);
    const runs = manifest?.runs;
    if (!runs || typeof runs !== "object" || Array.isArray(runs)) {
      throw new Error(`${manifestPath}: local action must define runs`);
    }
    const using = runs.using;
    const entrypoints = actionEntrypoints.get(manifestPath) ?? new Set();
    actionEntrypoints.set(manifestPath, entrypoints);

    if (using === "composite") {
      if (!Array.isArray(runs.steps)) {
        throw new Error(`${manifestPath}: composite local action must define steps`);
      }
      for (const [stepIndex, step] of runs.steps.entries()) {
        if (!step || typeof step !== "object" || Array.isArray(step)) {
          throw new Error(`${manifestPath}:runs.steps[${stepIndex}] must be an object`);
        }
        if (Object.hasOwn(step, "uses")) {
          if (typeof step.uses !== "string") {
            throw new Error(`${manifestPath}:runs.steps[${stepIndex}].uses must be a string`);
          }
          if (step.uses.startsWith("./") || step.uses.startsWith("../")) {
            const target = localActionDirectory(
              step.uses,
              directory,
              `${manifestPath}:runs.steps[${stepIndex}].uses`,
            );
            await visitLocalAction(target, [...callers, directory]);
          } else {
            assertPinnedUse(step.uses, manifestPath, `$.runs.steps[${stepIndex}].uses`, false);
          }
        }
        if (Object.hasOwn(step, "run")) {
          if (typeof step.run !== "string") {
            throw new Error(`${manifestPath}:runs.steps[${stepIndex}].run must be a string`);
          }
          await scanExecutionText(step.run, {
            baseDirectory: "",
            location: `${manifestPath}:runs.steps[${stepIndex}].run`,
            packagePath: "package.json",
          });
        }
      }
    } else if (typeof using === "string" && /^node(?:12|16|20|24)$/u.test(using)) {
      for (const key of ["pre", "main", "post"]) {
        if (!Object.hasOwn(runs, key)) continue;
        const entrypoint = repositoryPath(runs[key], directory, `${manifestPath}:runs.${key}`);
        entrypoints.add(entrypoint);
        await visitFile(entrypoint, `${manifestPath}:runs.${key}`, directory, true);
      }
      if (!Object.hasOwn(runs, "main"))
        throw new Error(`${manifestPath}: node action needs runs.main`);
    } else if (using === "docker") {
      if (typeof runs.image !== "string" || /\$\{\{|\$[A-Za-z_]|`/u.test(runs.image)) {
        throw new Error(`${manifestPath}: Docker action image must be a static string`);
      }
      if (!runs.image.startsWith("docker://")) {
        const dockerfile = repositoryPath(runs.image, directory, `${manifestPath}:runs.image`);
        entrypoints.add(dockerfile);
        await visitFile(dockerfile, `${manifestPath}:runs.image`, directory);
      }
    } else {
      throw new Error(`${manifestPath}: unsupported local action runtime ${String(using)}`);
    }
    actionStates.set(directory, "visited");
  }

  async function visitWorkflow(workflowPath, callers = []) {
    const state = workflowStates.get(workflowPath);
    if (state === "visited") return;
    if (state === "visiting") {
      throw new Error(`Local reusable workflow cycle: ${[...callers, workflowPath].join(" -> ")}`);
    }
    const workflow = workflows.get(workflowPath);
    if (!workflow) throw new Error(`Unresolved local reusable workflow ${workflowPath}`);
    workflowStates.set(workflowPath, "visiting");
    const jobs = workflow.jobs;
    if (jobs && typeof jobs === "object" && !Array.isArray(jobs)) {
      for (const [jobName, job] of Object.entries(jobs)) {
        if (!job || typeof job !== "object" || Array.isArray(job)) continue;
        if (Object.hasOwn(job, "uses")) {
          if (typeof job.uses === "string" && isCanonicalLocalReusableWorkflow(job.uses)) {
            await visitWorkflow(job.uses.slice(2), [...callers, workflowPath]);
          }
          continue;
        }
        if (!Array.isArray(job.steps)) continue;
        for (const [stepIndex, step] of job.steps.entries()) {
          if (!step || typeof step !== "object" || Array.isArray(step)) continue;
          if (typeof step.uses === "string" && step.uses.startsWith("./")) {
            const directory = localActionDirectory(
              step.uses,
              ".",
              `${workflowPath}:jobs.${jobName}.steps[${stepIndex}].uses`,
            );
            await visitLocalAction(directory);
          }
          if (Object.hasOwn(step, "run")) {
            if (typeof step.run !== "string") {
              throw new Error(
                `${workflowPath}:jobs.${jobName}.steps[${stepIndex}].run must be a string`,
              );
            }
            const workingDirectory =
              step["working-directory"] ??
              job.defaults?.run?.["working-directory"] ??
              workflow.defaults?.run?.["working-directory"] ??
              "";
            const baseDirectory = repositoryPath(
              workingDirectory || ".",
              "",
              `${workflowPath}:jobs.${jobName}.steps[${stepIndex}].working-directory`,
            );
            await scanExecutionText(step.run, {
              baseDirectory: baseDirectory === "." ? "" : baseDirectory,
              location: `${workflowPath}:jobs.${jobName}.steps[${stepIndex}].run`,
              packagePath: "package.json",
            });
          }
        }
        for (const include of job.strategy?.matrix?.include ?? []) {
          if (include && typeof include === "object" && typeof include.dockerfile === "string") {
            await visitFile(
              repositoryPath(
                include.dockerfile,
                "",
                `${workflowPath}:jobs.${jobName}.strategy.matrix.include.dockerfile`,
              ),
              `${workflowPath}: image Dockerfile`,
            );
          }
        }
      }
    }
    workflowStates.set(workflowPath, "visited");
  }

  for (const packagePath of packagePaths) {
    await readSurface(packagePath, "pnpm package-manager manifest");
  }
  for (const managerPath of PACKAGE_MANAGER_FILES) {
    if (fileSet.has(managerPath)) await readSurface(managerPath, "pnpm package-manager config");
  }
  if (fileSet.has(".dockerignore")) {
    await readSurface(".dockerignore", "image build context config");
  }
  for (const workflowPath of workflowPaths) await visitWorkflow(workflowPath);
  for (const actionDirectory of [...actionManifestByDirectory.keys()].sort()) {
    await visitLocalAction(actionDirectory);
  }

  const localActions = [];
  for (const [directory, manifestPath] of [...actionManifestByDirectory].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const source = await readFile(path.join(canonicalRoot, manifestPath));
    localActions.push({
      directory,
      entrypoints: [...(actionEntrypoints.get(manifestPath) ?? [])].sort(),
      manifest: manifestPath,
      sha256: sha256(source),
    });
  }

  return {
    schemaVersion: EXECUTABLE_SURFACE_SCHEMA_VERSION,
    workflows: workflowPaths.map((workflowPath) => ({
      path: workflowPath,
      sha256: sha256(workflowSources.get(workflowPath)),
    })),
    localActions,
    packageScripts: [...packageScriptNames]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([manifest, names]) => ({ manifest, scripts: [...names].sort() })),
    surfaces: [...surfaceDigests]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([surfacePath, digest]) => ({
        path: surfacePath,
        reasons: [...surfaceReasons.get(surfacePath)].sort(),
        sha256: digest,
      })),
  };
}

export async function writeExecutableSurfaceManifest(root) {
  const filename = path.join(root, EXECUTABLE_SURFACE_MANIFEST_PATH);
  try {
    parseStrictJson(await readFile(filename, "utf8"), EXECUTABLE_SURFACE_MANIFEST_PATH);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw new Error(
        `Refusing to regenerate over an invalid executable-surface manifest at ${EXECUTABLE_SURFACE_MANIFEST_PATH}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const manifest = await createExecutableSurfaceManifest(root);
  await writeFile(filename, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function assertExecutableSurfaceManifest(root) {
  const filename = path.join(root, EXECUTABLE_SURFACE_MANIFEST_PATH);
  let actual;
  try {
    actual = parseStrictJson(await readFile(filename, "utf8"), EXECUTABLE_SURFACE_MANIFEST_PATH);
  } catch (error) {
    throw new Error(
      `Executable-surface manifest is missing or invalid at ${EXECUTABLE_SURFACE_MANIFEST_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const expected = await createExecutableSurfaceManifest(root);
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(
      `Executable-surface manifest drift in the CI executable and image build inventory: ${describeExecutableManifestDrift(actual, expected)}. Regenerate intentionally with \`pnpm policy:manifest\`.`,
    );
  }
  return expected;
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
    if (build.with?.context !== ".") {
      throw new Error(
        `${filename}: image candidate job ${jobName} build context must be exactly . to consume the verified checkout`,
      );
    }
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
  const executableManifest = await assertExecutableSurfaceManifest(root);
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
  const workflowSources = new Map();
  const workflows = new Map();
  for (const filename of workflowFiles) {
    const repositoryFilename = `.github/workflows/${filename}`;
    const source = await readFile(path.join(workflowsRoot, filename), "utf8");
    const workflow = parseWorkflowSource(source, repositoryFilename);
    assertPinnedWorkflow(workflow, repositoryFilename);
    workflowSources.set(repositoryFilename, source);
    workflows.set(repositoryFilename, workflow);
  }
  assertRepositoryImageBuildPolicy(workflows);
  for (const [repositoryFilename, source] of workflowSources) {
    const checkoutRequirements = CANDIDATE_CHECKOUT_REQUIREMENTS.get(repositoryFilename);
    if (checkoutRequirements) {
      assertCandidateCheckoutPolicy(source, repositoryFilename, checkoutRequirements);
    }
    if (repositoryFilename === IMAGE_BUILD_WORKFLOW) {
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
    executableSurfaceCount: executableManifest.surfaces.length,
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
  const command = process.argv[2] ?? "--check";
  const operation =
    command === "--write-executable-manifest"
      ? writeExecutableSurfaceManifest(root)
      : command === "--check" || command === "--check-executable-manifest"
        ? assertRepositoryPolicy(root)
        : Promise.reject(new Error(`Unknown repository policy command: ${command}`));
  operation
    .then((result) => {
      if (command === "--write-executable-manifest") {
        console.log(
          `Wrote ${EXECUTABLE_SURFACE_MANIFEST_PATH}: ${result.workflows.length} workflows, ${result.surfaces.length} executable surfaces`,
        );
        return;
      }
      const { codeowner, executableSurfaceCount, protectedPathCount, workflowCount } = result;
      console.log(
        `Repository policy passed: ${workflowCount} workflows, ${executableSurfaceCount} executable surfaces, ${protectedPathCount} protected paths, owner ${codeowner}`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
