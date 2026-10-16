import type { AgentRunRequest, AgentRuntimeEvent } from "@cortexai-agent-hub/adapter-kit";
import {
  createLogger,
  createTestSink,
  installLogger,
  type LogEvent,
} from "@cortexai-agent-hub/logging";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerState = vi.hoisted(() => ({
  models: new Map<string, Record<string, unknown>>(),
  stream: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) => providerState.models.get(`${provider}/${id}`),
    streamSimple: (...args: unknown[]) => providerState.stream(...args),
  }),
}));
vi.mock("./pi-current-models.js", () => ({ supplementPiModels: (models: unknown) => models }));
vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { CODEX_STREAM_IDLE_TIMEOUT_MESSAGE, PiAgentRuntime } from "./pi-runtime.js";
import {
  MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS,
  MODEL_STREAM_IDLE_TIMEOUT_MS,
} from "./pi-runtime-limits.js";

type FakeModel = Model<"openai-codex-responses"> | Model<"openai-completions">;
type StreamOptions = {
  signal: AbortSignal;
  onResponse?: (response: { status: number; headers: Record<string, string> }, model: FakeModel) => void;
};
type FakeContext = { messages?: Array<{ role: string; content?: unknown }> };
type Attempt = (target: FakeModel, context: FakeContext, options: StreamOptions) =>
  AssistantMessageEventStream;

const codex: Model<"openai-codex-responses"> = {
  provider: "openai-codex",
  id: "codex-fixture",
  name: "codex-fixture",
  api: "openai-codex-responses",
  baseUrl: "https://models.invalid/codex",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 4_096,
};
const backup: Model<"openai-completions"> = {
  provider: "provider-b",
  id: "backup-fixture",
  name: "backup-fixture",
  api: "openai-completions",
  baseUrl: "https://models.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 4_096,
};

function message(
  target: FakeModel,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: target.api,
    provider: target.provider,
    model: target.id,
    usage: {
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: 0,
  };
}

/** A 2xx that pi has started (`start` lands on headers), then optional output, then silence. */
function stalls(
  output: (target: FakeModel) => {
    events: AssistantMessageEvent[];
    content: AssistantMessage["content"];
  } = () => ({ events: [], content: [] }),
): Attempt {
  return (target, _context, options) => {
    const result = new AssistantMessageEventStream();
    options.onResponse?.({ status: 200, headers: {} }, target);
    result.push({ type: "start", partial: message(target, [], "stop") });
    const { events, content } = output(target);
    for (const event of events) result.push(event);
    options.signal.addEventListener("abort", () => {
      const failure = message(target, content, "aborted", "Request was aborted");
      result.push({ type: "error", reason: "aborted", error: failure });
      result.end(failure);
    });
    return result;
  };
}

function answers(text: string): Attempt {
  return (target) => {
    const response = message(target, [{ type: "text", text }], "stop");
    const result = new AssistantMessageEventStream();
    result.push({ type: "start", partial: { ...response, content: [] } });
    result.push({ type: "text_start", contentIndex: 0, partial: response });
    result.push({ type: "text_delta", contentIndex: 0, delta: text, partial: response });
    result.push({ type: "text_end", contentIndex: 0, content: text, partial: response });
    result.push({ type: "done", reason: "stop", message: response });
    result.end(response);
    return result;
  };
}

function callsSubagent(): Attempt {
  return (target) => {
    const call = {
      type: "toolCall" as const,
      id: "helper-call",
      name: "run_subagent",
      arguments: { name: "Scope reviewer", task: "Review the scope." },
    };
    const response = message(target, [call], "toolUse");
    const result = new AssistantMessageEventStream();
    result.push({ type: "start", partial: { ...response, content: [] } });
    result.push({ type: "toolcall_start", contentIndex: 0, partial: { ...response, content: [] } });
    result.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: response });
    result.push({ type: "done", reason: "toolUse", message: response });
    result.end(response);
    return result;
  };
}

function failsWith(errorMessage: string): Attempt {
  return (target) => {
    const failure = message(target, [], "error", errorMessage);
    const result = new AssistantMessageEventStream();
    result.push({ type: "start", partial: { ...failure, content: [] } });
    result.push({ type: "error", reason: "error", error: failure });
    result.end(failure);
    return result;
  };
}

/** Each provider call takes the next scripted attempt for the main agent or a subagent. */
function script(main: Attempt[], subagent: Attempt[] = []) {
  providerState.stream.mockImplementation(
    (target: FakeModel, context: FakeContext, options: StreamOptions) => {
      const system = context.messages?.[0];
      const isSubagent =
        system?.role === "system" &&
        typeof system.content === "string" &&
        system.content.includes("subagent named");
      const queue = isSubagent ? subagent : main;
      const next = queue.shift();
      if (!next) throw new Error(`unscripted call to ${target.provider}`);
      return next(target, context, options);
    },
  );
}

