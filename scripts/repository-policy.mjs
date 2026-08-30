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
  IMAGE_BUILD_WORKFLOW,
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
        if (Object.hasOwn(step, "run")) {
          if (typeof step.run !== "string") {
            throw new Error(`${location}.run: workflow run commands must be strings`);
          }
          const imageCommand = findImageBuildCommand(step.run, `${location}.run`);
          if (imageCommand) {
            throw new Error(
              `${location}.run: direct image-building command ${imageCommand} is forbidden; only exact manifested build-push-action steps may build images`,
            );
          }
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

const SHELL_COMMAND_SEPARATORS = new Set([";", "&", "|", "(", ")", "{", "}"]);
const SHELL_RESERVED_PREFIXES = new Set([
  "!",
  "do",
  "elif",
  "else",
  "if",
  "then",
  "time",
  "until",
  "while",
]);
const SHELL_TRANSPARENT_WRAPPERS = new Set(["command", "exec", "nohup", "sudo"]);
const SHELL_BUILD_WORDS = new Set(["bake", "bud", "build"]);
const SHELL_WRAPPER_OPTIONS_WITH_VALUES = new Map([
  ["env", new Set(["-C", "--chdir", "-u", "--unset"])],
  [
    "sudo",
    new Set([
      "-C",
      "--close-from",
      "-g",
      "--group",
      "-h",
      "--host",
      "-p",
      "--prompt",
      "-R",
      "--chroot",
      "-T",
      "--command-timeout",
      "-u",
      "--user",
    ]),
  ],
]);
const IMAGE_CLI_OPTIONS_WITH_VALUES = new Set([
  "--ansi",
  "--builder",
  "-c",
  "--config",
  "--connection",
  "--context",
  "--env-file",
  "-f",
  "--file",
  "-H",
  "--host",
  "--identity",
  "-l",
  "--log-level",
  "-p",
  "--parallel",
  "--profile",
  "--progress",
  "--project-directory",
  "--project-name",
  "--tlscacert",
  "--tlscert",
  "--tlskey",
  "--url",
]);

function findImageBuildCommand(source, location, depth = 0) {
  if (depth > 8) {
    throw new Error(`${location}: ambiguous nested shell command exceeds the inventory limit`);
  }
  const commands = tokenizeShellCommands(source, location, (nested, nestedKind) => {
    const nestedBuild = findImageBuildCommand(nested, `${location}:${nestedKind}`, depth + 1);
    if (nestedBuild) {
      throw new Error(
        `${location}: nested direct image-building command ${nestedBuild} is forbidden`,
      );
    }
  });
  for (const command of commands) {
    const match = classifyImageBuildCommand(command, location, depth);
    if (match) return match;
  }
  return undefined;
}

function tokenizeShellCommands(source, location, inspectNested) {
  const commands = [];
  let command = [];
  let current;
  let quote;

  function startWord() {
    current ??= { dynamic: false, kind: "word", value: "" };
    return current;
  }

  function finishWord() {
    if (!current) return;
    command.push(current);
    current = undefined;
  }

  function finishCommand() {
    finishWord();
    if (command.length > 0) commands.push(command);
    command = [];
  }

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote === "single") {
      if (character === "'") quote = undefined;
      else startWord().value += character;
      continue;
    }
    if (quote === "double") {
      if (character === '"') {
        quote = undefined;
        continue;
      }
      if (character === "\\") {
        const escaped = source[index + 1];
        if (escaped === "\n") index += 1;
        else if (escaped !== undefined) {
          startWord().value += escaped;
          index += 1;
        }
        continue;
      }
      if (character === "$" || character === "`") {
        index = consumeShellExpansion(source, index, startWord(), location, inspectNested);
        continue;
      }
      startWord().value += character;
      continue;
    }

    if (character === "'" || character === '"') {
      startWord();
      quote = character === "'" ? "single" : "double";
      continue;
    }
    if (character === "\\") {
      const escaped = source[index + 1];
      if (escaped === "\n") index += 1;
      else if (escaped !== undefined) {
        startWord().value += escaped;
        index += 1;
      }
      continue;
    }
    if (character === "$" || character === "`") {
      index = consumeShellExpansion(source, index, startWord(), location, inspectNested);
      continue;
    }
    if (character === "#" && !current) {
      while (index + 1 < source.length && source[index + 1] !== "\n") index += 1;
      continue;
    }
    if (character === "\n") {
      finishCommand();
      continue;
    }
    if (/\s/u.test(character)) {
      finishWord();
      continue;
    }
    if (character === "<" || character === ">") {
      if (current?.value && /^\d+$/u.test(current.value)) current = undefined;
      else finishWord();
      let operator = character;
      while (source[index + 1] === character) {
        operator += source[index + 1];
        index += 1;
      }
      if (source[index + 1] === "&") {
        operator += "&";
        index += 1;
      }
      command.push({ dynamic: false, kind: "redirect", value: operator });
      continue;
    }
    if (SHELL_COMMAND_SEPARATORS.has(character)) {
      finishCommand();
      if (source[index + 1] === character) index += 1;
      continue;
    }
    startWord().value += character;
  }

  if (quote) throw new Error(`${location}: ambiguous shell command has an unterminated quote`);
  finishCommand();
  return commands;
}

