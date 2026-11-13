import type {
  ConnectorTool,
  SemanticMemoryProvider,
  SemanticMemoryResponse,
} from "@cortexai-agent-hub/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { MemoryToolName } from "./memory-tools.js";
import {
  appendMemoryFact,
  editMemory,
  memoryToolAuditSummary,
  runMemoryTool,
  selectMemoryTools,
} from "./memory-tools.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { memoryTools } from "./run-tools-memory.js";

function tool(name: string): ConnectorTool {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}

const allThree = [
  tool("remember"),
  tool("recall_memory"),
  tool("save_memory"),
  tool("forget_memory"),
  tool("reflect_memory"),
  tool("shell"),
];

describe("selectMemoryTools", () => {
  it("keeps native remember and drops semantic memory tools when unconfigured", () => {
    const names = selectMemoryTools(allThree, false, false, false).map((t) => t.name);
    expect(names).toEqual(["remember", "shell"]);
  });

  it("keeps native remember beside semantic memory tools when configured", () => {
    const names = selectMemoryTools(allThree, true, true, true).map((t) => t.name);
    expect(names).toEqual([
      "remember",
      "recall_memory",
      "save_memory",
      "forget_memory",
      "reflect_memory",
      "shell",
    ]);
  });

  it("keeps native remember and drops forget_memory when the provider cannot forget", () => {
    const names = selectMemoryTools(allThree, true, false, true).map((t) => t.name);
    expect(names).toEqual(["remember", "recall_memory", "save_memory", "reflect_memory", "shell"]);
  });

  it("offers reflect_memory only when the provider can reflect", () => {
    const names = selectMemoryTools(allThree, true, true, false).map((t) => t.name);
    expect(names).toEqual(["remember", "recall_memory", "save_memory", "forget_memory", "shell"]);
    expect(selectMemoryTools(allThree, false, true, true).map((t) => t.name)).not.toContain(
      "reflect_memory",
    );
  });

  it("is a no-op for tool lists with no memory tools at all", () => {
    const shellOnly = [tool("shell")];
    expect(selectMemoryTools(shellOnly, false, false, false)).toEqual(shellOnly);
    expect(selectMemoryTools(shellOnly, true, true, true)).toEqual(shellOnly);
  });
});

describe("reflect_memory", () => {
  function reflectWith(reflect: SemanticMemoryProvider["reflect"]) {
    const context = { operationId: "op-1" };
    const ctx = {
      bot: { id: "bot-1" },
      context,
      runId: "run-1",
      state: { tainted: false },
      memory: { semantic: { reflect }, scope: "shared" },
    } as unknown as RunContext;
    const call = { name: "reflect_memory", args: { query: "What does the user prefer?" } };
    return { ctx, context, result: memoryTools.reflect_memory!(ctx, call as unknown as ToolCall) };
  }

  it("asks the provider with the bot and query and returns its answer", async () => {
    const reflect = vi.fn(async () => ({ ok: true as const, value: "They prefer dark mode." }));
    const { ctx, context, result } = reflectWith(reflect);
    await expect(result).resolves.toEqual({ ok: true, value: "They prefer dark mode." });

    expect(ctx.state.tainted).toBe(true);
    expect(reflect).toHaveBeenCalledWith(
      { query: "What does the user prefer?", botId: "bot-1" },
      context,
    );
  });

  it("says so when memory holds no answer", async () => {
    const { result } = reflectWith(async () => ({ ok: true, value: "  " }));
    await expect(result).resolves.toEqual({ ok: true, value: "No relevant memories." });
  });

  it("passes the provider's error through", async () => {
    const { result } = reflectWith(async () => ({ ok: false, error: "Memory is unreachable." }));
    await expect(result).resolves.toEqual({ ok: false, error: "Memory is unreachable." });
  });

  it("refuses when the provider cannot reflect", async () => {
    const { result } = reflectWith(undefined);
    await expect(result).resolves.toEqual({
      error: "This memory provider cannot answer questions from memory.",
    });
  });
});

describe("recall_memory", () => {
  async function recallWith(value: Array<{ memory: string; score: number; external?: true }>) {
    const ctx = {
      runId: "run-1",
      bot: { id: "bot-1" },
      thread: { historyCompactedUpToSeq: null, historyCompactionGeneration: 0 },
      context: { operationId: "op-1" },
      memory: {
        semantic: {
          describe: () => ({ id: "test-memory" }),
          recall: async () => ({ ok: true, value }),
        },
        scope: "isolated",
      },
      secrets: [],
      state: { tainted: false },
    } as unknown as RunContext;
    const call = { name: "recall_memory", args: { query: "pets" } };
    const result = await memoryTools.recall_memory!(ctx, call as unknown as ToolCall);
    return {
      result,
      tainted: ctx.state.tainted,
    };
  }

  it("taints the run when another app wrote a recalled memory", async () => {
    const value = [
      { memory: "Prefers dark mode.", score: 0.9 },
      { memory: "The dog is named Pixel.", score: 0.8, external: true as const },
    ];
    const { result, tainted } = await recallWith(value);
    expect(result).toEqual({ ok: true, value });
    expect(tainted).toBe(true);
  });

  it("does not promote the bot's own recalled knowledge to a clean source", async () => {
    const { tainted } = await recallWith([{ memory: "Prefers dark mode.", score: 0.9 }]);
    expect(tainted).toBe(true);
  });
});

