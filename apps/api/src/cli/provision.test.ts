import { hubAuthFromEnv, ProvisioningError } from "@cortexai-agent-hub/auth";
import { describe, expect, it, vi } from "vitest";
import {
  ProvisionUsageError,
  parseProvisionArgs,
  provisionExitCode,
  readProvisionSecret,
  runProvisionCommand,
} from "./provision.js";

const SECRET = "fixture-secret-value12";

function pipe(text: string, isTTY = false) {
  return {
    isTTY,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text);
    },
  };
}

describe("provision CLI arguments (CAAH-43)", () => {
  it("parses each command with space and = forms", () => {
    expect(
      parseProvisionArgs(["provision-owner", "--email", "Owner@Example.test", "--name=Owner"]),
    ).toEqual({
      command: "provision-owner",
      email: "Owner@Example.test",
      name: "Owner",
      secretFile: undefined,
      hubUserId: undefined,
      hubTenant: undefined,
    });
    expect(
      parseProvisionArgs(["transfer-owner", "--hub-user-id=tu-1", "--hub-tenant", "tenant-a"]),
    ).toMatchObject({ command: "transfer-owner", hubUserId: "tu-1", hubTenant: "tenant-a" });
    expect(
      parseProvisionArgs([
        "provision-user",
        "--email",
        "a@b.test",
        "--name",
        "A",
        "--secret-file",
        "/run/s",
      ]),
    ).toMatchObject({ secretFile: "/run/s" });
  });

  for (const argv of [
    ["provision-owner", "--email", "a@b.test", "--name", "A", "--password", SECRET],
    ["provision-owner", "--email", "a@b.test", "--name", "A", `--password=${SECRET}`],
    ["provision-owner", "--email", "a@b.test", "--name", "A", "--secret", SECRET],
    ["provision-owner", "--email", "a@b.test", "--name", "A", `--pass=${SECRET}`],
  ]) {
    it(`refuses a password argument without echoing it: ${argv[5]!.split("=")[0]}`, () => {
      let error: unknown;
      try {
        parseProvisionArgs(argv);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ProvisionUsageError);
      expect(String((error as Error).message)).toContain("never accepted as arguments");
      expect(String((error as Error).message)).not.toContain(SECRET);
      expect(provisionExitCode(error)).toBe(2);
    });
  }

  for (const argv of [
    [],
    ["signup"],
    ["provision-owner", SECRET],
    ["provision-owner", "--email", "a@b.test", "--email", "c@d.test"],
    ["provision-owner", "--email"],
    ["provision-owner", "--email", "--name"],
    ["provision-owner", "--owner"],
  ]) {
    it(`refuses malformed arguments: ${JSON.stringify(argv)}`, () => {
      expect(() => parseProvisionArgs(argv)).toThrow(ProvisionUsageError);
      try {
        parseProvisionArgs(argv);
      } catch (error) {
        expect((error as Error).message).not.toContain(SECRET);
      }
    });
  }
});

describe("provision secret input", () => {
  it("reads piped stdin and drops one trailing line break", async () => {
    expect(await readProvisionSecret({}, pipe(`${SECRET}\n`))).toBe(SECRET);
    expect(await readProvisionSecret({}, pipe(`${SECRET}\r\n`))).toBe(SECRET);
    expect(await readProvisionSecret({}, pipe(` ${SECRET} \n\n`))).toBe(` ${SECRET} \n`);
  });

  it("reads --secret-file instead of stdin", async () => {
    const read = vi.fn(async () => `${SECRET}\n`);
    const stdin = pipe("ignored");
    expect(await readProvisionSecret({ secretFile: "/run/secrets/owner" }, stdin, read)).toBe(
      SECRET,
    );
    expect(read).toHaveBeenCalledWith("/run/secrets/owner");
    await expect(
      readProvisionSecret({ secretFile: "/missing" }, stdin, async () => {
        throw new Error(`ENOENT ${SECRET}`);
      }),
    ).rejects.toThrow("Could not read --secret-file");
  });

  it("refuses an interactive terminal instead of prompting with echo", async () => {
    await expect(readProvisionSecret({}, pipe(SECRET, true))).rejects.toThrow(ProvisionUsageError);
  });

  it("never reads a password from the environment", async () => {
    const saved = { ...process.env };
    try {
      for (const key of ["PASSWORD", "PROVISION_PASSWORD", "OWNER_PASSWORD", "ADMIN_PASSWORD"]) {
        process.env[key] = SECRET;
      }
      expect(await readProvisionSecret({}, pipe(""))).toBe("");
    } finally {
      process.env = saved;
    }
  });
});

