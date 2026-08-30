import { describe, expect, it, vi } from "vitest";
import {
  type ComposeModel,
  createDeploymentManifest,
  type PreflightInput,
  renderComposeConfig,
  validateProductionPreflight,
} from "./deployment-preflight.js";
import { deterministicSecretFixture } from "./secret-fixtures.js";

const revision = "22d7eb598c3cc72c047025df6d7a72d3612067a9";
const deploymentId = "0198f2ce-7d11-7a41-8b5c-7d1dfd62c551";
const gib = 1024 ** 3;

const validSecrets = {
  POSTGRES_PASSWORD: deterministicSecretFixture("postgres"),
  BETTER_AUTH_SECRET: deterministicSecretFixture("auth"),
  ENCRYPTION_KEY: deterministicSecretFixture("encryption"),
  SCREEN_PROXY_SECRET: deterministicSecretFixture("screen"),
  CORTEXAI_BACKUP_ENCRYPTION_KEY: deterministicSecretFixture("backup"),
  E2B_API_KEY: deterministicSecretFixture("provider"),
};

function composeModel(): ComposeModel {
  return {
    services: {
      postgres: { image: "postgres:16@sha256:abc", networks: ["data"] },
      api: {
        image: `ghcr.io/example/app:sha-${revision}`,
        environment: { SANDBOX_PROVIDER: "e2b", CORTEXAI_DEPLOYMENT_ID: deploymentId },
        networks: ["app", "data", "control"],
      },
      worker: {
        image: `ghcr.io/example/app:sha-${revision}`,
        environment: { SANDBOX_PROVIDER: "e2b", CORTEXAI_DEPLOYMENT_ID: deploymentId },
        networks: ["app", "data"],
      },
      web: { image: `ghcr.io/example/app:sha-${revision}`, networks: ["edge", "app"] },
      updater: { image: "ghcr.io/example/updater:sha-safe", networks: ["control"] },
      caddy: {
        image: "caddy:2@sha256:def",
        ports: [
          { target: 80, published: "80", protocol: "tcp" },
          { target: 443, published: "443", protocol: "tcp" },
          { target: 443, published: "443", protocol: "udp" },
        ],
        networks: ["edge", "app"],
      },
    },
    networks: { edge: {}, app: {}, control: {}, data: { internal: true } },
  };
}

function validInput(): PreflightInput {
  return {
    env: {
      NODE_ENV: "production",
      CORTEXAI_DEPLOYMENT_ID: deploymentId,
      WEB_ORIGIN: "https://app.example.test",
      BETTER_AUTH_URL: "https://app.example.test",
      API_URL: "https://app.example.test",
      SANDBOX_PROVIDER: "e2b",
      CORTEXAI_BACKUP_TARGET: "s3://fake-backup-bucket/tenant-a",
      RAKAZO_IMAGE: "ghcr.io/example/app",
      RAKAZO_IMAGE_TAG: `sha-${revision}`,
      GIT_SHA: revision,
      ...validSecrets,
    },
    host: {
      architecture: "x64",
      totalMemoryBytes: 8 * gib,
      freeDiskBytes: 80 * gib,
      currentRevision: revision,
      sourceClean: true,
      publicOriginResolved: true,
    },
    compose: composeModel(),
  };
}

function failureSubjects(input: PreflightInput): string[] {
  return validateProductionPreflight(input)
    .checks.filter((check) => check.status !== "ok")
    .map((check) => check.subject);
}