function request(fallbacks: AgentRunRequest["model"][] = []): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "run-stall",
    prompt: "Answer",
    instructions: "Be brief.",
    history: [],
    tools: [],
    model: { provider: codex.provider, id: codex.id, apiKey: "fake-codex-key" },
    fallbackModels: fallbacks,
    executeTool: vi.fn(async () => ({ ok: true })),
  } as unknown as AgentRunRequest;
}

const backupChoice = { provider: backup.provider, id: backup.id, apiKey: "fake-backup-key" };

function run(input: AgentRunRequest, signal = new AbortController().signal) {
  const events: AgentRuntimeEvent[] = [];
  const done = (async () => {
    for await (const event of new PiAgentRuntime().run(input, {
      operationId: "operation",
      traceId: "trace",
      spaceId: "space",
      userId: "user",
      signal,
    })) {
      events.push(event);
    }
    return events;
  })();
  done.catch(() => undefined);
  return { events, done };
}

function calledProviders() {
  return providerState.stream.mock.calls.map((call) => (call[0] as FakeModel).provider);
}

let sink: ReturnType<typeof createTestSink>;
const modelCalls = () =>
  sink.events.filter((event: LogEvent) => event.message === "model call");

beforeEach(() => {
  vi.useFakeTimers();
  providerState.models.clear();
  for (const target of [codex, backup]) {
    providerState.models.set(`${target.provider}/${target.id}`, target as never);
  }
  providerState.stream.mockReset();
  sink = createTestSink();
  installLogger(createLogger({ service: "cortexai-agent-hub-worker", sinks: [sink] }));
});

afterEach(() => {
  vi.useRealTimers();
  installLogger(createLogger({ service: "cortexai-agent-hub-worker", level: "off", sinks: [] }));
});

describe("model stream stall retry", () => {
  it("retries a stalled 2xx stream and succeeds", async () => {
    script([stalls(), answers("recovered")]);
    const { done } = run(request());
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS + 1);
    const events = await done;

    expect(events).toContainEqual({ type: "text", text: "recovered" });
    expect(calledProviders()).toEqual([codex.provider, codex.provider]);
    expect(events.some((event) => event.type === "progress")).toBe(false);
  });

  it("fails with today's error after three stalls and never makes a fourth call", async () => {
    script([stalls(), stalls(), stalls()]);
    const { done } = run(request());
    for (let attempt = 0; attempt < 3; attempt++) {
      await vi.advanceTimersByTimeAsync(MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS + 1);
    }

    await expect(done).rejects.toThrow(CODEX_STREAM_IDLE_TIMEOUT_MESSAGE);
    expect(providerState.stream).toHaveBeenCalledTimes(3);
  });

  it.each([
    [
      "text",
      (target: FakeModel) => {
        const partial = message(target, [{ type: "text", text: "half an answer" }], "stop");
        return {
          content: partial.content,
          events: [
            { type: "text_start", contentIndex: 0, partial },
            { type: "text_delta", contentIndex: 0, delta: "half an answer", partial },
          ] as AssistantMessageEvent[],
        };
      },
    ],
    [
      "thinking",
      (target: FakeModel) => {
        const partial = message(target, [{ type: "thinking", thinking: "considering" }], "stop");
        return {
          content: partial.content,
          events: [
            { type: "thinking_start", contentIndex: 0, partial },
            { type: "thinking_delta", contentIndex: 0, delta: "considering", partial },
          ] as AssistantMessageEvent[],
        };
      },
    ],
    [
      "tool-call",
      (target: FakeModel) => {
        const partial = message(
          target,
          [{ type: "toolCall", id: "call", name: "write_effect", arguments: {} }],
          "stop",
        );
        return {
          content: partial.content,
          events: [{ type: "toolcall_start", contentIndex: 0, partial }] as AssistantMessageEvent[],
        };
      },
    ],
  ])("does not retry a stream that idles after %s output", async (_kind, output) => {
    script([stalls(output)]);
    const { done } = run(request([backupChoice]));
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS + 1);

    await expect(done).rejects.toThrow(CODEX_STREAM_IDLE_TIMEOUT_MESSAGE);
    expect(providerState.stream).toHaveBeenCalledTimes(1);
  });

  it("uses the backup for the final retry and stays on it for the rest of the run", async () => {
    const input = request([backupChoice]);
    input.tools = [
      {
        name: "run_subagent",
        description: "Run a helper agent.",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
      },
    ] as AgentRunRequest["tools"];
    const onModelChange = vi.fn(async () => undefined);
    input.onModelChange = onModelChange;
    script([stalls(), stalls(), callsSubagent(), answers("after the helper")], [answers("helped")]);
    const { events, done } = run(input);
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS + 1);
    expect(onModelChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS + 1);
    await done;

    expect(calledProviders()).toEqual([
      codex.provider,
      codex.provider,
      backup.provider,
      backup.provider,
      backup.provider,
    ]);
    expect(onModelChange).toHaveBeenCalledOnce();
    expect(onModelChange).toHaveBeenCalledWith(backup.provider, backup.id);
    expect(events).toContainEqual({
      type: "progress",
      text: `Provider unavailable. Switched to backup model ${backup.id}.`,
    });
    expect(events).toContainEqual({ type: "text", text: "after the helper" });
  });

  it("retries a stall on the same model instead of switching, and still switches on a 503", async () => {
    script([stalls(), failsWith("503 service unavailable"), answers("from backup")]);
    const { done } = run(request([backupChoice]));
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS + 1);
    const events = await done;

    expect(calledProviders()).toEqual([codex.provider, codex.provider, backup.provider]);
    expect(events).toContainEqual({ type: "text", text: "from backup" });
    expect(modelCalls().map((event) => event.outcome)).toEqual([
      "idle-timeout-retried",
      "switched",
      "ok",
    ]);
  });

  it("never retries after the caller stops the run", async () => {
    script([stalls()]);
    const stop = new AbortController();
    const { done } = run(request([backupChoice]), stop.signal);
    await vi.advanceTimersByTimeAsync(1_000);
    stop.abort();
    await done.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS * 3);

    expect(providerState.stream).toHaveBeenCalledTimes(1);
    expect(modelCalls().map((event) => event.outcome)).not.toContain("idle-timeout-retried");
  });

  it("logs every attempt with its timing and outcome", async () => {
    script([stalls(), stalls(), answers("from backup")]);
    const { done } = run(request([backupChoice]));
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS + 1);
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS + 1);
    await done;

    const calls = modelCalls();
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call).toEqual(
        expect.objectContaining({
          runId: "run-stall",
          agentId: "main",
          requestSizeEstimate: expect.any(Number),
          durationMs: expect.any(Number),
        }),
      );
      expect(call.requestSizeEstimate).toBeGreaterThan(0);
    }
    expect(calls[0]).toEqual(
      expect.objectContaining({
        level: "warn",
        provider: codex.provider,
        model: codex.id,
        attempt: 1,
        fallback: false,
        timeToFirstEventMs: null,
        lastEventType: "error",
        outcome: "idle-timeout-retried",
        stall: "first-event",
      }),
    );
    expect(calls[0]?.durationMs).toBeGreaterThanOrEqual(MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS);
    expect(calls[1]).toEqual(expect.objectContaining({ attempt: 2, outcome: "idle-timeout-retried" }));
    expect(calls[2]).toEqual(
      expect.objectContaining({
        level: "info",
        provider: backup.provider,
        model: backup.id,
        attempt: 3,
        fallback: true,
        timeToFirstEventMs: expect.any(Number),
        lastEventType: "done",
        outcome: "ok",
      }),
    );
  });

  it("logs the failed attempt with today's error after three stalls", async () => {
    script([stalls(), stalls(), stalls()]);
    const { done } = run(request());
    for (let attempt = 0; attempt < 3; attempt++) {
      await vi.advanceTimersByTimeAsync(MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS + 1);
    }
    await done.catch(() => undefined);

    expect(modelCalls().map((event) => event.outcome)).toEqual([
      "idle-timeout-retried",
      "idle-timeout-retried",
      "failed",
    ]);
    expect(modelCalls()[2]).toEqual(
      expect.objectContaining({
        stall: "first-event",
        errorMessage: CODEX_STREAM_IDLE_TIMEOUT_MESSAGE,
      }),
    );
  });
});

