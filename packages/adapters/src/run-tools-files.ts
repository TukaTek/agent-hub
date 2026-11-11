import { posix as posixPath } from "node:path";
import type { AgentRunRequest, ComputerRef } from "@cortexai-agent-hub/adapter-kit";
import { ATTACHMENT_MAX_BYTES } from "@cortexai-agent-hub/contracts";
import {
  inferAttachmentMimeType,
  isBackgroundRunTrigger,
  redactSecrets,
} from "@cortexai-agent-hub/core";
import { getLogger } from "@cortexai-agent-hub/logging";
import { attachFailure, unsupportedAttachmentError } from "./attach-file-errors.js";
import { resolveBotWorkspacePath } from "./computer-support.js";
import { desktopProtectionGuardMessage } from "./desktop-command-guard.js";
import { protectedActivateScriptWriteRefusal } from "./desktop-guard-words.js";
import { generateMediaFromTool } from "./media-generation-tools.js";
import type { RunContext } from "./run-context.js";
import { persistMessageInTransaction, publishMessage } from "./run-messages.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { recordComputerAction } from "./run-tools-computer.js";
import { attachWorkspaceFileToThread } from "./thread-artifacts.js";
import {
  MAX_SPILL_CHARS,
  SPILL_DIRECTORY,
  spillPruneCommand,
  spillRelativePath,
  spillUserKey,
} from "./tool-result-spill.js";
import { textContentArg } from "./tool-text.js";
import type { RunWorkspace } from "./workspace-file-tools.js";
import {
  isForeignSpillPath,
  listFilesFromTool,
  readFileFromTool,
  renderPlotFromTool,
  resolveFileToolPath,
} from "./workspace-file-tools.js";

function runWorkspace(ctx: RunContext, call: Pick<ToolCall, "name">): RunWorkspace {
  return {
    botId: ctx.bot.id,
    computerMode: ctx.computer.mode,
    computer: () => ctx.computer.get("tool", call.name),
    markDirty: () => ctx.computer.checkpoint.markDirty(),
    context: ctx.context,
    runSecrets: ctx.secrets,
    workspaceRoot: ctx.computer.workspaceRoot,
    spillUser: spillUserKey(ctx.run.spaceId, ctx.run.userId),
  };
}

const SPILL_GUARDED_FILE_TOOLS = new Set(["read_file", "list_files", "open_path", "attach_file"]);

