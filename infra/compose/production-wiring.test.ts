import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

function trackedFile(file: string): string {
  return readFileSync(file, "utf8");
}

it("requires immutable identity, provider, and revision in production API and worker services", () => {
  const compose = trackedFile("infra/compose/docker-compose.prod.yml");
  expect(compose.match(/CORTEXAI_DEPLOYMENT_ID: \$\{CORTEXAI_DEPLOYMENT_ID:\?/g)).toHaveLength(2);
  expect(compose.match(/GIT_SHA: \$\{GIT_SHA:\?/g)).toHaveLength(2);
  expect(compose.match(/SANDBOX_PROVIDER: \$\{SANDBOX_PROVIDER:\?/g)).toHaveLength(2);
  expect(compose.match(/CORTEXAI_BACKUP_TARGET: ""/g)).toHaveLength(2);
  expect(compose.match(/CORTEXAI_BACKUP_ENCRYPTION_KEY: ""/g)).toHaveLength(2);
  expect(compose).not.toContain("SANDBOX_PROVIDER: e2b");
});

it("exposes daemon-free preflight and inventory commands", () => {
  const packageJson = JSON.parse(trackedFile("package.json")) as {
    scripts: Record<string, string>;
  };
  expect(packageJson.scripts["deployment:preflight"]).toBe("tsx infra/compose/preflight.ts");
  expect(packageJson.scripts["deployment:inventory"]).toBe(
    "tsx infra/compose/preflight.ts --inventory",
  );
});

it("documents every required production input without real values", () => {
  const example = trackedFile(".env.example");
  for (const name of [
    "CORTEXAI_DEPLOYMENT_ID",
    "CORTEXAI_BACKUP_TARGET",
    "CORTEXAI_BACKUP_ENCRYPTION_KEY",
  ]) {
    expect(example).toMatch(new RegExp(`^${name}=$`, "m"));
  }
});

it("writes a bound production manifest after exact payloads and restores that production layout", () => {
  const productionBackup = trackedFile("infra/compose/backup-prod.sh");
  const restore = trackedFile("infra/compose/restore-prod.sh");
  const databaseDump = productionBackup.indexOf(`> "\${SNAPSHOT_DIR}/rakazo.dump"`);
  const appdataArchive = productionBackup.indexOf(`> "\${SNAPSHOT_DIR}/appdata.tgz"`);
  const manifestWrite = productionBackup.indexOf(
    `backup-metadata.mjs" write "\${SNAPSHOT_DIR}" "\${ENV_FILE}"`,
  );
  expect(databaseDump).toBeGreaterThan(-1);
  expect(appdataArchive).toBeGreaterThan(-1);
  expect(manifestWrite).toBeGreaterThan(databaseDump);
  expect(manifestWrite).toBeGreaterThan(appdataArchive);
  expect(restore).toContain("docker-compose.prod.yml");
  expect(restore).toContain(`"$SNAPSHOT_DIR" rakazo.dump "\${ENV_FILE}" "\${EXPECTED_LAYOUT}"`);
  expect(restore).toContain(`"$SNAPSHOT_DIR" appdata.tgz "\${ENV_FILE}" "\${EXPECTED_LAYOUT}"`);
  const verify = restore.indexOf('backup-metadata.mjs" verify "$SNAPSHOT_DIR"');
  const firstComposeUp = restore.indexOf(`"\${compose[@]}" up`);
  expect(verify).toBeGreaterThan(-1);
  expect(verify).toBeLessThan(firstComposeUp);
});

it("keeps local backup/restore explicitly separate from production artifacts and topology", () => {
  const localBackup = trackedFile("scripts/backup.sh");
  const localRestore = trackedFile("scripts/restore.sh");
  expect(localBackup).toContain('install -d -m 700 "$ROOT/backups"');
  expect(localBackup).toContain("rakazo.sql");
  expect(localBackup).toContain("homes.tgz");
  expect(localRestore).toContain("docker-compose.yml");
  expect(localRestore).not.toContain("docker-compose.prod.yml");
  expect(localRestore).not.toContain("rakazo.dump");
});

it("generates and injects the immutable deployment ID in the published-images quick start", () => {
  const fixture = trackedFile("infra/compose/.env.images.example");
  const docs = trackedFile("docs/self-host.md");
  for (const content of [fixture, docs]) {
    expect(content).toContain("CORTEXAI_DEPLOYMENT_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')");
    expect(content).toContain(`"\${CORTEXAI_DEPLOYMENT_ID:?}"`);
    expect(content).toContain(
      `s/^CORTEXAI_DEPLOYMENT_ID=$/CORTEXAI_DEPLOYMENT_ID=\${CORTEXAI_DEPLOYMENT_ID}/`,
    );
  }
  expect(docs.indexOf("CORTEXAI_DEPLOYMENT_ID=$(uuidgen")).toBeLessThan(
    docs.indexOf("docker compose --env-file .env -f docker-compose.images.yml pull"),
  );
});

it("uses generated fixtures without inline Gitleaks exceptions", () => {
  for (const fixtureTest of [
    "infra/compose/deployment-preflight.test.ts",
    "infra/compose/backup-metadata.test.ts",
    "infra/compose/production-restore.test.ts",
  ]) {
    expect(trackedFile(fixtureTest)).not.toContain("gitleaks:allow");
  }
});