function consumeShellExpansion(source, index, word, location, inspectNested) {
  if (source[index] === "`") {
    const end = findUnescaped(source, "`", index + 1);
    if (end < 0) throw new Error(`${location}: ambiguous shell command has an open backtick`);
    inspectNested(source.slice(index + 1, end), "backtick");
    word.dynamic = true;
    word.value += "<dynamic>";
    return end;
  }
  if (source.startsWith("${{", index)) {
    const end = source.indexOf("}}", index + 3);
    if (end < 0) throw new Error(`${location}: ambiguous GitHub expression in shell command`);
    word.dynamic = true;
    word.value += "<dynamic>";
    return end + 1;
  }
  if (source.startsWith("$(", index)) {
    const balanced = readCommandSubstitution(source, index, location);
    inspectNested(balanced.content, "command-substitution");
    word.dynamic = true;
    word.value += "<dynamic>";
    return balanced.end;
  }
  if (source.startsWith("${", index)) {
    const end = source.indexOf("}", index + 2);
    if (end < 0) throw new Error(`${location}: ambiguous shell parameter expansion`);
    word.dynamic = true;
    word.value += "<dynamic>";
    return end;
  }
  const variable = /^\$[A-Za-z_][A-Za-z0-9_]*/u.exec(source.slice(index));
  word.dynamic = true;
  word.value += "<dynamic>";
  return variable ? index + variable[0].length - 1 : index;
}

function readCommandSubstitution(source, start, location) {
  let depth = 1;
  let quote;
  for (let index = start + 2; index < source.length; index += 1) {
    const character = source[index];
    if (quote === "single") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      if (character === "\\") index += 1;
      else if (character === '"') quote = undefined;
      continue;
    }
    if (character === "'") quote = "single";
    else if (character === '"') quote = "double";
    else if (character === "\\") index += 1;
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return { content: source.slice(start + 2, index), end: index };
    }
  }
  throw new Error(`${location}: ambiguous shell command has an open command substitution`);
}

function findUnescaped(source, character, start) {
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "\\") index += 1;
    else if (source[index] === character) return index;
  }
  return -1;
}

