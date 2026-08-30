import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ServerUpdateRun } from "@rakazo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createHealthPayload } from "../../apps/api/src/health.js";
import { createUpdaterApp, type UpdaterCommandRunner } from "../updater/src/index.js";
import { resolveUpdaterConfig } from "../updater/src/updater-logic.js";
import { readEnvFile, verifyBackupSnapshot, writeBackupManifest } from "./backup-metadata.mjs";
import {
  type ComposeModel,
  renderComposeConfig,
  validateProductionPreflight,
} from "./deployment-preflight.js";
import { deterministicSecretFixture } from "./secret-fixtures.js";

const token = deterministicSecretFixture("identity-transaction-updater");
const deploymentId = "0198f2ce-7d11-7a41-8b5c-7d1dfd62c551";
const applicationImage = "ghcr.io/example/rakazo/app";
const updaterImage = "ghcr.io/example/rakazo/updater";
const revisionA = "a".repeat(40);
const revisionB = "b".repeat(40);
const revisionC = "c".repeat(40);
const revisionZ = "9".repeat(40);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

interface DurableIdentity {
  revision: string;
  imageTag: string;
  updaterImage: string | null;
  updaterImageTag: string | null;
}

interface DeploymentFixture {
  deployDir: string;
  envFile: string;
  config: ReturnType<typeof resolveUpdaterConfig>;
  checkout: { revision: string; branch: string };
}