describe("subagent model fallback", () => {
  function withSubagentTool(input: AgentRunRequest) {
    input.tools = [
      {
        name: "run_subagent",
        description: "Run a helper agent.",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
      },
    ] as AgentRunRequest["tools"];
    return input;
  }

  it("switches a subagent to the backup after a Codex idle timeout before output", async () => {
    const input = withSubagentTool(request([backupChoice]));
    const onModelChange = vi.fn(async () => undefined);
    input.onModelChange = onModelChange;
    script(
      [callsSubagent(), answers("parent done")],
      [stalls(), stalls(), answers("helper used the backup")],
    );
    const { events, done } = run(input);
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS + 1);
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS + 1);
    await done;

    expect(calledProviders()).toEqual([
      codex.provider,
      codex.provider,
      codex.provider,
      backup.provider,
      codex.provider,
    ]);
    expect(onModelChange).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "subagent",
        status: "running",
        progress: `Provider unavailable. Switched to backup model ${backup.id}.`,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "subagent",
        status: "completed",
        result: "helper used the backup",
      }),
    );
    const helperCalls = modelCalls().filter((event) => event.agentId !== "main");
    expect(helperCalls.map((event) => event.outcome)).toEqual([
      "idle-timeout-retried",
      "idle-timeout-retried",
      "ok",
    ]);
  });

  it("retries a stalled subagent on its own model when the space has no backup", async () => {
    script([callsSubagent(), answers("parent done")], [stalls(), answers("helper recovered")]);
    const { events, done } = run(withSubagentTool(request()));
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS + 1);
    await done;

    expect(calledProviders()).toEqual([
      codex.provider,
      codex.provider,
      codex.provider,
      codex.provider,
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "subagent",
        status: "completed",
        result: "helper recovered",
      }),
    );
  });
});
