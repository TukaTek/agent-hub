import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import { minimatch } from "minimatch";
import { parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";

export const CODEOWNER = "@acepgh";
export const CANARY_RULE_ID = "rakazo-gitleaks-canary";
export const GITLEAKS_CANARY_PATH = "scripts/fixtures/gitleaks-canary.txt";
export const SOURCE_TREE_MANIFEST_PATH = ".github/ci-executable-surface.json";
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
const EXPECTED_WORKFLOW_PATHS = Object.freeze([
  ".github/workflows/ci.yml",
  ".github/workflows/nightly-verification.yml",
  ".github/workflows/playwright.yml",
  ".github/workflows/publish-playwright-report.yml",
  ".github/workflows/publish-server-image.yml",
  ".github/workflows/release-desktop.yml",
]);

const PROTECTED_FILE_GLOBS = [
  ".github/CODEOWNERS",
  SOURCE_TREE_MANIFEST_PATH,
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
  SOURCE_TREE_MANIFEST_PATH,
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

const SOURCE_TREE_MANIFEST_SCHEMA_VERSION = 2;
const SOURCE_TREE_MANIFEST_EXCLUSIONS = Object.freeze([SOURCE_TREE_MANIFEST_PATH]);
const REGULAR_GIT_MODES = new Set(["100644", "100755"]);
const SHA256_DIGEST = /^[0-9a-f]{64}$/u;
const GIT_INDEX_RECORD = /^([0-9]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/u;
const MANIFEST_TOP_LEVEL_KEYS = [
  "entries",
  "entryCount",
  "exclusions",
  "schemaVersion",
  "treeSha256",
];
const MANIFEST_ENTRY_KEYS = ["byteLength", "gitMode", "gitType", "path", "sha256"];

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function gitFailure(result, operation) {
  const detail = Buffer.isBuffer(result.stderr)
    ? new TextDecoder("utf-8", { fatal: false }).decode(result.stderr).trim()
    : String(result.stderr ?? "").trim();
  const cause = result.error instanceof Error ? result.error.message : detail;
  return new Error(
    `${operation} failed closed because Git metadata is required${cause ? `: ${cause}` : ""}`,
  );
}

function runGit(root, arguments_) {
  const result = spawnSync("git", ["-C", root, ...arguments_], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw gitFailure(result, `git ${arguments_.join(" ")}`);
  }
  return result.stdout;
}

function decodeUtf8(source, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch (error) {
    throw new Error(
      `${label} must be valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function canonicalGitRoot(root) {
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    throw new Error(
      "Repository root is missing or inaccessible: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const reportedRoot = decodeUtf8(
    runGit(canonicalRoot, ["rev-parse", "--show-toplevel"]),
    "Git repository root",
  ).replace(/\r?\n$/u, "");
  let canonicalReportedRoot;
  try {
    canonicalReportedRoot = await realpath(reportedRoot);
  } catch (error) {
    throw new Error(
      "Git reported an inaccessible repository root: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  if (canonicalReportedRoot !== canonicalRoot) {
    throw new Error(
      "Repository policy must run at the Git toplevel; expected " +
        canonicalReportedRoot +
        ", received " +
        canonicalRoot,
    );
  }
  return canonicalRoot;
}

function gitTypeForMode(mode, repositoryPath) {
  if (REGULAR_GIT_MODES.has(mode)) return "blob";
  if (mode === "120000") {
    throw new Error(`Tracked symlinks are forbidden by source-tree policy: ${repositoryPath}`);
  }
  if (mode === "160000") {
    throw new Error(
      `Tracked gitlinks/submodules are forbidden by source-tree policy: ${repositoryPath}`,
    );
  }
  throw new Error(`Non-regular tracked Git mode ${mode} is forbidden: ${repositoryPath}`);
}

function newPathValidationState() {
  return {
    exact: new Set(),
    caseFolded: new Map(),
    unicodeNormalized: new Map(),
  };
}

function validateTrackedRepositoryPath(repositoryPath, state) {
  if (
    repositoryPath.length === 0 ||
    repositoryPath.includes("\\") ||
    repositoryPath.startsWith("/") ||
    repositoryPath.endsWith("/") ||
    repositoryPath.includes("//") ||
    repositoryPath === "." ||
    repositoryPath === ".." ||
    repositoryPath.startsWith("../") ||
    path.posix.normalize(repositoryPath) !== repositoryPath
  ) {
    throw new Error(
      `Tracked path must be a normalized in-root POSIX path: ${JSON.stringify(repositoryPath)}`,
    );
  }
  if (state.exact.has(repositoryPath)) {
    throw new Error(`Duplicate tracked path: ${JSON.stringify(repositoryPath)}`);
  }

  const unicodeNormalized = repositoryPath.normalize("NFC");
  const normalizedOwner = state.unicodeNormalized.get(unicodeNormalized);
  if (normalizedOwner && normalizedOwner !== repositoryPath) {
    throw new Error(
      "Unicode-normalization tracked path collision: " +
        JSON.stringify(normalizedOwner) +
        " and " +
        JSON.stringify(repositoryPath),
    );
  }
  const caseFolded = unicodeNormalized.toUpperCase().toLowerCase();
  const caseOwner = state.caseFolded.get(caseFolded);
  if (caseOwner && caseOwner !== repositoryPath) {
    throw new Error(
      "Case-fold tracked path collision: " +
        JSON.stringify(caseOwner) +
        " and " +
        JSON.stringify(repositoryPath),
    );
  }
  if (repositoryPath !== unicodeNormalized) {
    throw new Error(
      `Tracked path must use Unicode NFC normalization: ${JSON.stringify(repositoryPath)}`,
    );
  }

  state.exact.add(repositoryPath);
  state.unicodeNormalized.set(unicodeNormalized, repositoryPath);
  state.caseFolded.set(caseFolded, repositoryPath);
  return repositoryPath;
}

export function parseGitTrackedEntries(indexOutput) {
  if (!Buffer.isBuffer(indexOutput)) {
    throw new Error("Git tracked-entry inventory must be provided as bytes");
  }
  const entries = [];
  const paths = newPathValidationState();
  let offset = 0;
  while (offset < indexOutput.length) {
    const terminator = indexOutput.indexOf(0, offset);
    if (terminator < 0) {
      throw new Error("git ls-files output is missing a NUL record terminator");
    }
    const record = indexOutput.subarray(offset, terminator);
    offset = terminator + 1;
    if (record.length === 0) {
      throw new Error("git ls-files output contains an empty record");
    }
    const separator = record.indexOf(0x09);
    if (separator < 0) {
      throw new Error("git ls-files output contains a malformed stage record");
    }
    const metadata = decodeUtf8(record.subarray(0, separator), "Git index metadata");
    const match = GIT_INDEX_RECORD.exec(metadata);
    if (!match) {
      throw new Error(`git ls-files output contains invalid index metadata: ${metadata}`);
    }
    if (match[3] !== "0") {
      throw new Error("Unmerged tracked entry is forbidden in source-tree policy");
    }
    const repositoryPath = validateTrackedRepositoryPath(
      decodeUtf8(record.subarray(separator + 1), "Tracked repository path"),
      paths,
    );
    const gitMode = match[1];
    entries.push({
      path: repositoryPath,
      gitMode,
      gitType: gitTypeForMode(gitMode, repositoryPath),
    });
  }
  entries.sort((left, right) => compareUtf8(left.path, right.path));
  return entries;
}

async function readTrackedRepositoryEntries(root) {
  const canonicalRoot = await canonicalGitRoot(root);
  const indexOutput = runGit(canonicalRoot, ["ls-files", "--stage", "-z"]);
  return {
    canonicalRoot,
    entries: parseGitTrackedEntries(indexOutput),
  };
}

async function contentBindTrackedEntry(canonicalRoot, trackedEntry) {
  const absolute = path.resolve(canonicalRoot, trackedEntry.path);
  if (absolute === canonicalRoot || !absolute.startsWith(canonicalRoot + path.sep)) {
    throw new Error(`Tracked path resolves outside the repository root: ${trackedEntry.path}`);
  }
  const info = await lstat(absolute).catch(() => undefined);
  if (!info) {
    throw new Error(`Tracked file is missing from the checkout: ${trackedEntry.path}`);
  }
  if (info.isSymbolicLink()) {
    throw new Error(`Tracked symlinks are forbidden by source-tree policy: ${trackedEntry.path}`);
  }
  if (!info.isFile()) {
    throw new Error(`Tracked entry must be a regular file: ${trackedEntry.path}`);
  }
  const resolved = await realpath(absolute);
  if (!resolved.startsWith(canonicalRoot + path.sep)) {
    throw new Error(`Tracked file resolves outside the repository root: ${trackedEntry.path}`);
  }
  if (process.platform !== "win32") {
    const executable = (info.mode & 0o111) !== 0;
    const expectedExecutable = trackedEntry.gitMode === "100755";
    if (executable !== expectedExecutable) {
      throw new Error(
        "Tracked file mode drift for " +
          trackedEntry.path +
          ": Git mode " +
          trackedEntry.gitMode +
          ", checkout executable=" +
          String(executable),
      );
    }
  }
  const content = await readFile(absolute);
  return {
    path: trackedEntry.path,
    gitMode: trackedEntry.gitMode,
    gitType: trackedEntry.gitType,
    byteLength: content.byteLength,
    sha256: sha256(content),
  };
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

function sourceTreeDigest(entries) {
  return sha256(Buffer.from(JSON.stringify(entries), "utf8"));
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactObjectKeys(value, expectedKeys, label) {
  if (!plainObject(value)) throw new Error(`${label} must be a JSON object`);
  const actualKeys = Object.keys(value).sort();
  if (!isDeepStrictEqual(actualKeys, [...expectedKeys].sort())) {
    throw new Error(
      label +
        " must contain exactly keys " +
        expectedKeys.join(", ") +
        "; found " +
        actualKeys.join(", "),
    );
  }
}

export function assertSourceTreeManifestShape(manifest) {
  exactObjectKeys(manifest, MANIFEST_TOP_LEVEL_KEYS, "Source-tree manifest");
  if (manifest.schemaVersion !== SOURCE_TREE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Source-tree manifest schemaVersion must be ${SOURCE_TREE_MANIFEST_SCHEMA_VERSION}`,
    );
  }
  if (
    !Array.isArray(manifest.exclusions) ||
    !isDeepStrictEqual(manifest.exclusions, [...SOURCE_TREE_MANIFEST_EXCLUSIONS])
  ) {
    throw new Error(`Source-tree manifest must exclude only ${SOURCE_TREE_MANIFEST_PATH}`);
  }
  if (!Number.isSafeInteger(manifest.entryCount) || manifest.entryCount < 0) {
    throw new Error("Source-tree manifest entryCount must be a non-negative safe integer");
  }
  if (!SHA256_DIGEST.test(manifest.treeSha256)) {
    throw new Error("Source-tree manifest treeSha256 must be a lowercase SHA-256 digest");
  }
  if (!Array.isArray(manifest.entries)) {
    throw new Error("Source-tree manifest entries must be an array");
  }
  if (manifest.entryCount !== manifest.entries.length) {
    throw new Error("Source-tree manifest entryCount does not match entries.length");
  }

  const paths = newPathValidationState();
  let previousPath;
  for (const [index, entry] of manifest.entries.entries()) {
    const label = `Source-tree manifest entries[${index}]`;
    exactObjectKeys(entry, MANIFEST_ENTRY_KEYS, label);
    validateTrackedRepositoryPath(entry.path, paths);
    if (entry.path === SOURCE_TREE_MANIFEST_PATH) {
      throw new Error("Source-tree manifest must not contain its self-excluded path");
    }
    if (previousPath !== undefined && compareUtf8(previousPath, entry.path) >= 0) {
      throw new Error("Source-tree manifest entries must use deterministic UTF-8 path ordering");
    }
    previousPath = entry.path;
    if (!REGULAR_GIT_MODES.has(entry.gitMode)) {
      throw new Error(`${label} has a forbidden or invalid Git mode`);
    }
    if (entry.gitType !== "blob") {
      throw new Error(`${label} Git type must be blob`);
    }
    if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) {
      throw new Error(`${label} byteLength must be a non-negative safe integer`);
    }
    if (!SHA256_DIGEST.test(entry.sha256)) {
      throw new Error(`${label} sha256 must be a lowercase SHA-256 digest`);
    }
  }
  if (sourceTreeDigest(manifest.entries) !== manifest.treeSha256) {
    throw new Error("Source-tree manifest treeSha256 does not match its entries");
  }
  return manifest;
}

export async function createSourceTreeManifest(root) {
  const { canonicalRoot, entries: trackedEntries } = await readTrackedRepositoryEntries(root);
  const entries = [];
  for (const trackedEntry of trackedEntries) {
    if (trackedEntry.path === SOURCE_TREE_MANIFEST_PATH) continue;
    entries.push(await contentBindTrackedEntry(canonicalRoot, trackedEntry));
  }
  const manifest = {
    schemaVersion: SOURCE_TREE_MANIFEST_SCHEMA_VERSION,
    exclusions: [...SOURCE_TREE_MANIFEST_EXCLUSIONS],
    entryCount: entries.length,
    treeSha256: sourceTreeDigest(entries),
    entries,
  };
  return assertSourceTreeManifestShape(manifest);
}

function describeSourceTreeManifestDrift(actual, expected) {
  const actualByPath = new Map(actual.entries.map((entry) => [entry.path, entry]));
  const expectedByPath = new Map(expected.entries.map((entry) => [entry.path, entry]));
  for (const repositoryPath of expectedByPath.keys()) {
    if (!actualByPath.has(repositoryPath)) {
      return `tracked file added or renamed: ${repositoryPath}`;
    }
  }
  for (const repositoryPath of actualByPath.keys()) {
    if (!expectedByPath.has(repositoryPath)) {
      return `tracked file removed or renamed: ${repositoryPath}`;
    }
  }
  for (const [repositoryPath, expectedEntry] of expectedByPath) {
    const actualEntry = actualByPath.get(repositoryPath);
    if (actualEntry.gitMode !== expectedEntry.gitMode) {
      return `tracked Git mode drift: ${repositoryPath}`;
    }
    if (actualEntry.gitType !== expectedEntry.gitType) {
      return `tracked Git type drift: ${repositoryPath}`;
    }
    if (actualEntry.byteLength !== expectedEntry.byteLength) {
      return `tracked content drift (byte length): ${repositoryPath}`;
    }
    if (actualEntry.sha256 !== expectedEntry.sha256) {
      return `tracked content drift: ${repositoryPath}`;
    }
  }
  return "source-tree manifest metadata or ordering drift";
}

async function readExistingManifestForRegeneration(filename) {
  const info = await lstat(filename).catch(() => undefined);
  if (!info) return undefined;
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(
      "Refusing to regenerate over a non-regular source-tree manifest at " +
        SOURCE_TREE_MANIFEST_PATH,
    );
  }
  let manifest;
  try {
    manifest = parseStrictJson(await readFile(filename, "utf8"), SOURCE_TREE_MANIFEST_PATH);
  } catch (error) {
    throw new Error(
      "Refusing to regenerate over an invalid source-tree manifest at " +
        SOURCE_TREE_MANIFEST_PATH +
        ": " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  return manifest;
}

export async function writeSourceTreeManifest(root) {
  const filename = path.join(root, SOURCE_TREE_MANIFEST_PATH);
  await readExistingManifestForRegeneration(filename);
  const manifest = await createSourceTreeManifest(root);
  await writeFile(filename, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function assertManifestIsTracked(root) {
  runGit(root, ["ls-files", "--error-unmatch", "--", SOURCE_TREE_MANIFEST_PATH]);
}

export async function assertSourceTreeManifest(root) {
  const filename = path.join(root, SOURCE_TREE_MANIFEST_PATH);
  const info = await lstat(filename).catch(() => undefined);
  if (!info || info.isSymbolicLink() || !info.isFile()) {
    throw new Error(
      `Source-tree manifest is missing or non-regular at ${SOURCE_TREE_MANIFEST_PATH}`,
    );
  }
  let actual;
  try {
    actual = parseStrictJson(await readFile(filename, "utf8"), SOURCE_TREE_MANIFEST_PATH);
    assertSourceTreeManifestShape(actual);
  } catch (error) {
    throw new Error(
      "Source-tree manifest is invalid at " +
        SOURCE_TREE_MANIFEST_PATH +
        ": " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  assertManifestIsTracked(root);
  const expected = await createSourceTreeManifest(root);
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(
      "Source-tree manifest drift: " +
        describeSourceTreeManifestDrift(actual, expected) +
        ". Regenerate intentionally with pnpm policy:manifest.",
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

export function assertSourceTreeManifestCodeowner(source) {
  const rules = parseCodeowners(source);
  const exactPattern = `/${SOURCE_TREE_MANIFEST_PATH}`;
  const matches = rules.filter((rule) => rule.pattern === exactPattern);
  if (
    matches.length !== 1 ||
    matches[0].owners.length !== 1 ||
    matches[0].owners[0] !== CODEOWNER
  ) {
    throw new Error(
      `${SOURCE_TREE_MANIFEST_PATH} must have one exact CODEOWNERS rule owned only by ${CODEOWNER}`,
    );
  }
  const effectiveOwners = effectiveCodeowners(rules, SOURCE_TREE_MANIFEST_PATH);
  if (!isDeepStrictEqual(effectiveOwners, [CODEOWNER])) {
    throw new Error(
      `${SOURCE_TREE_MANIFEST_PATH} must remain effectively owned only by ${CODEOWNER}`,
    );
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
  const sourceTreeManifest = await assertSourceTreeManifest(root);
  const trackedFiles = sourceTreeManifest.entries.map((entry) => entry.path);
  const workflowPaths = trackedFiles
    .filter((filename) => filename.startsWith(".github/workflows/") && /\.ya?ml$/iu.test(filename))
    .sort();
  if (!isDeepStrictEqual(workflowPaths, [...EXPECTED_WORKFLOW_PATHS])) {
    throw new Error(
      `Tracked GitHub Actions workflow set must be exactly ${EXPECTED_WORKFLOW_PATHS.join(", ")}; found ${workflowPaths.join(", ") || "none"}`,
    );
  }
  const workflowSources = new Map();
  const workflows = new Map();
  for (const repositoryFilename of workflowPaths) {
    const source = await readFile(path.join(root, repositoryFilename), "utf8");
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

  const protectedPaths = new Set([...REQUIRED_PROTECTED_PATHS, ...REQUIRED_OWNERSHIP_PROBES]);
  for (const filename of trackedFiles) {
    if (PROTECTED_FILE_GLOBS.some((glob) => minimatch(filename, glob, { dot: true }))) {
      protectedPaths.add(filename);
    }
  }
  for (const filename of REQUIRED_PROTECTED_PATHS) {
    const info = await stat(path.join(root, filename)).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`Required protected file is missing: ${filename}`);
  }

  const codeownersSource = await readFile(path.join(root, ".github/CODEOWNERS"), "utf8");
  assertSourceTreeManifestCodeowner(codeownersSource);
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
    sourceTreeEntryCount: sourceTreeManifest.entryCount,
    sourceTreeSha256: sourceTreeManifest.treeSha256,
    workflowCount: workflowPaths.length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const command = process.argv[2] ?? "--check";
  const operation =
    command === "--write-source-tree-manifest"
      ? writeSourceTreeManifest(root)
      : command === "--check" || command === "--check-source-tree-manifest"
        ? assertRepositoryPolicy(root)
        : Promise.reject(new Error(`Unknown repository policy command: ${command}`));
  operation
    .then((result) => {
      if (command === "--write-source-tree-manifest") {
        console.log(
          `Wrote ${SOURCE_TREE_MANIFEST_PATH}: ${result.entryCount} tracked regular files, tree SHA-256 ${result.treeSha256}; the manifest itself is the only exclusion`,
        );
        return;
      }
      const {
        codeowner,
        protectedPathCount,
        sourceTreeEntryCount,
        sourceTreeSha256,
        workflowCount,
      } = result;
      console.log(
        `Repository policy passed: ${workflowCount} exact workflows, ${sourceTreeEntryCount} tracked regular files, tree SHA-256 ${sourceTreeSha256}, ${protectedPathCount} protected paths, manifest owner ${codeowner}`,
      );
      console.log(
        "Conservative pilot governance: every tracked byte or Git mode change requires refreshing the CODEOWNED manifest; this is whole-tree binding, not shell understanding.",
      );
      console.log(
        "Live branch protection remains required to enforce manifest-owner review; repository files cannot enforce their own approval.",
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