/** File tools answer "not found" for another user's saved tool results. */
export function refusesForeignSpill(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
): boolean {
  if (!SPILL_GUARDED_FILE_TOOLS.has(name) || typeof args.path !== "string") return false;
  const requested = args.path;
  if (/^https?:\/\//i.test(requested)) return false;
  const workspace = runWorkspace(ctx, { name });
  let stored: string;
  try {
    stored = resolveFileToolPath(workspace, requested);
  } catch {
    // The tool itself reports an invalid path.
    return false;
  }
  return isForeignSpillPath(workspace, stored);
}

/** Saves an oversized tool result to the run's computer so the model can page through it. */
export function createToolResultSpill(
  ctx: RunContext,
): NonNullable<AgentRunRequest["spillToolResult"]> {
  const { deps, run, bot, context } = ctx;
  const stored = ctx.computer.stored;
  const spillUser = spillUserKey(run.spaceId, run.userId);
  let spillSeq = 0;
  return async ({ toolName, text }) => {
    // Team Computers are space-trusted like attachments; a private one belongs to its owner.
    if (stored.scope === "dedicated" && stored.userId !== run.userId) {
      return { unavailable: "shared-computer" };
    }
    // Redact before capping so the cut cannot expose part of a secret.
    const redacted = redactSecrets(text, ctx.secrets);
    let saved = redacted.slice(0, MAX_SPILL_CHARS);
    if (saved.length < redacted.length && /[\uD800-\uDBFF]$/.test(saved)) {
      saved = saved.slice(0, -1);
    }
    spillSeq += 1;
    const storedPath = resolveBotWorkspacePath(
      ctx.computer.mode,
      bot.id,
      spillRelativePath({ userKey: spillUser, runId: run.id, seq: spillSeq, toolName }),
    );
    const userDirectory = resolveBotWorkspacePath(
      ctx.computer.mode,
      bot.id,
      `${SPILL_DIRECTORY}/${spillUser}`,
    );
    let computer: ComputerRef;
    try {
      computer = await ctx.computer.get("tool", toolName);
    } catch (error) {
      getLogger().error("tool result spill", error);
      return { unavailable: "no-computer" };
    }
    try {
      for await (const _event of deps.sandbox.execute(
        computer,
        { argv: ["sh", "-c", spillPruneCommand(userDirectory)], timeoutMs: 15_000 },
        context,
      )) {
        // Pruning output is not shown; a failed prune must not block the write.
      }
    } catch (error) {
      getLogger().error("tool result spill prune", error);
    }
    try {
      await deps.sandbox.writeFile(
        computer,
        { path: storedPath, content: new TextEncoder().encode(saved) },
        context,
      );
    } catch (error) {
      getLogger().error("tool result spill", error);
      return { unavailable: "no-computer" };
    }
    const root = ctx.computer.workspaceRoot;
    return {
      path: root ? posixPath.join(root, storedPath) : storedPath,
      totalChars: redacted.length,
      savedChars: saved.length,
    };
  };
}

/** Generate an image or video, or with recoverOnly, only resume a job an earlier attempt started. */
export async function callMediaTool(ctx: RunContext, call: ToolCall, recoverOnly = false) {
  const { deps, run, bot, thread, context } = ctx;
  const { name, args, executionId, applied } = call;
  const mediaGeneration = ctx.providers.mediaGeneration;
  if (
    (name !== "generate_image" && name !== "generate_video") ||
    isBackgroundRunTrigger(run.trigger) ||
    !mediaGeneration ||
    !deps.artifacts
  )
    return { error: "Media generation is unavailable." };
  const artifacts = deps.artifacts;
  return generateMediaFromTool({
    name,
    args,
    executionId: applied?.effect.id ?? executionId,
    recoverOnly,
    provider: mediaGeneration,
    prisma: deps.prisma,
    context,
    run,
    attach: (output, fileName, job) =>
      attachWorkspaceFileToThread(
        { prisma: deps.prisma, artifacts, maxUploadSizeBytes: deps.maxUploadSizeBytes },
        {
          spaceId: run.spaceId,
          userId: run.userId,
          botId: bot.id,
          groupId: thread.groupId ?? undefined,
          runId: run.id,
          filePath: fileName,
          bytes: output.bytes,
          operationId: executionId,
          onAttached: async (tx, artifact) => {
            const checkpointed = await tx.externalEffect.updateMany({
              where: {
                id: job.id,
                status: { not: "media_completed" },
                result: { equals: job.result },
              },
              data: {
                status: "media_polling",
                result: { ...job.result, artifactId: artifact.id },
              },
            });
            if (!checkpointed.count) throw new Error("Media attachment was already checkpointed");
          },
        },
      ),
    publish: async (block, jobId, artifactId) => {
      const committed = await deps.prisma.$transaction(async (tx) => {
        // Commit completion with the message so a restarted poll cannot post twice.
        const claimed = await tx.externalEffect.updateMany({
          where: { id: jobId, status: { not: "media_completed" } },
          data: {
            status: "media_completed",
            result: { provider: mediaGeneration.id, artifactId },
          },
        });
        if (!claimed.count) return null;
        return persistMessageInTransaction(tx, run, "bot", [block]);
      });
      if (committed)
        await deps.events
          .notify(run.threadId, committed.eventSeq, committed.firstResponseRunId)
          .catch(() => undefined);
    },
  });
}

async function generateMedia(ctx: RunContext, call: ToolCall) {
  return call.finish(await callMediaTool(ctx, call));
}

/** Workspace files, attachments, plots and generated media. */
export const fileTools: ToolHandlers = {
  async list_files(ctx, call) {
    const { deps } = ctx;
    const { args } = call;
    const workspace = runWorkspace(ctx, call);
    return listFilesFromTool(deps.sandbox, workspace, args);
  },
  async read_file(ctx, call) {
    const { deps } = ctx;
    const { args } = call;
    const workspace = runWorkspace(ctx, call);
    return readFileFromTool(deps.sandbox, workspace, args);
  },
  async write_file(ctx, call) {
    const { deps, bot, context } = ctx;
    const { name, args } = call;
    const filePath = String(args.path ?? "notes/result.txt");
    if (ctx.computer.graphical) {
      const activateRefusal = protectedActivateScriptWriteRefusal(filePath);
      if (activateRefusal) {
        return call.finish({ error: desktopProtectionGuardMessage(activateRefusal) });
      }
    }
    const content = new TextEncoder().encode(textContentArg(args.content, ""));
    ctx.computer.checkpoint.markDirty();
    try {
      await deps.sandbox.writeFile(
        await ctx.computer.get("tool", name),
        { path: resolveBotWorkspacePath(ctx.computer.mode, bot.id, filePath), content },
        context,
      );
    } catch (error) {
      await recordComputerAction(ctx, call, "write_file", filePath, {
        error: error instanceof Error ? error.message : "could not write file",
      });
      throw error;
    }
    await recordComputerAction(ctx, call, "write_file", filePath, { bytes: content.byteLength });
    return call.finish({ ok: true, path: filePath });
  },
  generate_image: generateMedia,
  generate_video: generateMedia,
  async render_plot(ctx, call) {
    const { deps, run } = ctx;
    const { args, executionId } = call;
    const workspace = runWorkspace(ctx, call);
    return renderPlotFromTool(deps, run, args, executionId, workspace, call.finish);
  },
  async attach_file(ctx, call) {
    const { deps, run, bot, thread, context } = ctx;
    const { name, args, executionId } = call;
    const filePath = String(args.path ?? "");
    // The activity log shows the short reason; the model also gets the delivery guidance.
    const failAttach = async (error: string, modelError = attachFailure(error)) => {
      await recordComputerAction(ctx, call, "attach_file", filePath, { error });
      return call.finish({ error: modelError, path: filePath });
    };
    if (!deps.artifacts) return failAttach("artifact storage unavailable");
    const storedPath = resolveFileToolPath(runWorkspace(ctx, call), filePath);
    let bytes: Uint8Array;
    const tooLarge = "file exceeds the 10 MiB attachment limit";
    try {
      bytes = await deps.sandbox.readFile(
        await ctx.computer.get("tool", name),
        storedPath,
        context,
        { maxBytes: deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES },
      );
    } catch (error) {
      if (error instanceof Error && /exceeds \d+ bytes/.test(error.message)) {
        return failAttach(tooLarge);
      }
      return failAttach("file not found or unreadable");
    }
    if (bytes.byteLength > ATTACHMENT_MAX_BYTES) return failAttach(tooLarge);
    const mimeType = inferAttachmentMimeType(filePath);
    if (!mimeType) {
      return failAttach("unsupported attachment type", unsupportedAttachmentError(filePath));
    }
    try {
      const attached = await attachWorkspaceFileToThread(
        {
          prisma: deps.prisma,
          artifacts: deps.artifacts,
          maxUploadSizeBytes: deps.maxUploadSizeBytes,
        },
        {
          spaceId: run.spaceId,
          userId: run.userId,
          botId: bot.id,
          groupId: thread.groupId ?? undefined,
          runId: run.id,
          filePath,
          bytes,
          operationId: executionId,
          name: typeof args.name === "string" ? args.name : undefined,
          description: typeof args.description === "string" ? args.description : undefined,
        },
      );
      await publishMessage(deps, run, "bot", [attached.block]);
      await recordComputerAction(ctx, call, "attach_file", filePath);
      return call.finish({ ok: true, artifactId: attached.artifactId, path: filePath });
    } catch (error) {
      return failAttach(error instanceof Error ? error.message : "could not attach file");
    }
  },
};
