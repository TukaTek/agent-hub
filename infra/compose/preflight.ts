#!/usr/bin/env -S pnpm exec tsx

import { spawnSync } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { statfs } from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import {
  type CommandRunner,
  createDeploymentManifest,
  type PreflightInput,
  renderComposeConfig,
  validateProductionPreflight,
} from "./deployment-preflight.js";

interface CollectorDependencies {
  cwd: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  architecture: () => string;
  totalMemory: () => number;
  freeDisk: (cwd: string) => Promise<number>;
  lookup: (
    hostname: string,
    options: { all: true },
  ) => Promise<readonly { address: string; family: number }[]>;
}

export async function collectPreflightInput(
  dependencies: CollectorDependencies,
): Promise<PreflightInput> {
  const revisionResult = dependencies.runner("git", ["rev-parse", "HEAD"], {
    cwd: dependencies.cwd,
    env: dependencies.env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (revisionResult.status !== 0) {
    throw new Error("The current source revision could not be resolved.");
  }
  const statusResult = dependencies.runner(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    {
      cwd: dependencies.cwd,
      env: dependencies.env,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
  if (statusResult.status !== 0) {
    throw new Error("The current source state could not be verified.");
  }
  const indexFlagsResult = dependencies.runner("git", ["ls-files", "-v", "--full-name"], {
    cwd: dependencies.cwd,
    env: dependencies.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (indexFlagsResult.status !== 0) {
    throw new Error("The tracked source index could not be verified.");
  }
  const sourceIndexFlagsClear = indexFlagsResult.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .every((entry) => !/^(?:[a-z]|S) /.test(entry));

  let publicOriginResolved = false;
  try {
    const hostname = new URL(dependencies.env.WEB_ORIGIN ?? "").hostname;
    if (hostname) {
      const addresses = await dependencies.lookup(hostname, { all: true });
      publicOriginResolved =
        addresses.length > 0 && addresses.every(({ address }) => isPublicAddress(address));
    }
  } catch {
    publicOriginResolved = false;
  }

  const composeFile = path.join(dependencies.cwd, "infra", "compose", "docker-compose.prod.yml");
  return {
    env: dependencies.env,
    host: {
      architecture: dependencies.architecture(),
      totalMemoryBytes: dependencies.totalMemory(),
      freeDiskBytes: await dependencies.freeDisk(dependencies.cwd),
      currentRevision: revisionResult.stdout.trim(),
      sourceClean: statusResult.stdout.trim().length === 0 && sourceIndexFlagsClear,
      sourceIndexFlagsClear,
      publicOriginResolved,
    },
    compose: renderComposeConfig(dependencies.runner, {
      cwd: dependencies.cwd,
      envFile: path.join(dependencies.cwd, ".env"),
      composeFile,
      env: dependencies.env,
    }),
  };
}

const NON_GLOBAL_IPV4_CIDRS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const;

const NON_GLOBAL_IPV6_CIDRS = [
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const;

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const numericAddress = ipv4ToNumber(address);
    return !NON_GLOBAL_IPV4_CIDRS.some(([base, prefix]) =>
      numberInCidr(numericAddress, ipv4ToNumber(base), prefix, 32),
    );
  }
  if (version !== 6) return false;
  const numericAddress = ipv6ToBigInt(address);
  const mappedPrefix = ipv6ToBigInt("::ffff:0:0");
  if (numberInCidr(numericAddress, mappedPrefix, 96, 128)) {
    return isPublicAddress(numberToIpv4(Number(numericAddress & 0xffffffffn)));
  }
  return !NON_GLOBAL_IPV6_CIDRS.some(([base, prefix]) =>
    numberInCidr(numericAddress, ipv6ToBigInt(base), prefix, 128),
  );
}

function ipv4ToNumber(address: string): bigint {
  return address
    .split(".")
    .map(Number)
    .reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function numberToIpv4(address: number): string {
  const unsigned = address >>> 0;
  return [24, 16, 8, 0].map((shift) => (unsigned >>> shift) & 0xff).join(".");
}

function ipv6ToBigInt(address: string): bigint {
  let normalized = address.toLowerCase();
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4 = Number(ipv4ToNumber(normalized.slice(lastColon + 1)));
    normalized = `${normalized.slice(0, lastColon)}:${(ipv4 >>> 16).toString(16)}:${(
      ipv4 & 0xffff
    ).toString(16)}`;
  }
  const halves = normalized.split("::");
  const leading = halves[0] ? halves[0].split(":") : [];
  const trailing = halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - leading.length - trailing.length : 0;
  const hextets = [...leading, ...Array.from({ length: fill }, () => "0"), ...trailing];
  return hextets.reduce((value, hextet) => (value << 16n) | BigInt(`0x${hextet}`), 0n);
}

function numberInCidr(address: bigint, base: bigint, prefix: number, bits: number): boolean {
  const shift = BigInt(bits - prefix);
  return address >> shift === base >> shift;
}

function commandRunner(
  command: string,
  args: string[],
  options: Parameters<CommandRunner>[2],
): ReturnType<CommandRunner> {
  const result = spawnSync(command, args, options);
  return { status: result.status, stdout: result.stdout ?? "" };
}

async function freeDisk(cwd: string): Promise<number> {
  const stats = await statfs(cwd, { bigint: true });
  return Number(stats.bavail * stats.bsize);
}

async function main() {
  const cwd = process.cwd();
  loadEnvFile(path.join(cwd, ".env"));
  const input = await collectPreflightInput({
    cwd,
    env: process.env,
    runner: commandRunner,
    architecture: os.arch,
    totalMemory: os.totalmem,
    freeDisk,
    lookup: dnsLookup,
  });
  const result = validateProductionPreflight(input);
  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
    return;
  }
  const manifest = createDeploymentManifest(input);
  if (process.argv.includes("--inventory")) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  console.log(JSON.stringify({ ...result, deployment: manifest }, null, 2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Production preflight failed.");
    process.exitCode = 1;
  });
}
