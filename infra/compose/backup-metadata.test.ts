import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readVerifiedBackupArtifact,
  verifyBackupSnapshot,
  writeBackupManifest,
} from "./backup-metadata.mjs";
import { deterministicSecretFixture } from "./secret-fixtures.js";

const deploymentId = "0198f2ce-7d11-7a41-8b5c-7d1dfd62c551";
const createdAt = "2026-08-29T12:00:00.000Z";
const productionEnv = {
  NODE_ENV: "production",
  CORTEXAI_DEPLOYMENT_ID: deploymentId,
  GIT_SHA: "22d7eb598c3cc72c047025df6d7a72d3612067a9",
  RAKAZO_IMAGE_TAG: "sha-22d7eb598c3cc72c047025df6d7a72d3612067a9",
  SANDBOX_PROVIDER: "e2b",
  CORTEXAI_BACKUP_TARGET: "s3://fake-backup-bucket/tenant-a",
  CORTEXAI_BACKUP_ENCRYPTION_KEY: deterministicSecretFixture("backup"),
  BETTER_AUTH_SECRET: deterministicSecretFixture("auth"),
};

describe("production backup manifest", () => {
  it("binds deployment, revision, provider, encryption, names, types, sizes, and digests", () => {
    const snapshot = createSnapshot("identity");
    try {
      const manifest = verifyBackupSnapshot(snapshot, productionEnv);
      expect(manifest).toMatchObject({
        schemaVersion: 2,
        deploymentId,
        createdAt,
        revision: productionEnv.GIT_SHA,
        imageTag: productionEnv.RAKAZO_IMAGE_TAG,
        providerKind: "e2b",
        backupTargetClass: "s3",
        encryption: {
          transportRequired: true,
          keyFingerprintSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        integrity: {
          algorithm: "hmac-sha256",
          manifestHmacSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        artifacts: [
          {
            name: "rakazo.dump",
            type: "application/vnd.postgresql.custom-dump",
            sizeBytes: Buffer.byteLength("database snapshot A\n"),
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
          {
            name: "appdata.tgz",
            type: "application/gzip",
            sizeBytes: Buffer.byteLength("application snapshot A\n"),
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
        ],
      });
      const contents = readFileSync(path.join(snapshot, "deployment.json"), "utf8");
      expect(contents).not.toContain(productionEnv.BETTER_AUTH_SECRET);
      expect(contents).not.toContain(productionEnv.CORTEXAI_BACKUP_TARGET);
      expect(contents).not.toContain(productionEnv.CORTEXAI_BACKUP_ENCRYPTION_KEY);
      expect(statSync(path.join(snapshot, "deployment.json")).mode & 0o777).toBe(0o600);
      expect(statSync(snapshot).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(snapshot, { recursive: true, force: true });
    }
  });

  it("fails closed when a payload is tampered after the manifest is written", () => {
    const snapshot = createSnapshot("tamper");
    try {
      writeFileSync(path.join(snapshot, "rakazo.dump"), "tampered bytes\n", { mode: 0o600 });
      expect(() => verifyBackupSnapshot(snapshot, productionEnv)).toThrow(/digest|size/i);
    } finally {
      rmSync(snapshot, { recursive: true, force: true });
    }
  });

  it("fails closed when signed identity metadata or artifact metadata is tampered", () => {
    const snapshot = createSnapshot("manifest-tamper");
    try {
      const manifestPath = path.join(snapshot, "deployment.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.providerKind = "box";
      manifest.artifacts[0].type = "application/octet-stream";
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      expect(() => verifyBackupSnapshot(snapshot, productionEnv)).toThrow(/integrity|metadata/i);
    } finally {
      rmSync(snapshot, { recursive: true, force: true });
    }
  });

  it("rejects a payload substituted from another snapshot", () => {
    const first = createSnapshot("cross-a", "database snapshot A\n", "application snapshot A\n");
    const second = createSnapshot("cross-b", "database snapshot B\n", "application snapshot B\n");
    try {
      copyFileSync(path.join(second, "rakazo.dump"), path.join(first, "rakazo.dump"));
      chmodSync(path.join(first, "rakazo.dump"), 0o600);
      expect(() => verifyBackupSnapshot(first, productionEnv)).toThrow(/digest/i);
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("rejects snapshot and payload symlink substitution", () => {
    const snapshot = createSnapshot("symlink");
    const parent = mkdtempSync(path.join(os.tmpdir(), "caah-19-snapshot-link-"));
    try {
      const external = path.join(parent, "external.dump");
      writeFileSync(external, "database snapshot A\n", { mode: 0o600 });
      unlinkSync(path.join(snapshot, "rakazo.dump"));
      symlinkSync(external, path.join(snapshot, "rakazo.dump"));
      expect(() => verifyBackupSnapshot(snapshot, productionEnv)).toThrow(/symbolic link|regular/i);

      const snapshotLink = path.join(parent, "snapshot");
      symlinkSync(snapshot, snapshotLink);
      expect(() => verifyBackupSnapshot(snapshotLink, productionEnv)).toThrow(/symbolic link/i);
    } finally {
      rmSync(snapshot, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing", (snapshot: string) => unlinkSync(path.join(snapshot, "appdata.tgz"))],
    [
      "extra",
      (snapshot: string) =>
        writeFileSync(path.join(snapshot, "untracked.bin"), "unexpected\n", { mode: 0o600 }),
    ],
  ])("rejects a snapshot with a %s artifact", (_caseName, mutate) => {
    const snapshot = createSnapshot("artifact-set");
    try {
      mutate(snapshot);
      expect(() => verifyBackupSnapshot(snapshot, productionEnv)).toThrow(/artifact/i);
    } finally {
      rmSync(snapshot, { recursive: true, force: true });
    }
  });

  it("rejects the wrong deployment and the wrong integrity key without logging either secret", () => {
    const snapshot = createSnapshot("identity-mismatch");
    try {
      expect(() =>
        verifyBackupSnapshot(snapshot, {
          ...productionEnv,
          CORTEXAI_DEPLOYMENT_ID: "0198f2ce-7d11-7a41-8b5c-7d1dfd62c552",
        }),
      ).toThrow(/different deployment identity/i);
      expect(() =>
        verifyBackupSnapshot(snapshot, {
          ...productionEnv,
          CORTEXAI_BACKUP_ENCRYPTION_KEY: deterministicSecretFixture("different-backup"),
        }),
      ).toThrow(/integrity|encryption/i);
    } finally {
      rmSync(snapshot, { recursive: true, force: true });
    }
  });

  it("re-verifies from a no-follow file descriptor immediately before consumption", () => {
    const snapshot = createSnapshot("consume");
    try {
      expect(
        readVerifiedBackupArtifact(snapshot, "rakazo.dump", productionEnv).toString("utf8"),
      ).toBe("database snapshot A\n");
      verifyBackupSnapshot(snapshot, productionEnv);
      writeFileSync(path.join(snapshot, "rakazo.dump"), "swapped after verification\n", {
        mode: 0o600,
      });
      expect(() => readVerifiedBackupArtifact(snapshot, "rakazo.dump", productionEnv)).toThrow(
        /digest|size/i,
      );
      expect(() =>
        readVerifiedBackupArtifact(snapshot, "../deployment.json", productionEnv),
      ).toThrow(/artifact/i);
    } finally {
      rmSync(snapshot, { recursive: true, force: true });
    }
  });

  it("emits only the verified artifact bytes on stdout", () => {
    const snapshot = createSnapshot("emit");
    try {
      const result = spawnSync(
        process.execPath,
        ["infra/compose/backup-metadata.mjs", "emit", snapshot, "rakazo.dump"],
        { env: { ...process.env, ...productionEnv }, encoding: "buffer" },
      );
      expect(result.status, result.stderr.toString("utf8")).toBe(0);
      expect(result.stdout).toEqual(Buffer.from("database snapshot A\n"));
    } finally {
      rmSync(snapshot, { recursive: true, force: true });
    }
  });

  it("requires private directory and artifact permissions", () => {
    const snapshot = createSnapshot("permissions");
    try {
      chmodSync(path.join(snapshot, "appdata.tgz"), 0o644);
      expect(() => verifyBackupSnapshot(snapshot, productionEnv)).toThrow(/permission/i);
      chmodSync(path.join(snapshot, "appdata.tgz"), 0o600);
      chmodSync(snapshot, 0o755);
      expect(() => verifyBackupSnapshot(snapshot, productionEnv)).toThrow(/permission/i);
    } finally {
      rmSync(snapshot, { recursive: true, force: true });
    }
  });
});

function createSnapshot(
  label: string,
  database = "database snapshot A\n",
  appdata = "application snapshot A\n",
): string {
  const snapshot = mkdtempSync(path.join(os.tmpdir(), `caah-19-${label}-`));
  chmodSync(snapshot, 0o700);
  writeFileSync(path.join(snapshot, "rakazo.dump"), database, { mode: 0o600 });
  writeFileSync(path.join(snapshot, "appdata.tgz"), appdata, { mode: 0o600 });
  writeBackupManifest(snapshot, productionEnv, createdAt);
  return snapshot;
}
