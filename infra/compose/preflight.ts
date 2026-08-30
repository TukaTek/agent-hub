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
      sourceClean: statusResult.stdout.trim().length === 0,
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

function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [first = 0, second = 0, third = 0] = address.split(".").map(Number);
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0 && third === 0) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19))
    );
  }
  if (version !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPublicAddress(normalized.slice("::ffff:".length));
  }
  if (normalized === "::" || normalized === "::1") return false;
  const firstHextet = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  return (
    (firstHextet & 0xfe00) !== 0xfc00 &&
    (firstHextet & 0xffc0) !== 0xfe80 &&
    (firstHextet & 0xff00) !== 0xff00
  );
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