describe("validateProductionPreflight", () => {
  it("refuses to certify a non-production environment", () => {
    const input = validInput();
    input.env.NODE_ENV = "development";
    expect(failureSubjects(input)).toContain("NODE_ENV");
  });

  it.each([undefined, "", "bad-id", ` ${deploymentId}`])(
    "fails closed for missing or malformed deployment identity %j",
    (value) => {
      const input = validInput();
      input.env.CORTEXAI_DEPLOYMENT_ID = value;
      expect(failureSubjects(input)).toContain("CORTEXAI_DEPLOYMENT_ID");
    },
  );

  it.each([
    ["missing", undefined],
    ["short", "too-short"],
    ["placeholder", "replace-with-32-plus-character-secret"],
  ])("rejects a %s critical secret without exposing it", (_kind, value) => {
    const input = validInput();
    input.env.BETTER_AUTH_SECRET = value;
    const result = validateProductionPreflight(input);
    expect(failureSubjects(input)).toContain("BETTER_AUTH_SECRET");
    expect(JSON.stringify(result)).not.toContain(value ?? "value-that-is-not-present");
  });

  it("rejects reused critical secrets and reports names only", () => {
    const input = validInput();
    input.env.SCREEN_PROXY_SECRET = input.env.BETTER_AUTH_SECRET;
    const result = validateProductionPreflight(input);
    expect(failureSubjects(input)).toEqual(
      expect.arrayContaining(["BETTER_AUTH_SECRET", "SCREEN_PROXY_SECRET"]),
    );
    expect(JSON.stringify(result)).not.toContain(input.env.BETTER_AUTH_SECRET!);
  });

  it.each([
    ["non-HTTPS", { WEB_ORIGIN: "http://app.example.test" }],
    ["inconsistent", { API_URL: "https://api.example.test" }],
    ["malformed", { BETTER_AUTH_URL: "not a URL" }],
  ])("rejects %s public origins", (_kind, override) => {
    const input = validInput();
    Object.assign(input.env, override);
    expect(failureSubjects(input)).toContain("public-origins");
  });

  it.each(["fake", "desktop", "none", "docker", undefined])(
    "rejects unsafe production sandbox provider %j",
    (provider) => {
      const input = validInput();
      input.env.SANDBOX_PROVIDER = provider;
      expect(failureSubjects(input)).toContain("SANDBOX_PROVIDER");
    },
  );

  it.each([
    ["e2b", "E2B_API_KEY"],
    ["daytona", "DAYTONA_API_KEY"],
    ["box", "BOX_API_KEY"],
  ])("requires the selected %s provider key", (provider, key) => {
    const input = validInput();
    input.env.SANDBOX_PROVIDER = provider;
    input.compose.services.api!.environment!.SANDBOX_PROVIDER = provider;
    input.compose.services.worker!.environment!.SANDBOX_PROVIDER = provider;
    delete input.env.E2B_API_KEY;
    expect(failureSubjects(input)).toContain(key);
  });

  it.each([
    ["missing target", { CORTEXAI_BACKUP_TARGET: undefined }],
    ["local target", { CORTEXAI_BACKUP_TARGET: "file:///var/backups/rakazo" }],
    ["missing encryption", { CORTEXAI_BACKUP_ENCRYPTION_KEY: undefined }],
  ])("rejects an unsafe backup configuration: %s", (_kind, override) => {
    const input = validInput();
    Object.assign(input.env, override);
    expect(failureSubjects(input)).toContain("off-host-backup");
  });

  it.each([
    ["short revision", { GIT_SHA: "22d7eb5" }],
    ["moving tag", { RAKAZO_IMAGE_TAG: "latest" }],
    ["wrong checkout", {}, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  ])("rejects an invalid source/image pin: %s", (_kind, override, currentRevision) => {
    const input = validInput();
    Object.assign(input.env, override);
    if (currentRevision) input.host.currentRevision = currentRevision;
    expect(failureSubjects(input)).toContain("source-revision");
  });

  it("rejects a dirty source checkout", () => {
    const input = validInput();
    input.host.sourceClean = false;
    expect(failureSubjects(input)).toContain("source-revision");
  });

  it.each([
    ["memory", { totalMemoryBytes: 2 * gib }],
    ["disk", { freeDiskBytes: 8 * gib }],
    ["architecture", { architecture: "ia32" }],
    ["DNS", { publicOriginResolved: false }],
  ])("rejects insufficient or unsupported host %s", (subject, override) => {
    const input = validInput();
    Object.assign(input.host, override);
    expect(failureSubjects(input)).toContain(`host-${subject.toLowerCase()}`);
  });

  it("rejects host-published internal service ports", () => {
    const input = validInput();
    input.compose.services.postgres!.ports = [{ target: 5432, published: "5432", protocol: "tcp" }];
    expect(failureSubjects(input)).toContain("compose-public-ports");
  });

  it("rejects public ports other than 80 and 443", () => {
    const input = validInput();
    input.compose.services.caddy!.ports!.push({
      target: 5173,
      published: "5173",
      protocol: "tcp",
    });
    expect(failureSubjects(input)).toContain("compose-public-ports");
  });

  it("rejects missing private networks and identity/provider drift across API and worker", () => {
    const input = validInput();
    input.compose.networks.data = {};
    input.compose.services.worker!.environment!.CORTEXAI_DEPLOYMENT_ID =
      "0198f2ce-7d11-7a41-8b5c-7d1dfd62c552";
    expect(failureSubjects(input)).toEqual(
      expect.arrayContaining(["compose-private-networks", "compose-runtime-identity"]),
    );
  });

  it("rejects an internal service attached to the public edge network", () => {
    const input = validInput();
    input.compose.services.postgres!.networks = ["data", "edge"];
    expect(failureSubjects(input)).toContain("compose-private-networks");
  });

  it("returns a safe manifest for a valid production deployment", () => {
    const input = validInput();
    const result = validateProductionPreflight(input);
    expect(result.ok).toBe(true);
    expect(createDeploymentManifest(input)).toEqual({
      schemaVersion: 1,
      deploymentId,
      revision,
      image: { name: "ghcr.io/example/app", tag: `sha-${revision}` },
      provider: { kind: "e2b" },
      backup: { targetClass: "s3" },
      topology: { publicPorts: ["80/tcp", "443/tcp", "443/udp"] },
    });
    for (const value of Object.values(validSecrets)) {
      expect(JSON.stringify(result)).not.toContain(value);
    }
  });
});

describe("renderComposeConfig", () => {
  it("uses only the read-only Compose config command and parses its JSON model", () => {
    const runner = vi.fn(() => ({ status: 0, stdout: JSON.stringify(composeModel()) }));
    expect(
      renderComposeConfig(runner, {
        cwd: "/srv/rakazo",
        envFile: "/srv/rakazo/.env",
        composeFile: "/srv/rakazo/infra/compose/docker-compose.prod.yml",
        env: {},
      }),
    ).toEqual(composeModel());
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(
      "docker",
      [
        "compose",
        "--env-file",
        "/srv/rakazo/.env",
        "-f",
        "/srv/rakazo/infra/compose/docker-compose.prod.yml",
        "--profile",
        "updater",
        "config",
        "--format",
        "json",
      ],
      expect.objectContaining({ cwd: "/srv/rakazo" }),
    );
  });
});
