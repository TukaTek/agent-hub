import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { loadEnv } from "../../apps/api/src/env.js";
import {
  applyServerUpdate,
  checkServerUpdate,
  readServerUpdateStatus,
  type UpdaterProxyConfig,
} from "../../apps/api/src/server-update.js";
import {
  type ComposeModel,
  type PreflightInput,
  validateProductionPreflight,
} from "./deployment-preflight.js";
import { deterministicSecretFixture } from "./secret-fixtures.js";

const revision = "22d7eb598c3cc72c047025df6d7a72d3612067a9";
const deploymentId = "0198f2ce-7d11-7a41-8b5c-7d1dfd62c551";
const manualOnlyMessage = "Manual updates only for pilot.";

function trackedFile(file: string): string {
  return readFileSync(file, "utf8");
}

function pilotComposeModel(): ComposeModel {
  return {
    services: {
      postgres: { image: "postgres:16@sha256:abc", networks: ["data"] },
      api: {
        image: `ghcr.io/example/app:sha-${revision}`,
        environment: { SANDBOX_PROVIDER: "e2b", CORTEXAI_DEPLOYMENT_ID: deploymentId },
        networks: ["app", "data"],
      },
      worker: {
        image: `ghcr.io/example/app:sha-${revision}`,
        environment: { SANDBOX_PROVIDER: "e2b", CORTEXAI_DEPLOYMENT_ID: deploymentId },
        networks: ["app", "data"],
      },
      web: {
        image: `ghcr.io/example/app:sha-${revision}`,
        environment: { RAKAZO_HOST: "app.example.test" },
        networks: ["edge", "app"],
      },
      caddy: {
        image: "caddy:2@sha256:def",
        environment: { RAKAZO_HOST: "app.example.test" },
        ports: [
          { target: 80, published: "80", protocol: "tcp" },
          { target: 443, published: "443", protocol: "tcp" },
          { target: 443, published: "443", protocol: "udp" },
        ],
        networks: ["edge", "app"],
      },
    },
    networks: { edge: {}, app: {}, data: { internal: true } },
  };
}

function validPilotInput(): PreflightInput {
  return {
    env: {
      NODE_ENV: "production",
      CORTEXAI_DEPLOYMENT_ID: deploymentId,
      WEB_ORIGIN: "https://app.example.test",
      BETTER_AUTH_URL: "https://app.example.test",
      API_URL: "https://app.example.test",
      RAKAZO_HOST: "app.example.test",
      SANDBOX_PROVIDER: "e2b",
      CORTEXAI_BACKUP_TARGET: "s3://fake-backup-bucket/tenant-a",
      RAKAZO_IMAGE: "ghcr.io/example/app",
      RAKAZO_IMAGE_TAG: `sha-${revision}`,
      GIT_SHA: revision,
      POSTGRES_PASSWORD: deterministicSecretFixture("pilot-postgres"),
      BETTER_AUTH_SECRET: deterministicSecretFixture("pilot-auth"),
      ENCRYPTION_KEY: deterministicSecretFixture("pilot-encryption"),
      SCREEN_PROXY_SECRET: deterministicSecretFixture("pilot-screen"),
      CORTEXAI_BACKUP_ENCRYPTION_KEY: deterministicSecretFixture("pilot-backup"),
      E2B_API_KEY: deterministicSecretFixture("pilot-provider"),
    },
    host: {
      architecture: "x64",
      totalMemoryBytes: 8 * 1024 ** 3,
      freeDiskBytes: 80 * 1024 ** 3,
      currentRevision: revision,
      sourceClean: true,
      sourceIndexFlagsClear: true,
      publicOriginResolved: true,
    },
    compose: pilotComposeModel(),
  };
}