function classifyImageBuildCommand(tokens, location, depth) {
  const words = [];
  let discardRedirectTarget = false;
  for (const token of tokens) {
    if (token.kind === "redirect") {
      discardRedirectTarget = true;
      continue;
    }
    if (discardRedirectTarget) {
      discardRedirectTarget = false;
      continue;
    }
    words.push(token);
  }

  let index = 0;
  while (index < words.length) {
    const value = words[index].value.toLowerCase();
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index].value)) index += 1;
    else if (SHELL_RESERVED_PREFIXES.has(value)) index += 1;
    else break;
  }
  if (index >= words.length) return undefined;

  let executable = shellExecutable(words[index].value);
  if (words[index].dynamic) {
    if (words.slice(index + 1).some((word) => SHELL_BUILD_WORDS.has(word.value.toLowerCase()))) {
      throw new Error(
        `${location}: ambiguous dynamic shell executable can resolve to an image-building command`,
      );
    }
    return undefined;
  }

  while (SHELL_TRANSPARENT_WRAPPERS.has(executable) || executable === "env") {
    index += 1;
    while (index < words.length) {
      const value = words[index].value;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(value)) {
        index += 1;
        continue;
      }
      if (!value.startsWith("-")) break;
      const option = value.split("=", 1)[0];
      index += 1;
      if (!value.includes("=") && SHELL_WRAPPER_OPTIONS_WITH_VALUES.get(executable)?.has(option)) {
        index += 1;
      }
    }
    if (index >= words.length) return undefined;
    if (words[index].dynamic) {
      if (words.slice(index + 1).some((word) => SHELL_BUILD_WORDS.has(word.value.toLowerCase()))) {
        throw new Error(`${location}: ambiguous command wrapper can invoke an image build`);
      }
      return undefined;
    }
    executable = shellExecutable(words[index].value);
  }

  if (executable === "eval") {
    const arguments_ = words.slice(index + 1);
    if (arguments_.some((word) => word.dynamic)) {
      throw new Error(`${location}: ambiguous dynamic eval can hide an image-building command`);
    }
    return findImageBuildCommand(
      arguments_.map((word) => word.value).join(" "),
      `${location}:eval`,
      depth + 1,
    );
  }
  if (["bash", "cmd", "dash", "ksh", "powershell", "pwsh", "sh", "zsh"].includes(executable)) {
    const commandFlag = words.findIndex(
      (word, wordIndex) =>
        wordIndex > index && ["-c", "-command", "/c"].includes(word.value.toLowerCase()),
    );
    if (commandFlag >= 0) {
      const nested = words[commandFlag + 1];
      if (!nested || nested.dynamic) {
        throw new Error(`${location}: ambiguous nested shell can hide an image-building command`);
      }
      return findImageBuildCommand(nested.value, `${location}:${executable}`, depth + 1);
    }
    return undefined;
  }

  if (executable === "xargs") {
    const nestedIndex = words.findIndex(
      (word, wordIndex) => wordIndex > index && !word.value.startsWith("-"),
    );
    return nestedIndex < 0
      ? undefined
      : classifyImageBuildCommand(words.slice(nestedIndex), `${location}:xargs`, depth + 1);
  }

  if (executable === "docker" || executable === "podman" || executable === "nerdctl") {
    const primary = shellSubcommand(words, index + 1, location, executable);
    if (!primary) return undefined;
    if (primary.value === "build") return `${executable} build`;
    if (["builder", "buildx", "compose", "image"].includes(primary.value)) {
      const secondary = shellSubcommand(words, primary.index + 1, location, executable);
      if (secondary && (secondary.value === "build" || secondary.value === "bake")) {
        return `${executable} ${primary.value} ${secondary.value}`;
      }
      if (
        primary.value === "compose" &&
        secondary &&
        hasImageBuildFlag(words, secondary.index + 1)
      ) {
        return `${executable} compose ${secondary.value} --build`;
      }
    }
    return undefined;
  }
  if (executable === "docker-compose") {
    const subcommand = shellSubcommand(words, index + 1, location, executable);
    if (subcommand?.value === "build") return "docker-compose build";
    return subcommand && hasImageBuildFlag(words, subcommand.index + 1)
      ? `docker-compose ${subcommand.value} --build`
      : undefined;
  }
  if (executable === "buildah") {
    const subcommand = shellSubcommand(words, index + 1, location, executable);
    return subcommand && ["bud", "build", "build-using-dockerfile"].includes(subcommand.value)
      ? `buildah ${subcommand.value}`
      : undefined;
  }
  if (["buildctl", "ko", "pack"].includes(executable)) {
    const subcommand = shellSubcommand(words, index + 1, location, executable);
    return subcommand?.value === "build" ? `${executable} build` : undefined;
  }
  return executable === "executor" && /(?:^|\/)kaniko(?:\/|$)/u.test(words[index].value)
    ? "kaniko executor"
    : undefined;
}

function shellExecutable(value) {
  return (value.split(/[\\/]/u).pop() ?? value).replace(/\.exe$/iu, "").toLowerCase();
}

function shellSubcommand(words, start, location, executable) {
  for (let index = start; index < words.length; index += 1) {
    const word = words[index];
    if (word.dynamic) {
      throw new Error(
        `${location}: ambiguous dynamic ${executable} subcommand can resolve to an image build`,
      );
    }
    if (word.value === "--") continue;
    if (word.value.startsWith("-")) {
      const option = word.value.split("=", 1)[0];
      if (!word.value.includes("=") && IMAGE_CLI_OPTIONS_WITH_VALUES.has(option)) index += 1;
      continue;
    }
    return { index, value: word.value.toLowerCase() };
  }
  return undefined;
}

function hasImageBuildFlag(words, start) {
  return words
    .slice(start)
    .some((word) => word.value === "--build" || word.value.startsWith("--build="));
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
