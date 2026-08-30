import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type CommandRunner, validateProductionPreflight } from "./deployment-preflight.js";
import { collectPreflightInput, isPublicAddress } from "./preflight.js";

const revision = "22d7eb598c3cc72c047025df6d7a72d3612067a9";

it("collects deterministic read-only host, DNS, Git, and Compose facts", async () => {
  const compose = { services: {}, networks: {} };
  const runner = vi.fn((command: string, args: string[]) => {
    if (command === "docker") return { status: 0, stdout: JSON.stringify(compose) };
    return args[0] === "rev-parse"
      ? { status: 0, stdout: `${revision}\n` }
      : { status: 0, stdout: "" };
  });
  const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);

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
    sourceIndexFlagsClear: true,
    publicOriginResolved: true,
  });
  expect(input.compose).toEqual(compose);
  expect(lookup).toHaveBeenCalledWith("app.example.test", { all: true });
  expect(runner.mock.calls.map(([command, args]) => [command, args])).toEqual([
    ["git", ["rev-parse", "HEAD"]],
    ["git", ["status", "--porcelain=v1", "--untracked-files=normal"]],
    ["git", ["ls-files", "-v", "--full-name"]],
    [
      "docker",
      [
        "compose",
        "--env-file",
        "/srv/rakazo/.env",
        "-f",
        "/srv/rakazo/infra/compose/docker-compose.prod.yml",
        "config",
        "--format",
        "json",
      ],
    ],
  ]);
});

describe("isPublicAddress", () => {
  it.each([
    ["unspecified", "0.0.0.1"],
    ["private 10/8", "10.0.0.8"],
    ["carrier-grade NAT", "100.64.0.1"],
    ["loopback", "127.0.0.1"],
    ["link-local", "169.254.1.2"],
    ["private 172.16/12", "172.31.255.254"],
    ["IETF protocol assignments", "192.0.0.1"],
    ["TEST-NET-1", "192.0.2.10"],
    ["6to4 relay anycast", "192.88.99.1"],
    ["private 192.168/16", "192.168.1.1"],
    ["benchmarking", "198.18.0.1"],
    ["TEST-NET-2", "198.51.100.7"],
    ["TEST-NET-3", "203.0.113.9"],
    ["multicast", "224.0.0.1"],
    ["reserved", "240.0.0.1"],
    ["limited broadcast", "255.255.255.255"],
    ["unspecified IPv6", "::"],
    ["loopback IPv6", "::1"],
    ["IPv4-compatible", "::192.0.2.10"],
    ["IPv4-mapped non-global", "::ffff:192.0.2.10"],
    ["discard-only", "100::1"],
    ["benchmarking IPv6", "2001:2::1"],
    ["ORCHID", "2001:10::1"],
    ["ORCHIDv2", "2001:20::1"],
    ["documentation IPv6", "2001:db8::1"],
    ["deprecated 6to4", "2002::1"],
    ["documentation IPv6 3fff", "3fff::1"],
    ["unique-local", "fd00::1"],
    ["site-local", "fec0::1"],
    ["link-local IPv6", "fe80::1"],
    ["multicast IPv6", "ff02::1"],
  ])("rejects the %s range (%s)", (_className, address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])(
    "accepts a global unicast address (%s)",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

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
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  expect(input.host.sourceClean).toBe(false);
  expect(JSON.stringify(input.host)).not.toContain("private-filename");
});

describe.each([
  ["assume-unchanged", "--assume-unchanged"],
  ["skip-worktree", "--skip-worktree"],
])("Git %s bypass regression", (_flagName, updateFlag) => {
  it("does not certify modified tracked build-context bytes hidden from porcelain", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "caah-19-index-flag-"));
    try {
      const buildContextFile = path.join(directory, "build-context.txt");
      runGit(directory, ["init", "--quiet"]);
      runGit(directory, ["config", "user.email", "caah-19@example.invalid"]);
      runGit(directory, ["config", "user.name", "CAAH-19 fixture"]);
      writeFileSync(buildContextFile, "committed build bytes\n", "utf8");
      runGit(directory, ["add", "build-context.txt"]);
      runGit(directory, ["commit", "--quiet", "-m", "fixture"]);
      const fixtureRevision = runGit(directory, ["rev-parse", "HEAD"]).stdout.trim();
      runGit(directory, ["update-index", updateFlag, "build-context.txt"]);
      writeFileSync(buildContextFile, "modified build bytes\n", "utf8");
      expect(runGit(directory, ["status", "--porcelain=v1"]).stdout).toBe("");

      const runner = vi.fn(
        (command: string, args: string[], options: Parameters<CommandRunner>[2]) => {
          if (command === "docker") {
            return { status: 0, stdout: JSON.stringify({ services: {}, networks: {} }) };
          }
          const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" });
          return { status: result.status, stdout: result.stdout ?? "" };
        },
      );
      const input = await collectPreflightInput({
        cwd: directory,
        env: {
          ...process.env,
          WEB_ORIGIN: "https://app.example.test",
          GIT_SHA: fixtureRevision,
          RAKAZO_IMAGE: "ghcr.io/example/app",
          RAKAZO_IMAGE_TAG: `sha-${fixtureRevision}`,
        },
        runner,
        architecture: () => "x64",
        totalMemory: () => 8 * 1024 ** 3,
        freeDisk: async () => 64 * 1024 ** 3,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      });

      expect(readFileSync(buildContextFile, "utf8")).toBe("modified build bytes\n");
      expect(input.host.sourceIndexFlagsClear).toBe(false);
      expect(input.host.sourceClean).toBe(false);
      expect(
        validateProductionPreflight(input).checks.find(
          (check) => check.subject === "source-revision",
        )?.status,
      ).not.toBe("ok");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function runGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result;
}
