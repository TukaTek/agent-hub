import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  PortableFile,
  SandboxProvider,
} from "@cortexai-agent-hub/adapter-kit";
import type { ComputerMode } from "@cortexai-agent-hub/contracts";
import { parseScreenLeaseId } from "@cortexai-agent-hub/core";
import type { PrismaClient } from "@cortexai-agent-hub/db";
import { downloadFilenameCandidates, type SecretDownloadTarget } from "./bot-secrets.js";
import {
  normalizeWorkspacePath,
  resolveBotWorkspacePath,
  teamBotWorkspaceDirectory,
} from "./computer-support.js";
import { ensureContainedDirectory, LocalAgentHomeStore, resolveAgentHomePath } from "./home.js";

export const PORTABLE_TRANSFER_BATCH_BYTES = 8 * 1024 * 1024;

const skippedBrowserProfileDirectories = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "Crashpad",
]);
const skippedBrowserProfileFiles = new Set([
  "BrowserMetrics",
  "DevToolsActivePort",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  ".parentlock",
  "lock",
]);

/** Excludes transient browser state that is unsafe or wasteful to restore. */
export function shouldSkipPortableWorkspaceFile(relative: string) {
  if (!relative.startsWith(".browser-profiles/")) return false;
  const segments = relative.split("/");
  const name = segments.at(-1) ?? "";
  return (
    segments.some((segment) => skippedBrowserProfileDirectories.has(segment)) ||
    skippedBrowserProfileFiles.has(name)
  );
}

export async function restoreComputerWorkspace(
  home: AgentHomeStore,
  sandbox: SandboxProvider,
  homeKey: string,
  computer: ComputerRef,
  context: AdapterContext,
): Promise<void> {
  if (computer.kind === "docker" && home instanceof LocalAgentHomeStore) return;
  await sandbox.importWorkspace(computer, home.exportHome(homeKey, context), context);
}

/**
 * secret_request saves files into the running computer's `downloads/`, the folder the bot's
 * file tools and computer see. A local Docker computer mounts its home, so the response streams
 * straight into it; other computers get a staged copy through the sandbox API.
 */
export function createSecretDownloadTarget(
  deps: { home: AgentHomeStore; sandbox: SandboxProvider; dataDir?: string },
  computerRecord: { homeKey: string },
  computer: ComputerRef,
  scope: ComputerMode,
  botId: string,
  context: AdapterContext,
): SecretDownloadTarget & { dispose(): Promise<void> } {
  const workspaceDirectory = resolveBotWorkspacePath(scope, botId, "downloads");
  if (computer.kind === "docker" && deps.home instanceof LocalAgentHomeStore) {
    const homePath = resolveAgentHomePath(deps.home, computerRecord.homeKey, deps.dataDir);
    return {
      directory: () =>
        ensureContainedDirectory(homePath, path.join(homePath, ...workspaceDirectory.split("/"))),
      publish: async (_hostPath, filename) => `downloads/${filename}`,
      dispose: async () => undefined,
    };
  }
  let staging: string | undefined;
  return {
    directory: async () => {
      staging ??= await mkdtemp(path.join(tmpdir(), "cortexai-agent-hub-download-"));
      return staging;
    },
    publish: async (hostPath, filename) => {
      const taken = new Set(
        (await deps.sandbox.listFiles(computer, workspaceDirectory, context).catch(() => [])).map(
          (entry) => entry.path.split("/").pop(),
        ),
      );
      const name = [...downloadFilenameCandidates(filename)].find((c) => !taken.has(c));
      if (!name) throw new Error("No free filename in downloads/");
      await deps.sandbox.writeFile(
        computer,
        { path: path.posix.join(workspaceDirectory, name), content: await readFile(hostPath) },
        context,
      );
      return `downloads/${name}`;
    },
    dispose: async () => {
      if (staging) await rm(staging, { recursive: true, force: true });
    },
  };
}

