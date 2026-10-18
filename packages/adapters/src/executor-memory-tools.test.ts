import type {
  AgentRunRequest,
  ComputerRef,
  SemanticMemoryProvider,
  SemanticMemoryResponse,
} from "@cortexai-agent-hub/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@cortexai-agent-hub/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";

const lifecycle = vi.hoisted(() => ({ computer: undefined as ComputerRef | undefined }));

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => lifecycle.computer,
}));

const RUN_SECRET = "sk-test-memory-run-secret-0123";
const MEMORY_TEXT = "User's locker code is 4417";

type Outcome = "ok" | "rejected" | "throws";
type ToolCase = {
  name: "save_memory" | "recall_memory" | "forget_memory";
  args: Record<string, unknown>;
  success: SemanticMemoryResponse<unknown>;
  summary: Record<string, unknown>;
};

const cases: ToolCase[] = [
  {
    name: "save_memory",
    args: { content: MEMORY_TEXT },
    success: { ok: true, value: undefined },
    summary: { ok: true },
  },
  {
    name: "recall_memory",
    args: { query: "locker code" },
    success: { ok: true, value: [{ memory: MEMORY_TEXT, score: 0.9 }] },
    summary: { ok: true, count: 1 },
  },
  {
    name: "forget_memory",
    args: { id: "fact-1", reason: "User asked to forget it" },
    success: { ok: true, value: { id: "fact-1", expired: true, reason: null } },
    summary: { ok: true, id: "fact-1", expired: true },
  },
];

function fakeMemory(tool: ToolCase, state: { outcome: Outcome; armed: boolean }) {
  const respond = async (operation: string, success: SemanticMemoryResponse<unknown>) => {
    if (!state.armed || !tool.name.startsWith(operation)) return success;
    if (state.outcome === "rejected") {
      return { ok: false, error: `Fake memory ${operation} failed: 503 for "${MEMORY_TEXT}"` };
    }
    if (state.outcome === "throws") throw new Error(`Bearer ${RUN_SECRET} socket hang up`);
    return tool.success;
  };
  return {
    describe: () => ({
      id: "fake-memory",
      contractVersion: "1",
      adapterVersion: "0.0.0",
      capabilities: { recall: true, save: true, purgeHistory: false, sharedScope: true },
    }),
    recall: () => respond("recall", { ok: true, value: [] }),
    save: () => respond("save", { ok: true, value: undefined }),
    forget: () => respond("forget", tool.success),
  } as unknown as SemanticMemoryProvider;
}

async function runTool(tool: ToolCase, outcome: Outcome) {
  const sink = createTestSink();
  installLogger(createLogger({ service: "cortexai-agent-hub-worker", sinks: [sink] }));
  const state = { outcome, armed: false };
  const sandbox = new FakeSandboxProvider();
  lifecycle.computer = await sandbox.provision({ botId: "bot-1", homePath: "home" }, {
    operationId: "provision",
    traceId: "provision",
    spaceId: "space-1",
    userId: "user-a",
    signal: new AbortController().signal,
  } as never);
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-a",
    status: "queued",
    trigger: "user",
    leaseFence: 0,
  };
  const effects: Array<Record<string, unknown> & { id: string }> = [];
  const append = vi.fn(async (_event: Record<string, unknown>) => undefined);
  let toolResult: unknown;
  let failure: unknown;
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    try {
      state.armed = true;
      toolResult = await request.executeTool!(tool.name, tool.args, "exec-memory-1");
      state.armed = false;
      // The shape pi-runtime hands to onToolCompleted after executeTool returns.
      await request.onToolCompleted?.({
        name: tool.name,
        executionId: "exec-memory-1",
        durationMs: 3,
        result: {
          content: [{ type: "text", text: JSON.stringify(toolResult) }],
          details: toolResult,
        },
      });
    } catch (error) {
      failure = error;
    }
    yield { type: "done" as const, text: "Done" };
  });
  const prisma = {
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Chief",
        title: "Chief",
        description: "Test assistant",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        computerId: "computer-1",
        computerSwitching: false,
        memoryScope: null,
        disabledBuiltinTools: [],
        computer: { id: "computer-1", scope: "dedicated", userId: "user-a" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 2,
      })),
    },
    message: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Remember this" })) },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    secret: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    spaceBackupModel: { findMany: vi.fn(async () => []) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: "openai/gpt-4o",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    externalEffect: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(
        async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
          effects.find((effect) =>
            where.id ? effect.id === where.id : effect.idempotencyKey === where.idempotencyKey,
          ) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const effect = { ...data, id: `effect-${effects.length + 1}` };
        effects.push(effect);
        return { ...effect };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
        Object.assign(effects.find((effect) => effect.id === where.id)!, data);
      }),
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: string; status: string }; data: object }) => {
          const effect = effects.find((e) => e.id === where.id && e.status === where.status);
          if (!effect) return { count: 0 };
          Object.assign(effect, data);
          return { count: 1 };
        },
      ),
    },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => null) },
    teachingSession: { findFirst: vi.fn(async () => null) },
    artifact: { findMany: vi.fn(async () => []) },
  };
  const executor = createRunExecutor({
    prisma,
    deploymentModelKey: "fake-deployment-key",
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox,
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: {
      resolve: async () => ({ provider: fakeMemory(tool, state), defaultScope: "isolated" }),
    },
    events: { append, finalizeRun: vi.fn(async () => ({ continuationRunId: null })) },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [RUN_SECRET],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  expect(runtimeRun).toHaveBeenCalled();
  if (failure) throw failure;
  const audit = append.mock.calls
    .map(([event]) => event)
    .find((event) => event.type === "agent.tool.completed")?.payload as Record<string, unknown>;
  const warnings = sink.events.filter((event) => event.message === "memory tool failed");
  return { toolResult, audit, warnings, logged: JSON.stringify(sink.events) };
}

afterEach(() => {
  installLogger(createLogger({ service: "cortexai-agent-hub", level: "off", sinks: [] }));
});

describe.each(cases)("$name through the executor", (tool) => {
  const operation = tool.name.replace("_memory", "");

  it.each(["rejected", "throws"] as const)(
    "fails the call, tells the model, logs and audits when the provider %s",
    async (outcome) => {
      const { toolResult, audit, warnings, logged } = await runTool(tool, outcome);

      expect(toolResult).toEqual({
        ok: false,
        error: expect.stringMatching(new RegExp(`^${tool.name} failed: `)),
      });
      expect(audit).toMatchObject({
        name: tool.name,
        outcome: "error",
        error: expect.stringContaining(`${tool.name} failed: `),
      });
      expect(audit).not.toHaveProperty("result");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ level: "warn", provider: "fake-memory", operation });
      for (const leaked of [RUN_SECRET, ...(tool.name === "save_memory" ? [MEMORY_TEXT] : [])]) {
        expect(logged).not.toContain(leaked);
        expect(JSON.stringify(audit)).not.toContain(leaked);
      }
    },
  );

  it("returns success unchanged and audits a content-free summary", async () => {
    const { toolResult, audit, warnings } = await runTool(tool, "ok");

    expect(toolResult).toEqual(tool.success);
    expect(audit).toMatchObject({ name: tool.name, outcome: "succeeded", result: tool.summary });
    expect(JSON.stringify(audit)).not.toContain(MEMORY_TEXT);
    expect(warnings).toEqual([]);
  });
});
