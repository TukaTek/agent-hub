import { expect, it, vi } from "vitest";
import { collectPreflightInput } from "./preflight.js";

const revision = "22d7eb598c3cc72c047025df6d7a72d3612067a9";

it("collects deterministic read-only host, DNS, Git, and Compose facts", async () => {
  const compose = { services: {}, networks: {} };
  const runner = vi.fn((command: string, args: string[]) => {
    if (command === "docker") return { status: 0, stdout: JSON.stringify(compose) };
    return args[0] === "rev-parse"
      ? { status: 0, stdout: `${revision}\n` }
      : { status: 0, stdout: "" };
  });
  const lookup = vi.fn(async () => [{ address: "192.0.2.10", family: 4 as const }]);

  const input = await collectPreflightInput({
    cwd: "/srv/rakazo",
    env: {
      WEB_ORIGIN: "https://app.example.test",
    },
    runner,
    architecture: () => "x64",
    totalMemory: () => 8 * 1024 ** 3,
    freeDisk: async () => 64 * 1024 ** 3,
    lookup,
  });

  expect(input.host).toEqual({
    architecture: "x64",
    totalMemoryBytes: 8 * 1024 ** 3,
    freeDiskBytes: 64 * 1024 ** 3,
    currentRevision: revision,
    sourceClean: true,
    publicOriginResolved: true,
  });
  expect(input.compose).toEqual(compose);
  expect(lookup).toHaveBeenCalledWith("app.example.test", { all: true });
  expect(runner.mock.calls.map(([command, args]) => [command, args])).toEqual([
    ["git", ["rev-parse", "HEAD"]],
    ["git", ["status", "--porcelain=v1", "--untracked-files=normal"]],
    [
      "docker",
      [
        "compose",
        "--env-file",
        "/srv/rakazo/.env",
        "-f",
        "/srv/rakazo/infra/compose/docker-compose.prod.yml",
        "--profile",
        "updater",
        "config",
        "--format",
        "json",
      ],
    ],
  ]);
});

it.each(["127.0.0.1", "10.0.0.8", "169.254.1.2", "::1", "fd00::1", "fe80::1"])(
  "does not accept a private or local DNS answer: %s",
  async (address) => {
    const runner = vi.fn((command: string) =>
      command === "git"
        ? { status: 0, stdout: `${revision}\n` }
        : { status: 0, stdout: JSON.stringify({ services: {}, networks: {} }) },
    );
    const input = await collectPreflightInput({
      cwd: "/srv/rakazo",
      env: { WEB_ORIGIN: "https://app.example.test" },
      runner,
      architecture: () => "x64",
      totalMemory: () => 8 * 1024 ** 3,
      freeDisk: async () => 64 * 1024 ** 3,
      lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
    });
    expect(input.host.publicOriginResolved).toBe(false);
  },
);

it("marks a dirty checkout without printing its status output", async () => {
  const runner = vi.fn((command: string, args: string[]) => {
    if (command === "docker") {
      return { status: 0, stdout: JSON.stringify({ services: {}, networks: {} }) };
    }
    return args[0] === "rev-parse"
      ? { status: 0, stdout: `${revision}\n` }
      : { status: 0, stdout: " M private-filename\n" };
  });
  const input = await collectPreflightInput({
    cwd: "/srv/rakazo",
    env: { WEB_ORIGIN: "https://app.example.test" },
    runner,
    architecture: () => "x64",
    totalMemory: () => 8 * 1024 ** 3,
    freeDisk: async () => 64 * 1024 ** 3,
    lookup: async () => [{ address: "192.0.2.10", family: 4 }],
  });
  expect(input.host.sourceClean).toBe(false);
  expect(JSON.stringify(input.host)).not.toContain("private-filename");
});
