import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createBackupMetadata,
  verifyBackupDeployment,
  writeBackupMetadata,
} from "./backup-metadata.mjs";
import { deterministicSecretFixture } from "./secret-fixtures.js";

const deploymentId = "0198f2ce-7d11-7a41-8b5c-7d1dfd62c551";

describe("backup deployment metadata", () => {
  const env = {
    NODE_ENV: "production",
    CORTEXAI_DEPLOYMENT_ID: deploymentId,
    GIT_SHA: "22d7eb598c3cc72c047025df6d7a72d3612067a9",
    RAKAZO_IMAGE_TAG: "sha-22d7eb598c3cc72c047025df6d7a72d3612067a9",
    SANDBOX_PROVIDER: "e2b",
    CORTEXAI_BACKUP_TARGET: "s3://fake-backup-bucket/tenant-a",
    CORTEXAI_BACKUP_ENCRYPTION_KEY: deterministicSecretFixture("backup"),
    BETTER_AUTH_SECRET: deterministicSecretFixture("auth"),
  };

  it("writes only safe deployment inventory fields", () => {
    const metadata = createBackupMetadata(env, "2026-08-29T12:00:00.000Z");
    expect(metadata).toEqual({
      schemaVersion: 1,
      deploymentId,
      createdAt: "2026-08-29T12:00:00.000Z",
      revision: env.GIT_SHA,
      imageTag: env.RAKAZO_IMAGE_TAG,
      providerKind: "e2b",
      backupTargetClass: "s3",
    });
    expect(JSON.stringify(metadata)).not.toContain(env.BETTER_AUTH_SECRET);
    expect(JSON.stringify(metadata)).not.toContain(env.CORTEXAI_BACKUP_TARGET);
  });

  it("requires same-deployment restore and rejects cross-tenant metadata", () => {
    const metadata = createBackupMetadata(env, "2026-08-29T12:00:00.000Z");
    expect(() => verifyBackupDeployment(metadata, env)).not.toThrow();
    expect(() =>
      verifyBackupDeployment(metadata, {
        ...env,
        CORTEXAI_DEPLOYMENT_ID: "0198f2ce-7d11-7a41-8b5c-7d1dfd62c552",
      }),
    ).toThrow(/different deployment identity/);
  });

  it("writes mode-0600 JSON without secret values", () => {
    const directory = mkdtempSync(path.join(process.cwd(), ".caah-19-backup-"));
    try {
      const target = path.join(directory, "deployment.json");
      writeBackupMetadata(target, env, "2026-08-29T12:00:00.000Z");
      const contents = readFileSync(target, "utf8");
      expect(JSON.parse(contents).deploymentId).toBe(deploymentId);
      expect(contents).not.toContain(env.BETTER_AUTH_SECRET);
      expect(statSync(target).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on missing or malformed metadata", () => {
    expect(() => verifyBackupDeployment({}, env)).toThrow(/metadata/);
    const directory = mkdtempSync(path.join(process.cwd(), ".caah-19-backup-invalid-"));
    try {
      const target = path.join(directory, "deployment.json");
      writeFileSync(target, "not-json", "utf8");
      expect(() => JSON.parse(readFileSync(target, "utf8"))).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["revision", { GIT_SHA: undefined }],
    ["image tag", { RAKAZO_IMAGE_TAG: "latest" }],
    ["provider", { SANDBOX_PROVIDER: "none" }],
    ["backup encryption", { CORTEXAI_BACKUP_ENCRYPTION_KEY: undefined }],
  ])("fails closed on unsafe production %s input", (_subject, override) => {
    expect(() => createBackupMetadata({ ...env, ...override })).toThrow(/Production backup/);
  });
});
