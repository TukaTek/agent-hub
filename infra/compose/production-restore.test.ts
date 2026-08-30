import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { writeBackupManifest } from "./backup-metadata.mjs";
import { deterministicSecretFixture } from "./secret-fixtures.js";

const revision = "22d7eb598c3cc72c047025df6d7a72d3612067a9";
const deploymentId = "0198f2ce-7d11-7a41-8b5c-7d1dfd62c551";

it("executes the production restore topology with the exact verified backup payloads", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "caah-19-production-restore-"));
  try {
    const project = path.join(directory, "project");
    const composeDirectory = path.join(project, "infra", "compose");
    const snapshot = path.join(directory, "snapshot");
    const fakeBin = path.join(directory, "bin");
    const dockerLog = path.join(directory, "docker.log");
    const databaseCapture = path.join(directory, "database.capture");
    const appdataCapture = path.join(directory, "appdata.capture");
    mkdirSync(composeDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(snapshot, { mode: 0o700 });
    mkdirSync(fakeBin, { mode: 0o700 });
    copyFileSync(
      "infra/compose/backup-metadata.mjs",
      path.join(composeDirectory, "backup-metadata.mjs"),
    );
    copyFileSync("infra/compose/restore-prod.sh", path.join(composeDirectory, "restore-prod.sh"));
    chmodSync(path.join(composeDirectory, "restore-prod.sh"), 0o755);
    writeFileSync(path.join(composeDirectory, "docker-compose.prod.yml"), "services: {}\n", {
      mode: 0o600,
    });

    const environment = {
      NODE_ENV: "production",
      CORTEXAI_DEPLOYMENT_ID: deploymentId,
      GIT_SHA: revision,
      RAKAZO_IMAGE_TAG: `sha-${revision}`,
      SANDBOX_PROVIDER: "e2b",
      CORTEXAI_BACKUP_TARGET: "s3://fake-backup-bucket/tenant-a",
      CORTEXAI_BACKUP_ENCRYPTION_KEY: deterministicSecretFixture("backup-integrity"),
    };
    writeFileSync(
      path.join(project, ".env"),
      `${Object.entries(environment)
        .map(([name, value]) => `${name}=${value}`)
        .join("\n")}\n`,
      { mode: 0o600 },
    );
    const databaseBytes = Buffer.from("production database payload\n");
    const appdataBytes = Buffer.from("production appdata payload\n");
    writeFileSync(path.join(snapshot, "rakazo.dump"), databaseBytes, { mode: 0o600 });
    writeFileSync(path.join(snapshot, "appdata.tgz"), appdataBytes, { mode: 0o600 });
    writeBackupManifest(snapshot, environment, "2026-08-29T12:00:00.000Z");

    const docker = path.join(fakeBin, "docker");
    writeFileSync(
      docker,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$RAKAZO_DOCKER_LOG"
if [[ "$*" == *"pg_restore --clean"* ]]; then
  /bin/cat > "$RAKAZO_DATABASE_CAPTURE"
elif [[ "$*" == *"run --rm --no-deps"* ]]; then
  /bin/cat > "$RAKAZO_APPDATA_CAPTURE"
fi
`,
      { mode: 0o700 },
    );

    const result = spawnSync("bash", [path.join(composeDirectory, "restore-prod.sh"), snapshot], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...environment,
        PATH: `${fakeBin}:${process.env.PATH}`,
        RAKAZO_PROJECT_DIR: project,
        RAKAZO_DOCKER_LOG: dockerLog,
        RAKAZO_DATABASE_CAPTURE: databaseCapture,
        RAKAZO_APPDATA_CAPTURE: appdataCapture,
      },
    });

    const commands = readFileSync(dockerLog, "utf8");
    expect(result.status, `${result.stdout}\n${result.stderr}\n${commands}`).toBe(0);
    expect(
      readFileSync(databaseCapture),
      `${result.stdout}\n${result.stderr}\n${commands}`,
    ).toEqual(databaseBytes);
    expect(readFileSync(appdataCapture), commands).toEqual(appdataBytes);
    expect(commands).toContain("docker-compose.prod.yml");
    expect(commands).toContain("pg_restore --clean --if-exists");
    expect(commands).toContain("run --rm --no-deps --entrypoint sh api");
    expect(commands).not.toContain("infra/compose/docker-compose.yml");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
