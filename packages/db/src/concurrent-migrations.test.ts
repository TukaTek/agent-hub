import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../prisma/migrations");

const migrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    name: entry.name,
    sql: readFileSync(join(migrationsDir, entry.name, "migration.sql"), "utf8")
      .replace(/--[^\n]*/g, "")
      .trim(),
  }));

// `prisma migrate deploy` sends each file as one query, and Postgres runs a
// multi-statement query in an implicit transaction, where CONCURRENTLY fails.
describe("concurrent index migrations", () => {
  const concurrent = migrations.filter(({ sql }) => /\bCONCURRENTLY\b/i.test(sql));

  it("covers the run retry unique index", () => {
    expect(concurrent.map(({ name }) => name)).toContain(
      "20261014120001_runs_retry_of_run_id_key_concurrent",
    );
  });

  it.each(concurrent)("$name holds a single statement", ({ sql }) => {
    expect(sql.replace(/;\s*$/, "")).not.toContain(";");
  });
});