describe("CAAH-19 manual-update pilot acceptance", () => {
  it("has no updater service, updater profile, updater socket, or updater API wiring in production Compose", () => {
    const source = trackedFile("infra/compose/docker-compose.prod.yml");
    const compose = parseYaml(source) as {
      services: Record<
        string,
        { profiles?: string[]; environment?: Record<string, unknown>; volumes?: string[] }
      >;
    };

    expect(compose.services.updater).toBeUndefined();
    expect(
      Object.values(compose.services).flatMap((service) => service.profiles ?? []),
    ).not.toContain("updater");
    expect(
      Object.values(compose.services).flatMap((service) => service.volumes ?? []),
    ).not.toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(compose.services.api?.environment).not.toHaveProperty("RAKAZO_UPDATER_URL");
    expect(source).not.toContain("infra/updater/Dockerfile");
  });

  it.each([
    ["RAKAZO_UPDATER_TOKEN", "configured"],
    ["RAKAZO_UPDATER_URL", "http://updater:7092"],
    ["RAKAZO_UPDATER_IMAGE", "ghcr.io/example/updater"],
    ["RAKAZO_UPDATER_IMAGE_TAG", `sha-${revision}`],
    ["RAKAZO_UPDATER_IMAGE_PREVIOUS", "ghcr.io/example/updater"],
    ["RAKAZO_UPDATER_IMAGE_TAG_PREVIOUS", `sha-${"a".repeat(40)}`],
    ["RAKAZO_UPDATER_FUTURE_SETTING", "configured"],
    ["RAKAZO_DEPLOY_DIR", "/srv/rakazo"],
    ["RAKAZO_COMPOSE_FILE", "infra/compose/docker-compose.prod.yml"],
    ["RAKAZO_COMPOSE_PROJECT_NAME", "rakazo-prod"],
    ["GIT_SHA_PREVIOUS", "a".repeat(40)],
    ["RAKAZO_IMAGE_TAG_PREVIOUS", `sha-${"a".repeat(40)}`],
    ["COMPOSE_PROFILES", "updater"],
  ])("fails production preflight closed when %s is supplied", (name, value) => {
    const input = validPilotInput();
    input.env[name] = value;
    const result = validateProductionPreflight(input);
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual({
      subject: "automated-updater",
      status: "unsafe",
      detail: manualOnlyMessage,
    });
  });

  it("keeps the manual-only preflight compatible with the remaining production gates", () => {
    const result = validateProductionPreflight(validPilotInput());
    expect(result.ok).toBe(true);
    expect(result.checks).toContainEqual({
      subject: "automated-updater",
      status: "ok",
      detail: manualOnlyMessage,
    });
  });

  it("hard-disables automated update status/check/apply in the production API", async () => {
    const production = loadEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://rakazo:rakazo@127.0.0.1:5433/rakazo",
      CORTEXAI_DEPLOYMENT_ID: deploymentId,
      BETTER_AUTH_SECRET: deterministicSecretFixture("api-auth"),
      ENCRYPTION_KEY: deterministicSecretFixture("api-encryption"),
      SCREEN_PROXY_SECRET: deterministicSecretFixture("api-screen"),
      SANDBOX_PROVIDER: "e2b",
      RAKAZO_UPDATER_URL: "http://updater:7092",
      RAKAZO_UPDATER_TOKEN: deterministicSecretFixture("api-updater"),
    });
    expect(production.manualUpdatesOnly).toBe(true);

    const fetchImpl = vi.fn(async () => new Response("unexpected", { status: 500 }));
    const config: UpdaterProxyConfig = {
      url: production.updaterUrl ?? null,
      token: production.updaterToken ?? null,
      gitSha: revision,
      disabled: production.manualUpdatesOnly,
      fetch: fetchImpl as unknown as typeof fetch,
    };
    const status = await readServerUpdateStatus(config);
    expect(status.supported).toBe(false);
    expect(status.installKind).not.toBe("sidecar");
    expect(status.unsupportedReason).toBe(manualOnlyMessage);
    expect(status.manualCommands).toEqual([
      "Follow docs/self-host.md#manual-immutable-update-and-rollback-pilot from the production host.",
    ]);
    await expect(checkServerUpdate(config)).rejects.toThrow(manualOnlyMessage);
    await expect(applyServerUpdate(config)).rejects.toThrow(manualOnlyMessage);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cannot publish an updater image while preserving exact-head app-image provenance", () => {
    const source = trackedFile(".github/workflows/publish-server-image.yml");
    const workflow = parseYaml(source) as {
      env: Record<string, string>;
      jobs: Record<
        string,
        {
          strategy?: { matrix?: { include?: Array<{ name: string; dockerfile: string }> } };
          steps: Array<Record<string, unknown>>;
        }
      >;
    };
    const published = workflow.jobs.publish?.strategy?.matrix?.include ?? [];
    const validated = workflow.jobs.validate?.strategy?.matrix?.include ?? [];

    expect(published).toEqual([{ name: "app", dockerfile: "infra/compose/Dockerfile" }]);
    expect(validated).toContainEqual({ name: "updater", dockerfile: "infra/updater/Dockerfile" });
    expect(workflow.env.CANDIDATE_SHA).toContain("pull_request.head.sha");
    const publishBuild = workflow.jobs.publish.steps.find((step) =>
      String(step.uses ?? "").startsWith("docker/build-push-action@"),
    );
    expect(publishBuild?.with).toMatchObject({
      context: ".",
      push: true,
      "build-args": "GIT_SHA=$" + "{{ env.CANDIDATE_SHA }}",
      provenance: "mode=max",
      sbom: true,
    });
  });

  it("documents one exact-SHA manual update and rollback runbook with honest gates", () => {
    const docs = trackedFile("docs/self-host.md");
    const heading = docs.indexOf("## Manual immutable update and rollback (pilot)");
    expect(heading).toBeGreaterThan(-1);
    const runbook = docs.slice(heading);

    expect(runbook).toContain("Manual updates only for pilot.");
    expect(runbook).toContain('[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(runbook).toContain('TARGET_TAG="sha-$' + '{TARGET_SHA}"');
    expect(runbook).toContain("PREVIOUS_SHA");
    expect(runbook).toContain("PREVIOUS_TAG");
    expect(runbook).toContain("export RAKAZO_HOST");
    expect(runbook).toContain("corepack pnpm deployment:preflight");
    expect(runbook).toContain("rakazo-backup");
    expect(runbook).toContain('docker pull "$' + "{RAKAZO_IMAGE}:$" + '{TARGET_TAG}"');
    expect(runbook).toContain("org.opencontainers.image.revision");
    expect(runbook).toContain("up -d --wait --pull never api worker web");
    expect(runbook).toContain("/health");
    expect(runbook).toContain("Rollback");
    expect(runbook).toMatch(/outage/i);
    expect(runbook).toMatch(/migration/i);
    expect(runbook).toMatch(/off-host backup/i);
    expect(runbook).not.toContain("--profile updater");
    expect(runbook).not.toContain("/apply");
    expect(runbook).not.toContain("ghcr.io/elie222/rakazo/updater");
  });
});
