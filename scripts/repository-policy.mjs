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

const CANARY_REGEX = "CAAH30_GITLEAKS_CANARY_[A-Z0-9]{32}";
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
      condition: "OR",
      paths: [CANARY_ALLOWLIST_PATH],
    },
  ],
};
const COMMIT_SHA = /^[0-9a-f]{40}$/iu;
const REMOTE_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const REMOTE_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/u;
const REMOTE_PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/u;
const CODEOWNER_IDENTITY = /^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9_.-]+)?$/;

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
  "packages/auth/**",
  "packages/core/src/{model-oauth,screen-lease,secrets-guard,signup-policy}.{ts,test.ts}",
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
];

const REQUIRED_OWNERSHIP_PROBES = [".github/actions/example/action.yml"];

export function assertPinnedWorkflowSource(source, filename) {
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
  visitWorkflowValue(workflow, filename, "$", new Set());
}

function visitWorkflowValue(value, filename, location, seen) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new Error(`${filename}: cyclic YAML value at ${location}`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      visitWorkflowValue(child, filename, `${location}[${index}]`, seen);
    }
  } else {
    for (const [key, child] of Object.entries(value)) {
      const childLocation = `${location}.${key}`;
      if (key === "uses") assertPinnedUse(child, filename, childLocation);
      visitWorkflowValue(child, filename, childLocation, seen);
    }
  }
  seen.delete(value);
}

function assertPinnedUse(value, filename, location) {
  if (typeof value !== "string") {
    throw new Error(`${filename}: ${location} uses must be a string`);
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
    throw new Error(
      `${filename}: ${location} action or reusable workflow ${value} must use a remote owner/repository path and an exact 40-hex commit SHA`,
    );
  }
}

export function parseCodeowners(source) {
  const rules = [];
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
  for (const filename of workflowFiles) {
    assertPinnedWorkflowSource(
      await readFile(path.join(workflowsRoot, filename), "utf8"),
      `.github/workflows/${filename}`,
    );
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