interface CapturedCall {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function identity(revision: string, updaterEnabled: boolean): DurableIdentity {
  return {
    revision,
    imageTag: `sha-${revision}`,
    updaterImage: updaterEnabled ? updaterImage : null,
    updaterImageTag: updaterEnabled ? `sha-${revision}` : null,
  };
}

function productionEnvironment(
  current: DurableIdentity,
  previous: DurableIdentity | null,
  updaterEnabled: boolean,
): Record<string, string> {
  return {
    NODE_ENV: "production",
    CORTEXAI_DEPLOYMENT_ID: deploymentId,
    POSTGRES_PASSWORD: deterministicSecretFixture("identity-transaction-postgres"),
    BETTER_AUTH_SECRET: deterministicSecretFixture("identity-transaction-auth"),
    ENCRYPTION_KEY: deterministicSecretFixture("identity-transaction-encryption"),
    SCREEN_PROXY_SECRET: deterministicSecretFixture("identity-transaction-screen"),
    CORTEXAI_BACKUP_ENCRYPTION_KEY: deterministicSecretFixture("identity-transaction-backup"),
    E2B_API_KEY: deterministicSecretFixture("identity-transaction-provider"),
    SANDBOX_PROVIDER: "e2b",
    CORTEXAI_BACKUP_TARGET: "s3://fake-backup-bucket/tenant-a",
    RAKAZO_HOST: "app.example.test",
    WEB_ORIGIN: "https://app.example.test",
    BETTER_AUTH_URL: "https://app.example.test",
    API_URL: "https://app.example.test",
    RAKAZO_IMAGE: applicationImage,
    GIT_SHA: current.revision,
    RAKAZO_IMAGE_TAG: current.imageTag,
    ...(previous === null
      ? {}
      : {
          GIT_SHA_PREVIOUS: previous.revision,
          RAKAZO_IMAGE_TAG_PREVIOUS: previous.imageTag,
        }),
    ...(updaterEnabled
      ? {
          RAKAZO_UPDATER_TOKEN: token,
          RAKAZO_UPDATER_IMAGE: current.updaterImage!,
          RAKAZO_UPDATER_IMAGE_TAG: current.updaterImageTag!,
          ...(previous === null
            ? {}
            : {
                RAKAZO_UPDATER_IMAGE_PREVIOUS: previous.updaterImage!,
                RAKAZO_UPDATER_IMAGE_TAG_PREVIOUS: previous.updaterImageTag!,
              }),
        }
      : {}),
  };
}

async function deployment(
  currentRevision: string,
  options: { previousRevision?: string; updaterEnabled?: boolean } = {},
): Promise<DeploymentFixture> {
  const updaterEnabled = options.updaterEnabled ?? true;
  const deployDir = await mkdtemp(path.join(os.tmpdir(), "rakazo-identity-transaction-"));
  temporaryDirectories.push(deployDir);
  const composeDirectory = path.join(deployDir, "infra", "compose");
  await mkdir(composeDirectory, { recursive: true });
  await mkdir(path.join(deployDir, ".git"));
  await copyFile(
    path.resolve("infra/compose/docker-compose.prod.yml"),
    path.join(composeDirectory, "docker-compose.prod.yml"),
  );
  const environment = productionEnvironment(
    identity(currentRevision, updaterEnabled),
    options.previousRevision ? identity(options.previousRevision, updaterEnabled) : null,
    updaterEnabled,
  );
  environment.RAKAZO_DEPLOY_DIR = deployDir;
  const envFile = path.join(deployDir, ".env");
  await writeFile(envFile, renderEnvironment(environment), { mode: 0o600 });
  return {
    deployDir,
    envFile,
    config: resolveUpdaterConfig({
      RAKAZO_DEPLOY_DIR: deployDir,
      RAKAZO_UPDATER_TOKEN: token,
      RAKAZO_IMAGE: applicationImage,
    }),
    checkout: { revision: currentRevision, branch: "main" },
  };
}

function renderEnvironment(environment: Record<string, string>): string {
  return `${Object.entries(environment)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;
}

function updaterRequest(app: ReturnType<typeof createUpdaterApp>, route: string) {
  return app.request(route, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body:
      route === "/apply"
        ? JSON.stringify({ repoUrl: "https://github.com/elie222/rakazo", branch: "main" })
        : undefined,
  });
}

function releaseRunner(
  fixture: DeploymentFixture,
  targetRevision: () => string,
  calls: CapturedCall[],
  failFirstRecreate = false,
): UpdaterCommandRunner {
  let upCalls = 0;
  return async (command, args, options) => {
    calls.push({ command, args, env: options.env });
    if (command === "git") {
      const joined = args.join(" ");
      if (args.includes("ls-remote")) {
        return { ok: true, exitCode: 0, output: `${targetRevision()}\trefs/tags/v1.2.3\n` };
      }
      if (joined === "rev-parse HEAD") {
        return { ok: true, exitCode: 0, output: fixture.checkout.revision };
      }
      if (joined === "rev-parse --abbrev-ref HEAD") {
        return { ok: true, exitCode: 0, output: fixture.checkout.branch };
      }
      if (joined === "remote get-url origin") {
        return {
          ok: true,
          exitCode: 0,
          output: "https://github.com/elie222/rakazo",
        };
      }
      if (args[0] === "checkout") {
        fixture.checkout.revision = args.at(-1)!;
        fixture.checkout.branch = args.includes("--detach") ? "HEAD" : (args[2] ?? "HEAD");
      }
      return { ok: true, exitCode: 0, output: "" };
    }
    if (args.includes("up")) {
      upCalls += 1;
      if (failFirstRecreate && upCalls === 1) {
        return { ok: false, exitCode: 1, output: "new API did not become healthy" };
      }
    }
    return { ok: true, exitCode: 0, output: "ok" };
  };
}

async function readDurableEnvironment(fixture: DeploymentFixture): Promise<Record<string, string>> {
  return readEnvFile(fixture.envFile) as Record<string, string>;
}

function expectIdentity(
  environment: Record<string, string>,
  currentRevision: string,
  previousRevision: string,
  updaterEnabled: boolean,
) {
  expect.soft(environment).toMatchObject({
    GIT_SHA: currentRevision,
    RAKAZO_IMAGE_TAG: `sha-${currentRevision}`,
    GIT_SHA_PREVIOUS: previousRevision,
    RAKAZO_IMAGE_TAG_PREVIOUS: `sha-${previousRevision}`,
  });
  if (updaterEnabled) {
    expect.soft(environment).toMatchObject({
      RAKAZO_UPDATER_IMAGE: updaterImage,
      RAKAZO_UPDATER_IMAGE_TAG: `sha-${currentRevision}`,
      RAKAZO_UPDATER_IMAGE_PREVIOUS: updaterImage,
      RAKAZO_UPDATER_IMAGE_TAG_PREVIOUS: `sha-${previousRevision}`,
    });
  } else {
    for (const name of [
      "RAKAZO_UPDATER_IMAGE",
      "RAKAZO_UPDATER_IMAGE_TAG",
      "RAKAZO_UPDATER_IMAGE_PREVIOUS",
      "RAKAZO_UPDATER_IMAGE_TAG_PREVIOUS",
    ]) {
      expect.soft(environment[name]).toBeUndefined();
    }
  }
}

function expectChildIdentity(
  call: CapturedCall,
  expectedRevision: string,
  updaterEnabled: boolean,
) {
  expect.soft(call.env).toMatchObject({
    GIT_SHA: expectedRevision,
    RAKAZO_IMAGE_TAG: `sha-${expectedRevision}`,
  });
  if (updaterEnabled) {
    expect.soft(call.env).toMatchObject({
      RAKAZO_UPDATER_IMAGE: updaterImage,
      RAKAZO_UPDATER_IMAGE_TAG: `sha-${expectedRevision}`,
    });
  } else {
    expect.soft(call.env?.RAKAZO_UPDATER_IMAGE).toBeUndefined();
    expect.soft(call.env?.RAKAZO_UPDATER_IMAGE_TAG).toBeUndefined();
  }
}

async function verifyProductionSurfaces(
  fixture: DeploymentFixture,
  expectedRevision: string,
  updaterEnabled: boolean,
) {
  const environment = await readDurableEnvironment(fixture);
  const compose = renderComposeConfig(
    (command, args, options) => {
      const result = spawnSync(command, args, options);
      return { status: result.status, stdout: result.stdout ?? "" };
    },
    {
      cwd: fixture.deployDir,
      envFile: fixture.envFile,
      composeFile: fixture.config.composeFile,
      env: { ...process.env, ...environment },
    },
  );
  expectRenderedIdentity(compose, expectedRevision, updaterEnabled);
  expect.soft(fixture.checkout.revision).toBe(expectedRevision);

  const apiRevision = String(compose.services.api?.environment?.GIT_SHA ?? "");
  expect
    .soft(
      createHealthPayload({
        deploymentId,
        revision: apiRevision,
        runtime: "pi",
        sandbox: "e2b",
        composio: false,
        pipedream: false,
        jobs: "graphile",
        realtime: "postgres",
      }).revision,
    )
    .toBe(expectedRevision);

  expect
    .soft(
      validateProductionPreflight({
        env: environment,
        host: {
          architecture: "x64",
          totalMemoryBytes: 8 * 1024 ** 3,
          freeDiskBytes: 80 * 1024 ** 3,
          currentRevision: fixture.checkout.revision,
          sourceClean: true,
          sourceIndexFlagsClear: true,
          publicOriginResolved: true,
        },
        compose,
      }).ok,
    )
    .toBe(true);

  const snapshot = await mkdtemp(path.join(os.tmpdir(), "rakazo-identity-backup-"));
  temporaryDirectories.push(snapshot);
  await chmod(snapshot, 0o700);
  await writeFile(path.join(snapshot, "rakazo.dump"), "database bytes\n", { mode: 0o600 });
  await writeFile(path.join(snapshot, "appdata.tgz"), "application bytes\n", { mode: 0o600 });
  const manifest = writeBackupManifest(snapshot, environment, "2026-08-30T12:00:00.000Z");
  expect.soft(manifest).toMatchObject({
    revision: expectedRevision,
    imageTag: `sha-${expectedRevision}`,
  });
  expect.soft(verifyBackupSnapshot(snapshot, environment)).toMatchObject({
    revision: expectedRevision,
    imageTag: `sha-${expectedRevision}`,
  });
}

function expectRenderedIdentity(
  compose: ComposeModel,
  expectedRevision: string,
  updaterEnabled: boolean,
) {
  for (const service of ["api", "worker", "web"] as const) {
    expect
      .soft(compose.services[service]?.image)
      .toBe(`${applicationImage}:sha-${expectedRevision}`);
  }
  expect.soft(compose.services.api?.environment?.GIT_SHA).toBe(expectedRevision);
  expect.soft(compose.services.worker?.environment?.GIT_SHA).toBe(expectedRevision);
  if (updaterEnabled) {
    expect.soft(compose.services.updater?.image).toBe(`${updaterImage}:sha-${expectedRevision}`);
  }
}

describe("production deployment identity transaction", () => {
  it("commits A→B across durable state, Compose, health, backup, and preflight", async () => {
    const fixture = await deployment(revisionA);
    const calls: CapturedCall[] = [];
    const response = await updaterRequest(
      createUpdaterApp(fixture.config, { run: releaseRunner(fixture, () => revisionB, calls) }),
      "/apply",
    );
    const record = (await response.json()) as ServerUpdateRun;

    expect.soft(record).toMatchObject({
      ok: true,
      fromCommit: revisionA,
      toCommit: revisionB,
      fromTag: `sha-${revisionA}`,
      toTag: `sha-${revisionB}`,
      restart: "manual",
    });
    expect.soft(record.restartAdvice).toMatch(/updater.*sha.*restart/i);
    expect(calls.some(({ args }) => args.join(" ") === `checkout --detach ${revisionB}`)).toBe(
      true,
    );
    expectIdentity(await readDurableEnvironment(fixture), revisionB, revisionA, true);
    for (const call of calls.filter(({ command }) => command === "docker")) {
      expectChildIdentity(call, revisionB, true);
    }
    await verifyProductionSurfaces(fixture, revisionB, true);
  });

  it("restores coherent A identity and recovery commands after a failed B recreate", async () => {
    const fixture = await deployment(revisionA, { previousRevision: revisionZ });
    const calls: CapturedCall[] = [];
    const response = await updaterRequest(
      createUpdaterApp(fixture.config, {
        run: releaseRunner(fixture, () => revisionB, calls, true),
      }),
      "/apply",
    );
    const record = (await response.json()) as ServerUpdateRun;

    expect(record).toMatchObject({
      ok: false,
      fromCommit: revisionA,
      toCommit: revisionB,
      fromTag: `sha-${revisionA}`,
      toTag: `sha-${revisionB}`,
      restart: "not-required",
    });
    expectIdentity(await readDurableEnvironment(fixture), revisionA, revisionZ, true);
    const recovery = calls.find(({ args }) => args.includes("up") && args.includes("--no-build"));
    const recreateCalls = calls.filter(({ args }) => args.includes("up"));
    expect(recreateCalls).toHaveLength(2);
    expectChildIdentity(recreateCalls[0]!, revisionB, true);
    expectChildIdentity(recreateCalls[1]!, revisionA, true);
    expect(calls.some(({ args }) => args.join(" ") === `checkout -B main ${revisionA}`)).toBe(true);
    expect(recovery).toBeDefined();
    await verifyProductionSurfaces(fixture, revisionA, true);
  });

  it("rolls B→A into coherent current=A and previous=B state", async () => {
    const fixture = await deployment(revisionB, { previousRevision: revisionA });
    const calls: CapturedCall[] = [];
    const run = releaseRunner(fixture, () => revisionA, calls);
    const response = await updaterRequest(createUpdaterApp(fixture.config, { run }), "/rollback");
    const record = (await response.json()) as ServerUpdateRun;

    expect(record).toMatchObject({
      ok: true,
      fromCommit: revisionB,
      toCommit: revisionA,
      fromTag: `sha-${revisionB}`,
      toTag: `sha-${revisionA}`,
      restart: "manual",
    });
    expectIdentity(await readDurableEnvironment(fixture), revisionA, revisionB, true);
    expect(calls.some(({ args }) => args.includes("pull"))).toBe(false);
    expect(calls.some(({ args }) => args.join(" ") === `checkout --detach ${revisionA}`)).toBe(
      true,
    );
    expectChildIdentity(calls.find(({ args }) => args.includes("up"))!, revisionA, true);
    await verifyProductionSurfaces(fixture, revisionA, true);
  });

  it("keeps only B as previous across sequential A→B→C updates", async () => {
    const fixture = await deployment(revisionA);
    const calls: CapturedCall[] = [];
    let targetRevision = revisionB;
    const app = createUpdaterApp(fixture.config, {
      run: releaseRunner(fixture, () => targetRevision, calls),
    });

    expect(((await (await updaterRequest(app, "/apply")).json()) as ServerUpdateRun).ok).toBe(true);
    targetRevision = revisionC;
    expect(((await (await updaterRequest(app, "/apply")).json()) as ServerUpdateRun).ok).toBe(true);

    const environment = await readDurableEnvironment(fixture);
    expectIdentity(environment, revisionC, revisionB, true);
    expect(JSON.stringify(environment)).not.toContain(revisionA);
    await verifyProductionSurfaces(fixture, revisionC, true);
  });

  it("transitions the exact enabled updater sibling but adds no updater pin when disabled", async () => {
    const enabled = await deployment(revisionA);
    const enabledCalls: CapturedCall[] = [];
    await updaterRequest(
      createUpdaterApp(enabled.config, {
        run: releaseRunner(enabled, () => revisionB, enabledCalls),
      }),
      "/apply",
    );
    expect(enabledCalls.find(({ args }) => args.includes("pull"))?.args.includes("updater")).toBe(
      true,
    );
    expectIdentity(await readDurableEnvironment(enabled), revisionB, revisionA, true);
    expectChildIdentity(enabledCalls.find(({ args }) => args.includes("up"))!, revisionB, true);

    const disabled = await deployment(revisionA, { updaterEnabled: false });
    const disabledCalls: CapturedCall[] = [];
    const response = await updaterRequest(
      createUpdaterApp(disabled.config, {
        run: releaseRunner(disabled, () => revisionB, disabledCalls),
      }),
      "/apply",
    );
    expect((await response.json()) as ServerUpdateRun).toMatchObject({
      ok: true,
      restart: "recreated",
    });
    expect(disabledCalls.find(({ args }) => args.includes("pull"))?.args.includes("updater")).toBe(
      false,
    );
    expectIdentity(await readDurableEnvironment(disabled), revisionB, revisionA, false);
    expectChildIdentity(disabledCalls.find(({ args }) => args.includes("up"))!, revisionB, false);
    await verifyProductionSurfaces(disabled, revisionB, false);
  });

  it("fails closed on legacy partial production identity instead of mixing revisions", async () => {
    const fixture = await deployment(revisionA, { previousRevision: revisionZ });
    const environment = await readDurableEnvironment(fixture);
    delete environment.GIT_SHA_PREVIOUS;
    delete environment.RAKAZO_UPDATER_IMAGE_PREVIOUS;
    delete environment.RAKAZO_UPDATER_IMAGE_TAG_PREVIOUS;
    await writeFile(fixture.envFile, renderEnvironment(environment), { mode: 0o600 });

    const response = await createUpdaterApp(fixture.config).request("/state", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: expect.stringMatching(/incomplete.*deployment identity/i),
    });
  });
});
