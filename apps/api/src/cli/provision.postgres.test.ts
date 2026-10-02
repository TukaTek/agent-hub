import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ComposioEmulator } from "@cortexai-agent-hub/adapters";
import { hubUserId } from "@cortexai-agent-hub/auth";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { createApp } from "../app.js";

/**
 * CAAH-43 fresh-install smoke for the operator provisioning commands: runs the
 * real `pnpm --filter @cortexai-agent-hub/api provision` entrypoint (the same
 * command docs/self-host.md gives for Compose) against PostgreSQL, then signs
 * in through the real API app.
 */
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const origin = "http://127.0.0.1:5173";
const SECRET = "fixture-provision-secret12";

function provision(
  args: string[],
  { stdin = "", env = {} }: { stdin?: string; env?: Record<string, string> } = {},
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      "pnpm",
      ["--silent", "--filter", "@cortexai-agent-hub/api", "provision", ...args],
      {
        cwd: repoRoot,
        // Only what the container provides; never the test's own secrets.
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? tmpdir(),
          DATABASE_URL: process.env.DATABASE_URL ?? "",
          ...env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

/** pnpm reports any script failure as exit 1, so assert the refusal by its message. */
function expectRefused(
  run: { code: number | null; stdout: string; stderr: string },
  reason: string,
) {
  expect(run.code, run.stderr).not.toBe(0);
  expect(run.stderr).toContain(reason);
  expect(`${run.stdout}${run.stderr}`).not.toContain(SECRET);
}

describePostgres("provision CLI against PostgreSQL (CAAH-43)", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  const dataDir = mkdtempSync(path.join(tmpdir(), "cortexai-agent-hub-provision-"));
  const email = (label: string) => `${label}-${randomUUID()}@cortexai-agent-hub.test`;
  const owner = async () =>
    (await handles.prisma.deploymentSettings.findUnique({ where: { id: "default" } }))
      ?.ownerUserId ?? null;
  const signIn = (address: string, password = SECRET) =>
    handles.app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: address, password }),
    });

  beforeAll(async () => {
    const { createApp } = await import("../app.js");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      composio: new ComposioEmulator(),
    });
  });

  beforeEach(async () => {
    await handles.prisma.deploymentSettings.updateMany({ data: { ownerUserId: null } });
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("provision-owner reads the password from stdin and the owner signs in", async () => {
    const ownerEmail = email("owner");
    const run = await provision(
      ["provision-owner", "--email", ownerEmail.toUpperCase(), "--name", "Owner"],
      { stdin: `${SECRET}\n` },
    );
    expect(run, run.stderr).toMatchObject({ code: 0 });
    expect(run.stdout).toContain(`Created deployment owner ${ownerEmail}.`);
    expect(`${run.stdout}${run.stderr}`).not.toContain(SECRET);
    const user = await handles.prisma.user.findUniqueOrThrow({ where: { email: ownerEmail } });
    expect(user.emailVerified).toBe(true);
    expect(await owner()).toBe(user.id);
    expect((await signIn(ownerEmail)).status).toBe(200);
    expect((await signIn(ownerEmail, `${SECRET}\n`)).status).toBe(401);

    // The seat is taken: a second provision-owner changes nothing.
    const second = email("second-owner");
    const usersBefore = await handles.prisma.user.count();
    const refused = await provision(["provision-owner", "--email", second, "--name", "Second"], {
      stdin: SECRET,
    });
    expectRefused(refused, "already has an owner");
    expect(await handles.prisma.user.count()).toBe(usersBefore);
    expect(await owner()).toBe(user.id);
  });

  it("concurrent provision-owner processes leave exactly one owner and one account", async () => {
    const emails = Array.from({ length: 3 }, (_, index) => email(`race-${index}`));
    const usersBefore = await handles.prisma.user.count();
    const runs = await Promise.all(
      emails.map((address) =>
        provision(["provision-owner", "--email", address, "--name", "Racer"], { stdin: SECRET }),
      ),
    );
    expect(runs.map((run) => run.code).sort()).toEqual([0, 1, 1]);
    expect(await handles.prisma.user.count()).toBe(usersBefore + 1);
    const winner = emails[runs.findIndex((run) => run.code === 0)]!;
    const seated = await handles.prisma.user.findUniqueOrThrow({ where: { email: winner } });
    expect(await owner()).toBe(seated.id);
  });

  it("provision-user reads --secret-file, grants no ownership, and transfer-owner moves the seat", async () => {
    const seated = email("seated");
    expect(
      (
        await provision(["provision-owner", "--email", seated, "--name", "Seated"], {
          stdin: SECRET,
        })
      ).code,
    ).toBe(0);
    const seatedId = await owner();
    const secretFile = path.join(dataDir, "member-secret");
    writeFileSync(secretFile, `${SECRET}\n`, { mode: 0o600 });
    const member = email("member");
    const run = await provision([
      "provision-user",
      "--email",
      member,
      "--name",
      "Member",
      "--secret-file",
      secretFile,
    ]);
    expect(run, run.stderr).toMatchObject({ code: 0 });
    expect(run.stdout).toContain("(not the owner)");
    expect(await owner()).toBe(seatedId);
    expect((await signIn(member)).status).toBe(200);
    expect(await owner()).toBe(seatedId);

    const moved = await provision(["transfer-owner", "--email", member]);
    expect(moved, moved.stderr).toMatchObject({ code: 0 });
    const memberId = (await handles.prisma.user.findUniqueOrThrow({ where: { email: member } })).id;
    expect(await owner()).toBe(memberId);
  });

  it("refuses passwords from argv or the environment and creates nothing", async () => {
    const target = email("refused");
    for (const args of [
      ["provision-owner", "--email", target, "--name", "R", "--password", SECRET],
      ["provision-owner", "--email", target, "--name", "R", `--password=${SECRET}`],
    ]) {
      expectRefused(await provision(args), "never accepted as arguments");
    }
    // Every plausible env name is ignored; empty stdin means no password.
    const fromEnv = await provision(["provision-owner", "--email", target, "--name", "R"], {
      env: { PASSWORD: SECRET, PROVISION_PASSWORD: SECRET, OWNER_PASSWORD: SECRET },
    });
    expectRefused(fromEnv, "Password must be at least 8 characters");
    expect(await handles.prisma.user.count({ where: { email: target } })).toBe(0);
    expect(await owner()).toBeNull();
  });

  it("Hub mode maps tenant_users.id plus tenant and never creates a local password", async () => {
    const hubEnv = {
      AUTH_MODE: "hub",
      HUB_AUTH_ORIGIN: "https://hub.example.test",
      HUB_AUTH_TENANT_ID: "tenant-fixture",
    };
    const target = email("hub-local");
    const usersBefore = await handles.prisma.user.count();
    const accountsBefore = await handles.prisma.account.count();
    for (const [args, reason] of [
      [["provision-owner", "--email", target, "--name", "Local"], "no local password is created"],
      [
        [
          "provision-owner",
          "--hub-user-id",
          "tu-1",
          "--hub-tenant",
          "tenant-fixture",
          "--email",
          target,
        ],
        "no local password is created",
      ],
      [["provision-user", "--email", target, "--name", "Local"], "provision-user is unavailable"],
      [
        ["provision-owner", "--hub-user-id", "tu-1", "--hub-tenant", "other-tenant"],
        "does not match this deployment's HUB_AUTH_TENANT_ID",
      ],
      [
        [
          "provision-owner",
          "--hub-user-id",
          "owner@example.test",
          "--hub-tenant",
          "tenant-fixture",
        ],
        "not an email address",
      ],
    ] as const) {
      expectRefused(await provision([...args], { stdin: SECRET, env: hubEnv }), reason);
    }
    expect(await owner()).toBeNull();

    const tenantUserId = randomUUID();
    const mapped = await provision(
      ["provision-owner", "--hub-user-id", tenantUserId, "--hub-tenant", "tenant-fixture"],
      { env: hubEnv },
    );
    expect(mapped, mapped.stderr).toMatchObject({ code: 0 });
    expect(await owner()).toBe(
      hubUserId("https://hub.example.test", "tenant-fixture", tenantUserId),
    );
    expect(await handles.prisma.user.count()).toBe(usersBefore);
    expect(await handles.prisma.account.count()).toBe(accountsBefore);
  });
});
