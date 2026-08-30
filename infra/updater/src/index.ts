import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { ServerUpdateRun } from "@rakazo/contracts";
import {
  type ComposeUpdateStep,
  chooseUpdateStrategy,
  commitImageTag,
  composeUpArgv,
  composeUpdatePlan,
  DEFAULT_UPDATE_REMOTE,
  GIT_SHA_ENV,
  gitIndexContentDiffArgv,
  gitStatusArgv,
  gitUntrackedFilesArgv,
  gitWorktreeContentDiffArgv,
  hasValidBearerToken,
  IMAGE_TAG_ENV,
  imageRef,
  isGitCommit,
  normalizeUpdateBranch,
  parseGitNameOnly,
  parseGitStatusPorcelain,
  parseLsRemoteReleases,
  repoIdentity,
  resolveTrackedDirtyPaths,
  selectLatestRelease,
  UPDATER_IMAGE_ENV,
  UPDATER_IMAGE_TAG_ENV,
  upsertEnvAssignments,
  validateUpdateRequest,
} from "@rakazo/core";
import { type Context, Hono } from "hono";
import {
  type DeploymentIdentity,
  type DeploymentIdentityState,
  deploymentIdentityAssignments,
  nextDeploymentIdentity,
  readDeploymentIdentityState,
  resolveUpdaterConfig,
  truncateOutput,
  UpdateRefused,
  type UpdaterConfig,
} from "./updater-logic.js";

const STEP_TIMEOUT_MS: Record<string, number> = {
  remote: 30_000,
  fetch: 180_000,
  checkout: 60_000,
  merge: 60_000,
  pull: 600_000,
  recreate: 1_800_000,
  recover: 1_800_000,
};
const DEFAULT_TIMEOUT_MS = 120_000;

export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
}

export type UpdaterCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: Record<string, string> },
) => Promise<CommandResult>;

const PASSTHROUGH_ENV = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
] as const;

/** Child processes get connectivity and Docker settings, never the application's secret-filled env. */
export function commandEnvironment(
  source: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    ...overrides,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
    CI: "1",
  };
}

/**
 * Every command is argv with `shell: false`. A repository URL or a branch reaches git as one
 * argument and reaches Compose not at all, so there is no string a caller can craft that becomes
 * part of a command line, a build argument, or a service definition.
 */
const runCommand: UpdaterCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<CommandResult> =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        shell: false,
        env: commandEnvironment(process.env, options.env),
      },
      (error, stdout, stderr) => {
        const output = truncateOutput(`${stdout}${stderr}`);
        if (!error) {
          resolve({ ok: true, exitCode: 0, output });
          return;
        }
        const exitCode = typeof error.code === "number" ? error.code : null;
        const timedOut = "killed" in error && Boolean(error.killed);
        const reason = timedOut
          ? `Timed out after ${options.timeoutMs}ms (${"signal" in error && error.signal ? String(error.signal) : "killed"}).`
          : error.message;
        resolve({ ok: false, exitCode, output: output ? `${output}\n${reason}` : reason });
      },
    );
  });

