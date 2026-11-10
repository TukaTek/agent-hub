import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { heldBackMigrations } from "./deferred-migrations.js";

describe("deferred migrations", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("holds nothing back without touching the database when no migration is deferred", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "deferred-migrations-"));
    dirs.push(dir);
    mkdirSync(path.join(dir, "20990101000000_add"));
    writeFileSync(path.join(dir, "20990101000000_add", "migration.sql"), "SELECT 1;\n");
    // An unreachable URL proves the database is not consulted.
    await expect(
      heldBackMigrations("postgres://nobody:fake@127.0.0.1:1/none", dir),
    ).resolves.toEqual([]);
  });
});
