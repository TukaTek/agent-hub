import type { SemanticMemoryProvider } from "@cortexai-agent-hub/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@cortexai-agent-hub/adapter-kit";
import { HistoryReadInputSchema, HistorySearchInputSchema } from "@cortexai-agent-hub/contracts";
import { readHistory, searchHistory } from "@cortexai-agent-hub/db";
import { sharedMemorySaveError } from "./builtin-tools.js";
import { redactConnectorPayload } from "./connector-safety.js";
import { MAX_RECALLED_MEMORIES } from "./history-compaction.js";
import { appendMemoryFact, runMemoryTool } from "./memory-tools.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

/** Short memory text is not redacted: replacing every occurrence would garble the error. */
const MIN_REDACTED_MEMORY_TEXT_CHARS = 8;

function memoryToolOptions(
  provider: SemanticMemoryProvider,
  signal: AbortSignal,
  secrets: string[],
  memoryText: string,
) {
  const text = memoryText.trim();
  return {
    provider: provider.describe().id,
    signal,
    redact: text.length >= MIN_REDACTED_MEMORY_TEXT_CHARS ? [...secrets, text] : secrets,
  };
}

/** Cross-chat history requires a surviving direct human request in this app thread. */
export function historyMyChatsAllowed(
  run: { trigger: string; threadId: string },
  source: { role: string; threadId: string } | null,
  external: boolean,
): boolean {
  return (
    !external &&
    (run.trigger === "user" || run.trigger === "follow_up") &&
    source?.role === "user" &&
    source.threadId === run.threadId
  );
}

async function readHistoryTool(ctx: RunContext, call: ToolCall) {
  const { deps, run } = ctx;
  const { name, args } = call;
  const crossChat =
    name === "search_history"
      ? args.scope === "my_chats"
      : typeof args.threadId === "string" && args.threadId !== run.threadId;
  // Channel or webhook text claimed mid-turn revokes the grant for the rest of the run.
  const allowMyChats =
    crossChat && ctx.source.myChatsAllowed && !(await ctx.trust.receivedOutsideMessage());
  const scope = {
    spaceId: run.spaceId,
    userId: run.userId,
    threadId: run.threadId,
    botId: run.botId,
    channelId: ctx.source.channelId,
    searchBeforeSeq: ctx.source.historySearchBeforeSeq,
    allowMyChats,
    searchAt: run.createdAt,
  };
  const response =
    name === "search_history"
      ? await searchHistory(deps.prisma, scope, HistorySearchInputSchema.parse(args))
      : await readHistory(deps.prisma, scope, HistoryReadInputSchema.parse(args));
  const redacted = redactConnectorPayload(response, ctx.secrets);
  // Redaction can expand short synthetic credentials; never let Pi clip the JSON.
  if (Buffer.byteLength(JSON.stringify(redacted), "utf8") > 11_000) {
    return call.finish({
      untrusted: true,
      error:
        "Redacted history exceeds the response budget. Retry with limit 1 or a narrower linked run.",
    });
  }
  return call.finish(redacted);
}

/** Memory documents, semantic memory and thread history. */
export const memoryTools: ToolHandlers = {
  async remember(ctx, call) {
    const { deps, runId, bot, thread, context } = ctx;
    const { args } = call;
    const path = String(args.path ?? "").trim() || "MEMORY.md";
    // A fact is added to the document, never replaces it. A concurrent save
    // changes the revision, so re-read and append again.
    for (let attempt = 1; ; attempt += 1) {
      const snapshot = await deps.memory.read({ scope: "bot", botId: bot.id, path }, context);
      const existing = snapshot.documents[0];
      const content = appendMemoryFact(existing?.content ?? "", String(args.content ?? ""));
      if (content === (existing?.content ?? "")) return call.finish({ ok: true });
      try {
        await deps.memory.commit(
          {
            scope: "bot",
            botId: bot.id,
            path,
            content,
            expectedRevision: existing?.revision ?? 0,
            sourceRunId: runId,
            sourceThreadId: thread.id,
          },
          context,
        );
        return call.finish({ ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message !== MEMORY_REVISION_CONFLICT_ERROR || attempt >= 3) throw error;
      }
    }
  },
  async save_shared_memory(ctx, call) {
    const { deps, runId, thread, context } = ctx;
    const { args } = call;
    const invalid = sharedMemorySaveError(args);
    if (invalid) return call.finish({ error: invalid });
    const path = String(args.path ?? "").trim();
    // The save replaces the whole document. Pass the revision just read so a
    // concurrent edit is rejected instead of overwritten.
    const snapshot = await deps.memory.read({ scope: "user", path }, context);
    const expectedRevision = snapshot.documents[0]?.revision ?? 0;
    try {
      const saved = await deps.memory.commit(
        {
          scope: "user",
          path,
          content: String(args.content ?? ""),
          expectedRevision,
          sourceRunId: runId,
          sourceThreadId: thread.id,
        },
        context,
      );
      return call.finish({ ok: true, path: saved.path, revision: saved.revision });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save shared memory.";
      if (message === MEMORY_REVISION_CONFLICT_ERROR) return call.finish({ error: message });
      throw error;
    }
  },
  async recall_memory(ctx, call) {
    const { bot, thread, context } = ctx;
    const { args } = call;
    const semantic = ctx.memory.semantic!;
    const query = String(args.query ?? "");
    return runMemoryTool(
      "recall_memory",
      () =>
        semantic.recall(
          {
            query,
            scope: ctx.memory.scope!,
            botId: bot.id,
            ...(thread.historyCompactedUpToSeq == null
              ? {}
              : { historyGeneration: thread.historyCompactionGeneration }),
            limit: MAX_RECALLED_MEMORIES,
          },
          context,
        ),
      memoryToolOptions(semantic, context.signal, ctx.secrets, query),
    );
  },
  search_history: readHistoryTool,
  read_history: readHistoryTool,
  async save_memory(ctx, call) {
    const { bot, context } = ctx;
    const { args } = call;
    const semantic = ctx.memory.semantic!;
    const content = String(args.content ?? "");
    return call.finish(
      await runMemoryTool(
        "save_memory",
        () =>
          semantic.save(
            { content, scope: ctx.memory.scope!, botId: bot.id, source: { kind: "durable" } },
            context,
          ),
        memoryToolOptions(semantic, context.signal, ctx.secrets, content),
      ),
    );
  },
  async forget_memory(ctx, call) {
    const { bot, context } = ctx;
    const { args } = call;
    const semantic = ctx.memory.semantic;
    if (!semantic?.forget) {
      return call.finish({
        error: "This memory provider does not support forgetting individual facts.",
      });
    }
    const forget = semantic.forget.bind(semantic);
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    return call.finish(
      await runMemoryTool(
        "forget_memory",
        () =>
          forget(
            {
              id: String(args.id ?? ""),
              scope: ctx.memory.scope!,
              botId: bot.id,
              ...(typeof args.entity === "string" && args.entity.trim()
                ? { entity: args.entity.trim() }
                : {}),
              ...(reason ? { reason } : {}),
            },
            context,
          ),
        memoryToolOptions(semantic, context.signal, ctx.secrets, reason),
      ),
    );
  },
};
