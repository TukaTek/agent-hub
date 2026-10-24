import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  ComputerRef,
  SemanticMemoryProvider,
} from "@cortexai-agent-hub/adapter-kit";
import { foldRunTools, type RunTool, RunToolSchema } from "@cortexai-agent-hub/contracts";
import { createLogger, installLogger } from "@cortexai-agent-hub/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";

const lifecycle = vi.hoisted(() => ({ computer: undefined as ComputerRef | undefined }));

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async () => null,
  provisionComputer: async () => lifecycle.computer,
}));

/** A registered run secret, and a token the model typed that the run never registered. */
const RUN_SECRET = "fake-run-token-0123456789abcdef";
const MODEL_TOKEN = "fake-model-token-9876543210";

type ToolCall = { name: string; executionId: string; args: Record<string, unknown> };

const calls: ToolCall[] = [
  {
    name: "save_memory",
    executionId: "call-save",
    args: { content: `Deploy key is ${RUN_SECRET}`, token: MODEL_TOKEN },
  },
  { name: "recall_memory", executionId: "call-recall", args: { query: "deploy key" } },
];

const memory = {
  describe: () => ({
    id: "fake-memory",
    contractVersion: "1",
    adapterVersion: "0.0.0",
    capabilities: { recall: true, save: true, purgeHistory: false, sharedScope: true },
  }),
  save: async () => ({ ok: true, value: undefined }),
  recall: async () => {
    throw new Error(`Bearer ${RUN_SECRET} socket hang up`);
  },
  forget: async () => ({ ok: true, value: { id: "fact-1", expired: true, reason: null } }),
} as unknown as SemanticMemoryProvider;

/** Pi runs each tool through executeTool and reports it back through onToolCompleted. */
async function* piLikeRun(
  request: AgentRunRequest,
  toolCalls: ToolCall[],
): AsyncGenerator<AgentRuntimeEvent> {
  for (const call of toolCalls) {
    yield { type: "tool", name: call.name, args: { ...call.args }, executionId: call.executionId };
    const result = await request.executeTool!(call.name, { ...call.args }, call.executionId);
    await request.onToolCompleted?.({
      name: call.name,
      executionId: call.executionId,
      durationMs: 3,
      result: { content: [{ type: "text", text: JSON.stringify(result) }], details: result },
    });
  }
  yield { type: "done", text: "Done" };
}

/** The scripted runtime only reports calls; the executor runs and audits them. */
async function* scriptedRun(toolCalls: ToolCall[]): AsyncGenerator<AgentRuntimeEvent> {
  for (const call of toolCalls) {
    yield { type: "tool", name: call.name, args: { ...call.args }, executionId: call.executionId };
  }
  yield { type: "done", text: "Done" };
}

async function runWith(scripted: boolean, toolCalls = calls) {
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
  const prisma = {
    user: { findUnique: vi.fn(async () => null) },
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
    runtime: {
      describe: () => ({ capabilities: { scripted } }),
      run: (request: AgentRunRequest) =>
        scripted ? scriptedRun(toolCalls) : piLikeRun(request, toolCalls),
    },
    sandbox,
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => ({ provider: memory, defaultScope: "isolated" }) },
    events: { append, finalizeRun: vi.fn(async () => ({ continuationRunId: null })) },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [RUN_SECRET],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  const events = append.mock.calls.map(([event]) => event);
  const runTools = events.filter((event) => event.type === "run.tool");
  return { events, runTools, entries: runTools.map((event) => event.payload as RunTool) };
}

afterEach(() => {
  installLogger(createLogger({ service: "cortexai-agent-hub", level: "off", sinks: [] }));
});

describe.each([
  ["Pi", false],
  ["scripted", true],
])("run tool log through the executor with the %s runtime", (_label, scripted) => {
  it("logs every call as running, then done or failed", async () => {
    const { runTools, entries } = await runWith(scripted);

    for (const event of runTools) {
      expect(event).toMatchObject({
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-1",
      });
      expect(RunToolSchema.parse(event.payload)).toEqual(event.payload);
    }
    expect(entries.map((entry) => `${entry.callId}:${entry.status}`)).toEqual([
      "call-save:running",
      "call-save:done",
      "call-recall:running",
      "call-recall:failed",
    ]);
    const folded = foldRunTools(entries);
    expect(folded).toEqual([
      expect.objectContaining({
        runId: "run-1",
        callId: "call-save",
        tool: "save_memory",
        status: "done",
        startedAt: expect.any(String),
        endedAt: expect.any(String),
      }),
      expect.objectContaining({
        callId: "call-recall",
        tool: "recall_memory",
        summary: "query: deploy key",
        status: "failed",
        error: expect.stringContaining("recall_memory failed"),
      }),
    ]);
  });

  it("never logs a secret from arguments or failures", async () => {
    const { entries } = await runWith(scripted);
    const logged = JSON.stringify(entries);

    expect(logged).not.toContain(RUN_SECRET);
    expect(logged).not.toContain(MODEL_TOKEN);
    expect(entries[0]!.summary).toBe("content: Deploy key is [redacted], token: [redacted]");
  });

  it("never logs a credential the run has not registered yet", async () => {
    const pat = "fake-unregistered-pat-0123456789";
    const { entries } = await runWith(scripted, [
      {
        name: "add_mcp_server",
        executionId: "call-mcp",
        args: { name: "github", command: "npx", env: { GITHUB_PAT: pat } },
      },
    ]);

    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).not.toContain(pat);
    expect(entries[0]!.summary).toBe(
      'name: github, command: npx, env: {"GITHUB_PAT":"[redacted]"}',
    );
  });
});