export function createUpdaterApp(
  config: UpdaterConfig,
  options: { run?: UpdaterCommandRunner } = {},
) {
  const app = new Hono();
  const run = options.run ?? runCommand;
  const composeTarget = {
    composeFile: config.composeFile,
    envFiles: [config.envFile],
    projectName: config.projectName,
  };
  let running = false;
  let planInFlight: Promise<unknown> | null = null;
  /** Survives API recreate so Settings can confirm apply after the proxy drops. */
  let lastRun: ServerUpdateRun | null = null;

  app.get("/health", (c) => c.json({ ok: true, service: "updater", image: config.image }));

  app.use("*", async (c, next) => {
    if (c.req.path === "/health") {
      await next();
      return;
    }
    if (!hasValidBearerToken(c.req.header("authorization"), config.token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/state", async (c) => {
    try {
      const identity = readDeploymentIdentityState(await readEnvFile(), config.image);
      const checkout = await readCheckout();
      return c.json({
        deployDir: config.deployDir,
        composeFile: config.composeFile,
        image: config.image,
        imageRef: imageRef(config.image, identity.current.applicationImageTag),
        running,
        lastRun,
        currentTag: identity.current.applicationImageTag,
        previousTag: identity.previous?.applicationImageTag ?? null,
        checkout,
      });
    } catch (error) {
      return refusal(c, error);
    }
  });

  app.post("/plan", async (c) => {
    try {
      if (planInFlight !== null) throw new UpdateRefused("A plan is already running.");
      const request = parseRequest(await body(c.req.raw));
      const work = (async () => {
        const identity = readDeploymentIdentityState(await readEnvFile(), config.image);
        const decision = chooseUpdateStrategy(request);
        const checkout = await readCheckout();
        if (decision.strategy === "build") {
          const targetCommit = await resolveRemoteHead(request);
          return {
            strategy: decision.strategy,
            reason: decision.reason,
            currentTag: identity.current.applicationImageTag,
            previousTag: identity.previous?.applicationImageTag ?? null,
            targetTag: null as string | null,
            targetCommit,
            upToDate: upToDateForBuild(
              identity.current.applicationImageTag,
              checkout.commit,
              targetCommit,
              identity.production,
            ),
            checkout,
          };
        }
        const target = await resolveRelease(request.repoUrl);
        return {
          strategy: decision.strategy,
          reason: `${decision.reason} Latest stable release: ${target.releaseTag}.`,
          currentTag: identity.current.applicationImageTag,
          previousTag: identity.previous?.applicationImageTag ?? null,
          targetTag: target.imageTag,
          targetCommit: target.commit,
          upToDate: target.imageTag === identity.current.applicationImageTag,
          checkout,
        };
      })();
      planInFlight = work.finally(() => {
        planInFlight = null;
      });
      return c.json(await work);
    } catch (error) {
      return refusal(c, error);
    }
  });

  app.post("/apply", async (c) => {
    try {
      const request = parseRequest(await body(c.req.raw));
      return c.json(await withRunLock(() => apply(request)));
    } catch (error) {
      return refusal(c, error);
    }
  });

  app.post("/rollback", async (c) => {
    try {
      return c.json(await withRunLock(rollback));
    } catch (error) {
      return refusal(c, error);
    }
  });

  return app;

  async function body(request: Request): Promise<unknown> {
    try {
      return await request.json();
    } catch {
      return {};
    }
  }

  /** The sidecar is its own trust boundary: it re-validates rather than trusting the API's checks. */
  function parseRequest(input: unknown) {
    const source = (input ?? {}) as { repoUrl?: unknown; branch?: unknown };
    const result = validateUpdateRequest(source);
    if ("error" in result) throw new UpdateRefused(result.error);
    return result.request;
  }

  function refusal(c: Context, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, error instanceof UpdateRefused ? 400 : 500);
  }

  async function withRunLock<T>(work: () => Promise<T>): Promise<T> {
    if (running) throw new UpdateRefused("An update is already running.");
    running = true;
    try {
      return await work();
    } finally {
      running = false;
    }
  }

  async function readEnvFile() {
    try {
      return await readFile(config.envFile, "utf8");
    } catch (error) {
      throw new UpdateRefused(
        `Could not read the deployment environment file at ${config.envFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function replaceEnvFile(contents: string, metadata: Awaited<ReturnType<typeof lstat>>) {
    const temporary = `${config.envFile}.rakazo-update-${randomUUID()}`;
    let temporaryFile: Awaited<ReturnType<typeof open>> | null = null;
    let directory: Awaited<ReturnType<typeof open>> | null = null;
    try {
      temporaryFile = await open(temporary, "wx", 0o600);
      await temporaryFile.writeFile(contents, { encoding: "utf8" });
      const currentUid = process.getuid?.();
      const currentGid = process.getgid?.();
      if (metadata.uid !== currentUid || metadata.gid !== currentGid) {
        await temporaryFile.chown(Number(metadata.uid), Number(metadata.gid));
      }
      await temporaryFile.sync();
      await temporaryFile.close();
      temporaryFile = null;
      await rename(temporary, config.envFile);
      if (process.platform !== "win32") {
        directory = await open(path.dirname(config.envFile), "r");
        await directory.sync();
        await directory.close();
        directory = null;
      }
    } finally {
      await temporaryFile?.close().catch(() => undefined);
      await directory?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  async function writeEnvAssignments(
    assignments: Record<string, string>,
    expectedContents?: string,
  ) {
    const [current, metadata] = await Promise.all([readEnvFile(), lstat(config.envFile)]);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new UpdateRefused("The deployment environment must be a regular, non-symlink file.");
    }
    if (expectedContents !== undefined && current !== expectedContents) {
      throw new UpdateRefused("The deployment environment changed while the update was running.");
    }
    const contents = upsertEnvAssignments(current, assignments);
    try {
      await replaceEnvFile(contents, metadata);
    } catch (error) {
      const installed = await readFile(config.envFile, "utf8").catch(() => null);
      if (installed !== null && installed !== current) {
        await replaceEnvFile(current, metadata).catch(() => undefined);
      }
      throw error;
    }
    return { before: current, after: contents };
  }

  async function restoreEnvContents(contents: string, expectedContents: string): Promise<boolean> {
    const [current, metadata] = await Promise.all([
      readFile(config.envFile, "utf8").catch(() => null),
      lstat(config.envFile).catch(() => null),
    ]);
    if (
      current !== expectedContents ||
      metadata === null ||
      !metadata.isFile() ||
      metadata.isSymbolicLink()
    ) {
      return false;
    }
    return replaceEnvFile(contents, metadata).then(
      () => true,
      () => false,
    );
  }

  function git(args: string[], stepId = "read") {
    return run("git", args, {
      cwd: config.deployDir,
      timeoutMs: STEP_TIMEOUT_MS[stepId] ?? DEFAULT_TIMEOUT_MS,
    });
  }

  async function hasCheckout() {
    try {
      await access(path.posix.join(config.deployDir, ".git"));
      return true;
    } catch {
      return false;
    }
  }

  async function readCheckout() {
    if (!(await hasCheckout())) {
      return {
        present: false,
        commit: null,
        branch: null,
        remoteUrl: null,
        dirty: false,
        dirtyPaths: [] as string[],
      };
    }
    const [head, branch, remote, status, untracked] = await Promise.all([
      git(["rev-parse", "HEAD"]),
      git(["rev-parse", "--abbrev-ref", "HEAD"]),
      git(["remote", "get-url", DEFAULT_UPDATE_REMOTE]),
      git(gitStatusArgv()),
      git(gitUntrackedFilesArgv()),
    ]);
    const porcelain = parseGitStatusPorcelain(status.ok ? status.output : "");
    let contentChanged: string[] = [];
    let contentDiffOk = true;
    if (status.ok && !porcelain.clean) {
      const [worktree, index] = await Promise.all([
        git(gitWorktreeContentDiffArgv()),
        git(gitIndexContentDiffArgv()),
      ]);
      contentDiffOk = worktree.ok && index.ok;
      contentChanged = [
        ...parseGitNameOnly(worktree.ok ? worktree.output : ""),
        ...parseGitNameOnly(index.ok ? index.output : ""),
      ];
    }
    const tracked = resolveTrackedDirtyPaths({
      porcelainChanged: porcelain.changed,
      contentChanged,
      contentDiffOk,
      untrackedPaths: parseGitNameOnly(untracked.ok ? untracked.output : ""),
    });
    const stateReadable = status.ok && untracked.ok;
    return {
      present: true,
      commit: head.ok ? head.output.trim() : null,
      branch: branch.ok ? branch.output.trim() : null,
      remoteUrl: remote.ok ? remote.output.trim() : null,
      dirty: stateReadable ? tracked.dirty : true,
      dirtyPaths: stateReadable
        ? tracked.dirtyPaths
        : ["(the updater could not verify the checkout state)"],
    };
  }

  /** `ls-remote` reads the tag list without cloning, so it works for the pull path with no checkout. */
  async function resolveRelease(repoUrl: string) {
    const listed = await run("git", ["ls-remote", "--tags", "--", repoUrl], {
      cwd: config.deployDir,
      timeoutMs: STEP_TIMEOUT_MS.fetch ?? DEFAULT_TIMEOUT_MS,
    });
    if (!listed.ok) {
      throw new UpdateRefused(`Could not read releases from ${repoUrl}: ${listed.output}`);
    }
    const release = selectLatestRelease(parseLsRemoteReleases(listed.output));
    if (release === null) {
      throw new UpdateRefused(
        `${repoUrl} has no published release tags, so there is no image to pull.`,
      );
    }
    return {
      releaseTag: release.tag,
      commit: release.commit,
      imageTag: commitImageTag(release.commit),
    };
  }

  /** The branch head on the remote, read without fetching, so a plan does not mutate the checkout. */
  async function resolveRemoteHead(request: { repoUrl: string; branch: string }) {
    const listed = await run(
      "git",
      ["ls-remote", "--heads", "--", request.repoUrl, request.branch],
      { cwd: config.deployDir, timeoutMs: STEP_TIMEOUT_MS.fetch ?? DEFAULT_TIMEOUT_MS },
    );
    if (!listed.ok) {
      throw new UpdateRefused(`Could not read ${request.branch} from ${request.repoUrl}.`);
    }
    const commit = listed.output.trim().split(/\s/)[0] ?? "";
    if (!isGitCommit(commit)) {
      throw new UpdateRefused(`${request.repoUrl} has no branch called ${request.branch}.`);
    }
    return commit;
  }

  /** A fork is current only when its checkout is on the remote head *and* that build is deployed. */
  function upToDateForBuild(
    currentTag: string,
    commit: string | null,
    targetCommit: string | null,
    production: boolean,
  ) {
    if (commit === null || targetCommit === null || commit !== targetCommit) return false;
    return currentTag === (production ? commitImageTag(commit) : `local-${commit}`);
  }

  async function apply(request: { repoUrl: string; branch: string; official: boolean }) {
    const decision = chooseUpdateStrategy(request);
    const originalEnvContents = await readEnvFile();
    const identity = readDeploymentIdentityState(originalEnvContents, config.image);
    const checkout = await readCheckout();

    if (identity.production) {
      if (!checkout.present || checkout.commit === null) {
        throw new UpdateRefused(
          "A production update requires the deployment source checkout so its revision can transition with the images.",
        );
      }
      if (checkout.commit !== identity.current.revision) {
        throw new UpdateRefused(
          "The production checkout revision does not match the durable deployment identity.",
        );
      }
      if (checkout.dirty) {
        throw new UpdateRefused(
          "The production checkout has changed or untracked source files, or its state could not be verified. Commit, stash, clean, or fix it before updating.",
        );
      }
      if (
        decision.strategy === "pull" &&
        (checkout.remoteUrl === null ||
          repoIdentity(checkout.remoteUrl) !== repoIdentity(request.repoUrl))
      ) {
        throw new UpdateRefused(
          `The production checkout must use the selected repository as its ${DEFAULT_UPDATE_REMOTE} remote before a published-image update.`,
        );
      }
    }

    if (decision.strategy === "build") {
      if (!checkout.present) {
        throw new UpdateRefused(
          "Building a fork needs the deployment's git checkout, and RAKAZO_DEPLOY_DIR has no .git directory. Clone the fork to the deployment directory, or switch back to the official repository to use published images.",
        );
      }
      if (checkout.remoteUrl === null) {
        throw new UpdateRefused(
          `Building a fork needs the deployment checkout to have an ${DEFAULT_UPDATE_REMOTE} remote. Add it or clone the fork again before updating.`,
        );
      }
      if (checkout.dirty) {
        throw new UpdateRefused(
          "The deployment checkout has changed or untracked source files, or its state could not be verified. Commit, stash, clean, or fix it before updating.",
        );
      }
    }

    let targetTag: string | null = null;
    let targetCommit: string | null = null;
    let releaseTag: string | null = null;
    if (decision.strategy === "pull") {
      const target = await resolveRelease(request.repoUrl);
      targetTag = target.imageTag;
      targetCommit = target.commit;
      releaseTag = target.releaseTag;
      if (targetTag === identity.current.applicationImageTag) {
        return rememberRun(upToDateRecord(request, targetTag, "pull", targetCommit));
      }
    } else {
      const remoteHead = await resolveRemoteHead(request);
      if (
        upToDateForBuild(
          identity.current.applicationImageTag,
          checkout.commit,
          remoteHead,
          identity.production,
        )
      ) {
        return rememberRun(
          upToDateRecord(
            request,
            identity.current.applicationImageTag,
            "build",
            identity.current.revision ?? checkout.commit,
          ),
        );
      }
    }
    if (
      identity.production &&
      decision.strategy === "pull" &&
      (releaseTag === null || targetCommit === null)
    ) {
      throw new UpdateRefused("The published update did not resolve an exact release source.");
    }

    const composeSteps =
      decision.strategy === "pull"
        ? composeUpdatePlan({
            strategy: "pull",
            target: composeTarget,
            prepareUpdater: identity.updaterEnabled,
          })
        : composeUpdatePlan({
            strategy: "build",
            target: composeTarget,
            repoUrl: request.repoUrl,
            branch: request.branch,
            repointRemote:
              checkout.remoteUrl === null ||
              repoIdentity(checkout.remoteUrl) !== repoIdentity(request.repoUrl),
            prepareUpdater: identity.updaterEnabled,
          });
    const steps: ComposeUpdateStep[] =
      identity.production && decision.strategy === "pull"
        ? [
            {
              id: "fetch",
              label: `Fetch the source for ${releaseTag}`,
              command: "git",
              args: ["fetch", "--no-tags", DEFAULT_UPDATE_REMOTE, `refs/tags/${releaseTag}`],
            },
            {
              id: "checkout",
              label: `Check out the exact source revision ${targetCommit}`,
              command: "git",
              args: ["checkout", "--detach", targetCommit!],
            },
            ...composeSteps,
          ]
        : composeSteps;

    return rememberRun(
      await execute({
        request,
        strategy: decision.strategy,
        identity,
        originalEnvContents,
        toTag: targetTag,
        fromCheckoutCommit: checkout.commit,
        fromBranch: checkout.branch,
        toCommit: targetCommit,
        restoreRemoteUrl:
          decision.strategy === "build" &&
          checkout.remoteUrl !== null &&
          repoIdentity(checkout.remoteUrl) !== repoIdentity(request.repoUrl)
            ? checkout.remoteUrl
            : null,
        steps,
        restartAdvice:
          decision.strategy === "pull"
            ? `The updater deployed ${releaseTag ?? targetTag} from its full source-commit image tag and recreated the API, worker, and web containers. Migrations ran inside the new API container before it became healthy.`
            : "The updater built the fork and recreated the API, worker, and web containers. Migrations ran inside the new API container before it started serving.",
      }),
    );
  }

  async function rollback(): Promise<ServerUpdateRun> {
    const originalEnvContents = await readEnvFile();
    const identity = readDeploymentIdentityState(originalEnvContents, config.image);
    if (identity.previous === null) {
      throw new UpdateRefused(
        "No previous deployment identity was recorded, so there is nothing to roll back to.",
      );
    }
    if (identity.previous.applicationImageTag === identity.current.applicationImageTag) {
      throw new UpdateRefused("The previous deployment identity is the one already running.");
    }
    const checkout = await readCheckout();
    if (
      identity.production &&
      (!checkout.present ||
        checkout.commit !== identity.current.revision ||
        checkout.dirty ||
        identity.previous.revision === null)
    ) {
      throw new UpdateRefused(
        "The production checkout is not a clean match for the current durable deployment identity.",
      );
    }
    // Never re-pull a rollback tag: registry tags can move. Reuse the exact image cached when it ran.
    const composeSteps = composeUpdatePlan({ strategy: "pull", target: composeTarget }).filter(
      (step) => step.id !== "pull",
    );
    const steps: ComposeUpdateStep[] =
      identity.production && identity.previous.revision !== null
        ? [
            {
              id: "checkout",
              label: `Restore the exact source revision ${identity.previous.revision}`,
              command: "git",
              args: ["checkout", "--detach", identity.previous.revision],
            },
            ...composeSteps,
          ]
        : composeSteps;
    return rememberRun(
      await execute({
        request: { repoUrl: "", branch: "" },
        strategy: "pull",
        identity,
        originalEnvContents,
        toTag: identity.previous.applicationImageTag,
        targetIdentity: identity.previous,
        fromCheckoutCommit: checkout.commit,
        fromBranch: checkout.branch,
        toCommit: identity.previous.revision,
        restoreRemoteUrl: null,
        steps,
        restartAdvice: `Rolled back to ${identity.previous.applicationImageTag}. Database migrations are not reversed: if the newer version added a migration, roll forward again or restore a database backup.`,
      }),
    );
  }

  function rememberRun(record: ServerUpdateRun): ServerUpdateRun {
    lastRun = record;
    return record;
  }

  function composeIdentityEnvironment(
    identity: DeploymentIdentity,
    updaterEnabled: boolean,
  ): Record<string, string> {
    const env: Record<string, string> = {
      [IMAGE_TAG_ENV]: identity.applicationImageTag,
    };
    if (identity.revision !== null) env[GIT_SHA_ENV] = identity.revision;
    if (updaterEnabled) {
      if (identity.updaterImage === null || identity.updaterImageTag === null) {
        throw new UpdateRefused("The enabled updater deployment identity is incomplete.");
      }
      env[UPDATER_IMAGE_ENV] = identity.updaterImage;
      env[UPDATER_IMAGE_TAG_ENV] = identity.updaterImageTag;
    }
    return env;
  }

  /**
   * Commits the full current/previous identity in one durable file replacement, runs the plan, and
   * restores the exact pre-run file plus checkout when a detected failure needs recovery.
   */
  async function execute(input: {
    request: { repoUrl: string; branch: string };
    strategy: "pull" | "build";
    identity: DeploymentIdentityState;
    originalEnvContents: string;
    toTag: string | null;
    targetIdentity?: DeploymentIdentity;
    fromCheckoutCommit: string | null;
    fromBranch: string | null;
    toCommit: string | null;
    restoreRemoteUrl: string | null;
    steps: ComposeUpdateStep[];
    restartAdvice: string;
  }): Promise<ServerUpdateRun> {
    const fromIdentity = input.identity.current;
    const record: ServerUpdateRun = {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      ok: false,
      fromCommit: fromIdentity.revision ?? input.fromCheckoutCommit,
      toCommit: input.toCommit,
      fromTag: fromIdentity.applicationImageTag,
      toTag: input.toTag,
      strategy: input.strategy,
      repoUrl: input.request.repoUrl,
      branch: input.request.branch,
      restart: "not-required",
      restartAdvice: input.restartAdvice,
      error: null,
      steps: [],
    };
    // Build updates may switch branches and/or fast-forward before recreate. Mark the checkout
    // touched as soon as either mutates so a mid-plan failure still restores branch + commit.
    let checkoutTouched = false;
    try {
      const gitSteps = input.steps.filter((step) => step.command === "git");
      const composeSteps = input.steps.filter((step) => step.command !== "git");

      for (const step of gitSteps) {
        if (step.id === "checkout" || step.id === "merge") checkoutTouched = true;
        if (!(await runStep(record, step))) return record;
      }

      // The build path only knows its tag after the fast-forward, because the tag is the commit.
      let toTag = input.toTag;
      if (input.strategy === "build") {
        const head = await git(["rev-parse", "HEAD"]);
        const commit = head.ok ? head.output.trim() : "";
        if (!isGitCommit(commit)) {
          record.error = "Could not read the commit to build.";
          return record;
        }
        record.toCommit = commit;
        toTag = input.identity.production ? commitImageTag(commit) : `local-${commit}`;
        record.toTag = toTag;
      }
      if (toTag === null) {
        record.error = "Could not resolve a target image tag.";
        return record;
      }

      let targetIdentity = input.targetIdentity;
      if (targetIdentity === undefined) {
        if (record.toCommit === null || !isGitCommit(record.toCommit)) {
          record.error = "Could not resolve an exact target source revision.";
          return record;
        }
        targetIdentity = nextDeploymentIdentity(input.identity, record.toCommit, toTag);
      }
      if (
        input.identity.production &&
        (targetIdentity.revision === null || !isGitCommit(targetIdentity.revision))
      ) {
        record.error = "Could not resolve an exact target source revision.";
        return record;
      }
      record.toCommit = targetIdentity.revision ?? record.toCommit;

      let envWrite: { before: string; after: string };
      try {
        envWrite = await writeEnvAssignments(
          deploymentIdentityAssignments(
            targetIdentity,
            fromIdentity,
            input.identity.updaterEnabled,
          ),
          input.originalEnvContents,
        );
      } catch {
        record.error = "Could not persist the target deployment identity atomically.";
        record.restartAdvice = `${record.error} Nothing was recreated.`;
        return record;
      }
      const composeEnv = composeIdentityEnvironment(targetIdentity, input.identity.updaterEnabled);

      for (const step of composeSteps) {
        if (!(await runStep(record, step, composeEnv))) {
          const primaryError = record.error ?? `${step.label} failed.`;
          const envRestored = await restoreEnvContents(envWrite.before, envWrite.after);
          if (step.id === "recreate") {
            const previous = composeUpArgv(composeTarget);
            const recovered = await runStep(
              record,
              {
                id: "recover",
                label: `Restore the previously running ${fromIdentity.applicationImageTag} image`,
                command: previous.command,
                args: previous.args,
              },
              composeIdentityEnvironment(fromIdentity, input.identity.updaterEnabled),
              false,
            );
            record.restart = recovered ? "not-required" : "manual";
            record.restartAdvice = recovered
              ? `${primaryError} The updater restored the previously running ${fromIdentity.applicationImageTag} image${envRestored ? " and its durable deployment identity" : ", but could not restore the durable deployment identity"}. Read the failed step output before retrying.`
              : `${primaryError} Automatic recovery to ${fromIdentity.applicationImageTag} also failed${envRestored ? "" : ", and the durable deployment identity could not be restored"}. The runtime may contain a mix of versions; use the recorded commands and the previous full source SHA to recover it manually.`;
          } else {
            record.restartAdvice = `${primaryError} No service was recreated${envRestored ? ", and the prior durable deployment identity was restored" : ", but the prior durable deployment identity could not be restored"}. Read the failed step output before retrying.`;
          }
          record.error = primaryError;
          return record;
        }
      }
      record.ok = true;
      record.restart = input.identity.updaterEnabled ? "manual" : "recreated";
      if (input.identity.updaterEnabled) {
        record.restartAdvice = `${record.restartAdvice} The exact updater image ${targetIdentity.updaterImage}:${targetIdentity.updaterImageTag} is downloaded and durably pinned, but the updater cannot replace itself while reporting this run. Restart the updater service, then rerun production preflight and verify health revision ${targetIdentity.revision}.`;
      }
      return record;
    } finally {
      if (
        !record.ok &&
        checkoutTouched &&
        input.fromCheckoutCommit !== null &&
        isGitCommit(input.fromCheckoutCommit)
      ) {
        const restored = await runStep(
          record,
          {
            id: "restore-checkout",
            label: "Restore the previous checkout",
            command: "git",
            args: restoreCheckoutArgv(input.fromBranch, input.fromCheckoutCommit),
          },
          undefined,
          false,
        );
        if (!restored) {
          record.restartAdvice = `${record.restartAdvice} The previous checkout also could not be restored; fix it before retrying.`;
        }
      }
      if (!record.ok && input.restoreRemoteUrl !== null) {
        const restored = await runStep(
          record,
          {
            id: "restore-remote",
            label: `Restore the previous ${DEFAULT_UPDATE_REMOTE} remote`,
            command: "git",
            args: ["remote", "set-url", DEFAULT_UPDATE_REMOTE, input.restoreRemoteUrl],
          },
          undefined,
          false,
        );
        if (!restored) {
          record.restartAdvice = `${record.restartAdvice} The previous Git remote also could not be restored; fix it before retrying.`;
        }
      }
      record.finishedAt = new Date().toISOString();
    }
  }

  async function runStep(
    record: ServerUpdateRun,
    step: ComposeUpdateStep,
    env?: Record<string, string>,
    setError = true,
  ) {
    const result = await run(step.command, step.args, {
      cwd: config.deployDir,
      timeoutMs: STEP_TIMEOUT_MS[step.id] ?? DEFAULT_TIMEOUT_MS,
      env: step.command === "docker" ? { COMPOSE_PROJECT_NAME: config.projectName, ...env } : env,
    });
    record.steps.push({
      id: step.id,
      label: step.label,
      ok: result.ok,
      exitCode: result.exitCode,
      output: result.output,
    });
    if (!result.ok && setError) record.error = `${step.label} failed.`;
    return result.ok;
  }

  function upToDateRecord(
    request: { repoUrl: string; branch: string },
    tag: string,
    strategy: "pull" | "build",
    commit: string | null,
  ): ServerUpdateRun {
    const now = new Date().toISOString();
    return {
      startedAt: now,
      finishedAt: now,
      ok: true,
      fromCommit: commit,
      toCommit: commit,
      fromTag: tag,
      toTag: tag,
      strategy,
      repoUrl: request.repoUrl,
      branch: request.branch,
      restart: "not-required",
      restartAdvice: `Already running ${tag}; nothing was changed.`,
      error: null,
      steps: [],
    };
  }
}

function startUpdater() {
  const config = resolveUpdaterConfig(process.env);
  const app = createUpdaterApp(config);
  return serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
    console.log(`rakazo updater on http://${config.host}:${config.port} for ${config.deployDir}`);
  });
}

/**
 * Put the worktree back on the pre-update branch and commit. `checkout -B` restores a named
 * branch; detached checkouts must use `--detach` so recovery cannot attach to the update target
 * branch and move that tip to the old commit.
 */
export function restoreCheckoutArgv(fromBranch: string | null, fromCommit: string): string[] {
  if (!isGitCommit(fromCommit)) throw new Error("Checkout restore needs a resolved commit.");
  if (fromBranch !== null && fromBranch !== "HEAD") {
    const branch = normalizeUpdateBranch(fromBranch);
    if (!("error" in branch)) return ["checkout", "-B", branch.branch, fromCommit];
  }
  return ["checkout", "--detach", fromCommit];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startUpdater();
}
