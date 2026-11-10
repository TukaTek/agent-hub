import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { DEFERRED_MIGRATION_MARKER } from "./deferred-migrations.js";
import { installDbContext, rlsBypassKey, runAsSystem, runAsTenant } from "./row-security.js";

const migrationsDir = fileURLToPath(new URL("../prisma/migrations", import.meta.url));
const migration = (suffix: string) => {
  const name = readdirSync(migrationsDir).find((entry) => entry.endsWith(suffix));
  if (!name) throw new Error(`no migration ending in ${suffix}`);
  return readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8");
};

describe("rlsBypassKey", () => {
  it("follows the password pg logs in with", () => {
    const key = rlsBypassKey("postgres://app:secret@db/hub");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(rlsBypassKey("postgres://app@db/hub?password=secret")).toBe(key);
    expect(rlsBypassKey("postgres://app:other@db/hub?password=secret")).toBe(key);
    expect(rlsBypassKey("postgres://app:secret@db/hub?password=")).toBe(key);
    expect(rlsBypassKey("postgres://app:s%cret@db/hub")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is empty without a password", () => {
    expect(rlsBypassKey("postgres://app@db/hub")).toBe("");
    expect(rlsBypassKey("not a url")).toBe("");
  });
});

describe("session settings", () => {
  /** A pool whose connections record the settings each checkout applies. */
  function fakePool(connectionString: string) {
    const sent: unknown[][] = [];
    const client = {
      query: async (_sql: string, values: unknown[]) => {
        sent.push(values);
        return { rows: [] };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const pool = {
      options: { connectionString },
      connect: async () => client,
    } as unknown as Pool;
    installDbContext(pool);
    return { pool, sent };
  }

  it("sends the key only from a system context, never from a tenant one", async () => {
    const url = "postgres://cortexai_agent_hub_app:fake-runtime-password@db/hub";
    const { pool, sent } = fakePool(url);
    await runAsTenant({ spaceId: "space-1", userId: "user-1" }, () => pool.connect());
    await runAsSystem("unit test", () => pool.connect());
    expect(sent).toEqual([
      ["space-1", "user-1", "off", ""],
      ["", "", "on", rlsBypassKey(url)],
    ]);
  });
});

describe("bypass key migrations", () => {
  it("routes the bypass policies through a function a tenant session cannot satisfy", () => {
    const first = migration("_rls_bypass_key");
    // The digests live where the runtime role has no grant.
    expect(first).toMatch(/REVOKE ALL ON SCHEMA cortexai_agent_hub_private FROM PUBLIC/);
    expect(first).toMatch(/SECURITY DEFINER/);
    expect(first).toMatch(/USING \(\(SELECT app_rls_bypass\(\)\)\)/);
    // The previous-release policies gave every row to a session that cleared app.rls_version.
    expect(first).toMatch(/DROP POLICY %I ON %I/);
  });

  it("requires the key one deploy later, once the release that sends none has stopped", () => {
    const required = migration("_rls_bypass_key_required");
    expect(required.startsWith(DEFERRED_MIGRATION_MARKER)).toBe(true);
    expect(required).toMatch(/current_setting\('app\.rls_bypass_key', true\)/);
    expect(required).toMatch(/cortexai_agent_hub_private\.rls_bypass_keys/);
  });
});