const MEMORY_TEXT = "User's locker code is 4417";
const API_KEY = "sk-test-PLACEHOLDER-key";

const successes: Array<
  [MemoryToolName, "save" | "forget" | "recall", SemanticMemoryResponse<unknown>]
> = [
  ["save_memory", "save", { ok: true, value: undefined }],
  ["forget_memory", "forget", { ok: true, value: { id: "fact-1", expired: true, reason: null } }],
  ["recall_memory", "recall", { ok: true, value: [{ memory: MEMORY_TEXT, score: 0.9 }] }],
];

function run(
  name: MemoryToolName,
  call: () => Promise<SemanticMemoryResponse<unknown>>,
  signal = new AbortController().signal,
) {
  const logger = { warn: vi.fn() };
  const result = runMemoryTool(name, call, {
    provider: "supermemory",
    signal,
    redact: [API_KEY, MEMORY_TEXT],
    logger,
  });
  return { result, logger };
}

describe.each(successes)("runMemoryTool(%s)", (name, operation, success) => {
  it("fails the call and logs a warning when the provider returns ok:false", async () => {
    const { result, logger } = run(name, async () => ({
      ok: false,
      error: "Supermemory request failed: 503",
    }));

    await expect(result).resolves.toEqual({
      ok: false,
      error: `${name} failed: Supermemory request failed: 503`,
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("memory tool failed", {
      provider: "supermemory",
      operation,
      error: "Supermemory request failed: 503",
    });
  });

  it("fails the call and logs a warning when the provider throws", async () => {
    const { result, logger } = run(name, async () => {
      throw new Error("socket hang up");
    });

    await expect(result).resolves.toEqual({ ok: false, error: `${name} failed: socket hang up` });
    expect(logger.warn).toHaveBeenCalledWith("memory tool failed", {
      provider: "supermemory",
      operation,
      error: "socket hang up",
    });
  });

  it("returns success unchanged without logging", async () => {
    const { result, logger } = run(name, async () => success);

    await expect(result).resolves.toBe(success);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("keeps secrets and memory content out of the log and the error", async () => {
    const { result, logger } = run(name, async () => {
      throw new Error(`rejected "${MEMORY_TEXT}" with Bearer ${API_KEY} (key ${API_KEY})`);
    });

    const outcome = await result;
    const logged = JSON.stringify(logger.warn.mock.calls);
    for (const leaked of [MEMORY_TEXT, API_KEY]) {
      expect(logged).not.toContain(leaked);
      expect(JSON.stringify(outcome)).not.toContain(leaked);
    }
    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining("[redacted]") });
  });

  it("rethrows a caller abort instead of reporting a provider failure", async () => {
    const controller = new AbortController();
    const { result, logger } = run(
      name,
      async () => {
        controller.abort(new Error("run cancelled"));
        return { ok: false, error: "Supermemory is unreachable: aborted" };
      },
      controller.signal,
    );

    await expect(result).rejects.toThrow("run cancelled");
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("memoryToolAuditSummary", () => {
  const wrap = (details: unknown) => ({ content: [{ type: "text", text: "{}" }], details });

  it("summarizes successful memory results without memory content", () => {
    expect(memoryToolAuditSummary("save_memory", wrap({ ok: true }))).toEqual({ ok: true });
    expect(
      memoryToolAuditSummary(
        "recall_memory",
        wrap({
          ok: true,
          value: [
            { memory: MEMORY_TEXT, score: 1 },
            { memory: "x", score: 0 },
          ],
        }),
      ),
    ).toEqual({ ok: true, count: 2 });
    expect(
      memoryToolAuditSummary(
        "forget_memory",
        wrap({ ok: true, value: { id: "fact-1", expired: true, reason: MEMORY_TEXT } }),
      ),
    ).toEqual({ ok: true, id: "fact-1", expired: true });
  });

  it("returns nothing for failures or other tools and reads unwrapped results", () => {
    expect(memoryToolAuditSummary("save_memory", wrap({ ok: false, error: "no" }))).toBeUndefined();
    expect(memoryToolAuditSummary("recall_memory", { ok: true, value: [] })).toEqual({
      ok: true,
      count: 0,
    });
    expect(memoryToolAuditSummary("shell", wrap({ ok: true }))).toBeUndefined();
    expect(memoryToolAuditSummary("save_memory", undefined)).toBeUndefined();
  });
});

describe("appendMemoryFact", () => {
  it("keeps existing memory and adds the fact on its own line", () => {
    expect(appendMemoryFact("Save trip files to Drive.\n", "The client is Combient.")).toBe(
      "Save trip files to Drive.\nThe client is Combient.\n",
    );
  });

  it.each(["Berlin\r\nother\n", "  Berlin  \nother\n", "before\n\tBerlin\t\nafter\n"])(
    "preserves whitespace-tolerant single-line duplicates in %j",
    (existing) => {
      expect(appendMemoryFact(existing, "Berlin")).toBe(existing);
    },
  );

  it.each(["Intro.\n\n", "line  \n", "line  ", "line\r\n", "   "])(
    "preserves existing Markdown whitespace in %j when appending",
    (existing) => {
      const separator = existing.endsWith("\n") ? "" : "\n";
      expect(appendMemoryFact(existing, "new fact")).toBe(`${existing}${separator}new fact\n`);
    },
  );

  it("starts an empty document with the fact", () => {
    expect(appendMemoryFact("", "  durable fact  ")).toBe("durable fact\n");
  });

  it("leaves memory unchanged for a fact it already holds or an empty fact", () => {
    expect(appendMemoryFact("a\ndurable fact\n", "durable fact")).toBe("a\ndurable fact\n");
    expect(appendMemoryFact("a\n", "   ")).toBe("a\n");
  });
});

describe("multiline memory facts", () => {
  it("recognizes a complete block at the beginning, middle, or end", () => {
    for (const existing of [
      "Office:\nBerlin\n",
      "before\nOffice:\nBerlin\nafter\n",
      "before\nOffice:\nBerlin",
    ]) {
      expect(appendMemoryFact(existing, "Office:\nBerlin")).toBe(existing);
    }
  });

  it.each([
    ["Office:\r\nBerlin\r\n", "Office:\nBerlin"],
    ["Office:\nBerlin\n", "Office:\r\nBerlin"],
    ["before\r\nOffice:\r\nBerlin\r\nafter\r\n", "Office:\nBerlin"],
  ])("matches multiline blocks across newline formats", (existing, fact) => {
    expect(appendMemoryFact(existing, fact)).toBe(existing);
  });

  it("does not match partial lines or nonconsecutive lines", () => {
    for (const existing of [
      "Main Office:\nBerlin\n",
      "Office:\nBerlin Mitte\n",
      "Office:\nother\nBerlin\n",
    ]) {
      expect(appendMemoryFact(existing, "Office:\nBerlin")).toBe(`${existing}Office:\nBerlin\n`);
    }
  });
});

describe("editMemory", () => {
  const memory = "# Memory\n- Lives in London.\n- Prefers short replies.\n";

  it("appends a fact when no old_text is given", () => {
    expect(editMemory(memory, "Works at Combient.")).toEqual({
      content: `${memory}Works at Combient.\n`,
    });
  });

  it("replaces the whole entry that holds old_text", () => {
    expect(editMemory(memory, "- Lives in Berlin.", "London")).toEqual({
      content: "# Memory\n- Lives in Berlin.\n- Prefers short replies.\n",
    });
  });

  it("removes the entry when the replacement is empty", () => {
    expect(editMemory(memory, "", "short replies")).toEqual({
      content: "# Memory\n- Lives in London.\n",
    });
    expect(editMemory("a\nlast", "", "last")).toEqual({ content: "a\n" });
  });

  it("changes nothing when old_text is missing or ambiguous", () => {
    expect(editMemory(memory, "x", "Paris")).toEqual({
      error: expect.stringContaining("No entry"),
      entries: ["# Memory", "- Lives in London.", "- Prefers short replies."],
    });
    expect(editMemory(memory, "x", "- ")).toEqual({
      error: expect.stringContaining("more than one"),
      entries: ["- Lives in London.", "- Prefers short replies."],
    });
  });

  it("treats repeats within one line as one entry", () => {
    expect(editMemory("aaaa\nb\n", "c", "a")).toEqual({ content: "c\nb\n" });
  });

  it("refuses a save that grows memory past the cap and returns the entries", () => {
    const full = `${"a".repeat(30)}\n`;
    expect(editMemory(full, "b".repeat(10), "", 32)).toEqual({
      error: expect.stringContaining("Memory is full"),
      entries: ["a".repeat(30)],
    });
  });

  it("lets a save that shrinks oversized memory through", () => {
    const oversized = `${"a".repeat(40)}\n${"b".repeat(40)}\n`;
    expect(editMemory(oversized, "", "bbb", 32)).toEqual({ content: `${"a".repeat(40)}\n` });
  });
});
