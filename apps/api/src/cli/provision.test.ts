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
});