export async function ensureComputerWorkspaceLayout(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  scope: ComputerMode,
  botId: string | undefined,
  context: AdapterContext,
): Promise<void> {
  if (scope !== "team" || !botId) return;
  let exitCode: number | undefined;
  let stderr = "";
  for await (const event of sandbox.execute(
    computer,
    { argv: ["mkdir", "-p", "shared", teamBotWorkspaceDirectory(botId)] },
    context,
  )) {
    if (event.type === "stderr") stderr += event.data;
    if (event.type === "exit") exitCode = event.code;
  }
  if (exitCode !== 0) {
    throw new Error(`Could not prepare Team Computer folders${stderr ? `: ${stderr.trim()}` : ""}`);
  }
}

export async function checkpointComputerWorkspace(
  home: AgentHomeStore,
  sandbox: SandboxProvider,
  homeKey: string,
  computer: ComputerRef,
  context: AdapterContext,
): Promise<string> {
  if (computer.kind === "docker" && home instanceof LocalAgentHomeStore) {
    return home.revise(homeKey);
  }
  const staging = await mkdtemp(path.join(tmpdir(), "cortexai-agent-hub-workspace-"));
  try {
    for await (const file of sandbox.exportWorkspace(computer, context)) {
      await writePortableFile(staging, file);
    }
    return await home.commit(homeKey, staging, context);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Remote exports quiesce browsers, so a run must not checkpoint while peers are driving them. */
export async function checkpointRunComputerWorkspace(
  deps: { home: AgentHomeStore; sandbox: SandboxProvider; prisma: PrismaClient },
  computerRecord: { id: string; homeKey: string; scope: string },
  computer: ComputerRef,
  context: AdapterContext,
): Promise<string | undefined> {
  if (computerRecord.scope !== "team" || computer.kind === "docker") {
    return checkpointAndRecordComputerWorkspace(deps, computerRecord, computer, context);
  }
  const now = new Date();
  const ownLease = context.screenLeaseId ? parseScreenLeaseId(context.screenLeaseId) : undefined;
  const claimed = await deps.prisma.computer.updateMany({
    where: {
      id: computerRecord.id,
      state: "running",
      providerRef: computer.providerRef,
      executionLeases: {
        none: {
          expiresAt: { gt: now },
          ...(ownLease ? { NOT: { runId: ownLease.ownerId, fence: ownLease.fence } } : {}),
        },
      },
      OR: [
        { controlHolder: { not: "user" } },
        { controlLeaseId: null },
        { controlLeaseExpiresAt: null },
        { controlLeaseExpiresAt: { lte: now } },
        ...(context.botId ? [{ controlBotId: context.botId }] : []),
      ],
    },
    data: { state: "suspending", updatedAt: now },
  });
  // The last finishing run or the already scheduled idle job will checkpoint the shared home.
  if (claimed.count !== 1) return undefined;
  try {
    return await checkpointAndRecordComputerWorkspace(deps, computerRecord, computer, context);
  } finally {
    await deps.prisma.computer.updateMany({
      where: { id: computerRecord.id, state: "suspending", providerRef: computer.providerRef },
      data: { state: "running" },
    });
  }
}

export async function checkpointAndRecordComputerWorkspace(
  deps: { home: AgentHomeStore; sandbox: SandboxProvider; prisma: PrismaClient },
  computerRecord: { id: string; homeKey: string },
  computer: ComputerRef,
  context: AdapterContext,
): Promise<string> {
  const revision = await checkpointComputerWorkspace(
    deps.home,
    deps.sandbox,
    computerRecord.homeKey,
    computer,
    context,
  );
  await deps.prisma.computer.updateMany({
    where: { id: computerRecord.id },
    data: { homeRevision: revision },
  });
  return revision;
}

async function writePortableFile(root: string, file: PortableFile) {
  const relative = normalizeWorkspacePath(file.path);
  if (!relative) throw new Error("Workspace snapshots cannot contain an empty file path");
  const target = path.resolve(root, relative);
  const resolvedRoot = path.resolve(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Workspace snapshot path escapes its staging directory");
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, file.content, { mode: file.executable ? 0o700 : 0o600 });
}
