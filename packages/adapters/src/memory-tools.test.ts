import type { ConnectorTool, SemanticMemoryResponse } from "@cortexai-agent-hub/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  type MemoryToolName,
  memoryToolAuditSummary,
  runMemoryTool,
  selectMemoryTools,
} from "./memory-tools.js";

function tool(name: string): ConnectorTool {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}

const allThree = [
  tool("remember"),
  tool("recall_memory"),
  tool("save_memory"),
  tool("forget_memory"),
  tool("shell"),
];

describe("selectMemoryTools", () => {
  it("keeps native remember and drops semantic memory tools when unconfigured", () => {
    const names = selectMemoryTools(allThree, false).map((t) => t.name);
    expect(names).toEqual(["remember", "shell"]);
  });

  it("keeps semantic memory tools and drops native remember when configured", () => {
    const names = selectMemoryTools(allThree, true).map((t) => t.name);
    expect(names).toEqual(["recall_memory", "save_memory", "forget_memory", "shell"]);
  });

  it("is a no-op for tool lists with no memory tools at all", () => {
    const shellOnly = [tool("shell")];
    expect(selectMemoryTools(shellOnly, false)).toEqual(shellOnly);
    expect(selectMemoryTools(shellOnly, true)).toEqual(shellOnly);
  });
});

const MEMORY_TEXT = "User's locker code is 4417";
const API_KEY = "sk-test-PLACEHOLDER-key";

const successes: Array<[MemoryToolName, "save" | "forget" | "recall", SemanticMemoryResponse<unknown>]> =
  [
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
        wrap({ ok: true, value: [{ memory: MEMORY_TEXT, score: 1 }, { memory: "x", score: 0 }] }),
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
