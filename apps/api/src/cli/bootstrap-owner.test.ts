import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);

it("refuses to create a password owner in Hub mode before touching the database", async () => {
  const result = run("pnpm", ["exec", "tsx", "src/cli/bootstrap-owner.ts"], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: {
      ...process.env,
      AUTH_MODE: "hub",
      HUB_AUTH_ORIGIN: "https://hub.example.test",
      HUB_POLICY_ENFORCEMENT: "off",
      DATABASE_URL: "postgresql://bootstrap:unused@127.0.0.1:1/unreachable",
      OWNER_EMAIL: "owner@example.test",
      OWNER_PASSWORD: "bootstrap-test-password-12345",
      BETTER_AUTH_URL: "http://127.0.0.1:5173",
      BETTER_AUTH_SECRET: "bootstrap-test-secret-with-over-32-characters",
    },
  });
  await expect(result).rejects.toMatchObject({
    stderr: expect.stringContaining("Owner bootstrap can't be combined with Hub sign-in"),
  });
}, 60_000);