describe("provision command routing", () => {
  const out = vi.fn();
  // No database calls may happen for a refused command.
  const prisma = new Proxy(
    {},
    {
      get: () => {
        throw new Error("database touched");
      },
    },
  ) as never;

  it("refuses Hub flags in local mode and local credentials in Hub mode", async () => {
    await expect(
      runProvisionCommand(
        { command: "provision-owner", email: "a@b.test", name: "A", hubUserId: "tu-1" },
        { prisma, hub: undefined, stdin: pipe(SECRET), out },
      ),
    ).rejects.toThrow("AUTH_MODE=hub");
    const hub = { origin: "https://hub.example.test", tenantId: "tenant-a" } as never;
    await expect(
      runProvisionCommand(
        { command: "provision-user", email: "a@b.test", name: "A" },
        {
          prisma,
          hub,
          stdin: pipe(SECRET),
          out,
        },
      ),
    ).rejects.toThrow("provision-user is unavailable");
    for (const extra of [{ email: "a@b.test" }, { name: "A" }, { secretFile: "/run/s" }]) {
      await expect(
        runProvisionCommand(
          { command: "provision-owner", hubUserId: "tu-1", hubTenant: "tenant-a", ...extra },
          { prisma, hub, stdin: pipe(SECRET), out },
        ),
      ).rejects.toThrow("no local password is created");
    }
    await expect(
      runProvisionCommand(
        { command: "provision-owner", hubTenant: "tenant-a" },
        {
          prisma,
          hub,
          stdin: pipe(SECRET),
          out,
        },
      ),
    ).rejects.toThrow("--hub-user-id is required");
    expect(out).not.toHaveBeenCalled();
  });

  // M1: the tenant check must never be skipped. Without HUB_AUTH_TENANT_ID the operator's
  // --hub-tenant would otherwise become the owner's tenant.
  const mapping = { command: "provision-owner", hubUserId: "tu-1", hubTenant: "tenant-a" } as const;

  it("refuses Hub owner mapping before touching the database when HUB_AUTH_TENANT_ID is missing", async () => {
    for (const tenantId of [undefined, "", "  "]) {
      const hub = { origin: "https://hub.example.test", tenantId } as never;
      for (const command of ["provision-owner", "transfer-owner"] as const) {
        await expect(
          runProvisionCommand({ ...mapping, command }, { prisma, hub, stdin: pipe(""), out }),
        ).rejects.toMatchObject({
          code: "NOT_CONFIGURED",
          message: expect.stringContaining("set HUB_AUTH_TENANT_ID first"),
        });
      }
    }
    expect(out).not.toHaveBeenCalled();
  });

  it("refuses Hub owner mapping when Hub mode is not configured", async () => {
    // The real parser: AUTH_MODE=hub without HUB_AUTH_TENANT_ID yields notConfigured.
    const parsed = hubAuthFromEnv({
      AUTH_MODE: "hub",
      HUB_AUTH_ORIGIN: "https://hub.example.test",
    });
    expect(parsed?.notConfigured).toBeDefined();
    expect(parsed?.tenantId).toBeUndefined();
    // Even a notConfigured config that somehow carries a tenant is refused.
    const withTenant = { ...parsed, tenantId: "tenant-a" } as never;
    for (const hub of [parsed as never, withTenant]) {
      const refusal = runProvisionCommand(mapping, { prisma, hub, stdin: pipe(""), out });
      await expect(refusal).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
      await expect(refusal).rejects.toThrow("set HUB_AUTH_TENANT_ID first");
    }
    expect(provisionExitCode(new ProvisioningError("NOT_CONFIGURED", "x"))).toBe(1);
    expect(out).not.toHaveBeenCalled();
  });
});
