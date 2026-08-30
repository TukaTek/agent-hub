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

it("writes backup identity metadata and verifies it before restore starts services", () => {
  const productionBackup = trackedFile("infra/compose/backup-prod.sh");
  const localBackup = trackedFile("scripts/backup.sh");
  const restore = trackedFile("scripts/restore.sh");
  expect(productionBackup).toContain(
    `backup-metadata.mjs" write "\${SNAPSHOT_DIR}/deployment.json" "\${ENV_FILE}"`,
  );
  expect(localBackup).toContain('backup-metadata.mjs" write "$OUT/deployment.json" "$ROOT/.env"');
  const verify = restore.indexOf('backup-metadata.mjs" verify "$SRC/deployment.json"');
  const firstComposeUp = restore.indexOf(`"\${compose[@]}" up`);
  expect(verify).toBeGreaterThan(-1);
  expect(verify).toBeLessThan(firstComposeUp);
});
