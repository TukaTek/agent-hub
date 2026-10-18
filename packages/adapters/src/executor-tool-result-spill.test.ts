import type { AgentRunRequest, ComputerRef } from "@cortexai-agent-hub/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { BoxSandboxProvider } from "./box-sandbox.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { CreateOSSandboxProvider } from "./createos-sandbox.js";
import { DaytonaSandboxProvider } from "./daytona-sandbox.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { E2BSandboxProvider } from "./e2b-sandbox.js";
import { createRunExecutor } from "./executor.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { formatSpillReceipt, formatStructuredSpill, spillUserKey } from "./tool-result-spill.js";

const lifecycle = vi.hoisted(() => ({ computer: undefined as ComputerRef | undefined }));

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => lifecycle.computer,
}));

const ROOT = "/home/cortexai-agent-hub";
const RUN_SECRET = "sk-test-spill-secret-0123456789";

class SpillSandbox extends FakeSandboxProvider {
  readonly commands: string[][] = [];
  failWrites = false;

  constructor(private readonly root: string | undefined = ROOT) {
    super();
  }

  override describe() {
    const described = super.describe();
    return {
      ...described,
      capabilities: { ...described.capabilities, graphical: false, workspaceRoot: this.root },
    } as ReturnType<FakeSandboxProvider["describe"]>;
  }

  override async *execute(...args: Parameters<FakeSandboxProvider["execute"]>) {
    this.commands.push(args[1].argv);
    yield* super.execute(...args);
  }

  override async writeFile(...args: Parameters<FakeSandboxProvider["writeFile"]>) {
    if (this.failWrites) throw new Error("computer is asleep");
    return super.writeFile(...args);
  }
}

/** A deterministic one-hour meeting with a unique marker per utterance. */
function fathomTranscript(minChars: number): { text: string; lines: string[] } {
  const lines: string[] = [];
  let length = 0;
  for (let index = 0; length < minChars; index++) {
    const seconds = index * 3;
    const stamp = [seconds / 3600, (seconds % 3600) / 60, seconds % 60]
      .map((part) => String(Math.floor(part)).padStart(2, "0"))
      .join(":");
    const line = `[${stamp}] Speaker ${index % 4}: marker-${index} — café "pricing" review 🎙️ ok\n`;
    lines.push(line);
    length += line.length;
  }
  return { text: lines.join(""), lines };
}

type Scenario = (request: AgentRunRequest, sandbox: SpillSandbox) => Promise<void>;

async function runScenario(
  scenario: Scenario,
  options: {
    scope?: "dedicated" | "team";
    computerOwner?: string;
    runUser?: string;
    sandbox?: SpillSandbox;
    kind?: ComputerRef["kind"];
  } = {},
) {
  const sandbox = options.sandbox ?? new SpillSandbox();
  const computer = await sandbox.provision({ botId: "bot-1", homePath: "home" }, {
    operationId: "provision",
    traceId: "provision",
    spaceId: "space-1",
    userId: "user-a",
    signal: new AbortController().signal,
  } as never);
  lifecycle.computer = options.kind ? { ...computer, kind: options.kind } : computer;
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: options.runUser ?? "user-a",
    status: "queued",
    trigger: "user",
    leaseFence: 0,
  };
  let failure: unknown;
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    try {
      await scenario(request, sandbox);
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
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        computerId: "computer-1",
        computerSwitching: false,
        memoryScope: null,
        disabledBuiltinTools: [],
        computer: {
          id: "computer-1",
          scope: options.scope ?? "dedicated",
          userId: options.computerOwner ?? "user-a",
        },
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
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Quote the call" })) },
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
    externalEffect: { findMany: vi.fn(async () => []) },
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
    memoryProviders: { resolve: async () => null },
    events: {
      append: vi.fn(async () => undefined),
      finalizeRun: vi.fn(async () => ({ continuationRunId: null })),
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [RUN_SECRET],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  expect(runtimeRun).toHaveBeenCalled();
  if (failure) throw failure;
  return sandbox;
}

const spillOf = (request: AgentRunRequest) => {
  if (!request.spillToolResult) throw new Error("the executor did not offer a spill");
  return request.spillToolResult;
};
const tool = (request: AgentRunRequest, name: string, args: Record<string, unknown>) =>
  request.executeTool!(name, args, `exec-${name}-${JSON.stringify(args)}`) as Promise<
    Record<string, unknown>
  >;
const stored = (sandbox: SpillSandbox, path: string) => {
  const box = [...sandbox.boxes.values()][0]!;
  const file = box.files.get(path);
  return file ? new TextDecoder().decode(file.content) : undefined;
};
const keyA = spillUserKey("space-1", "user-a");
const keyB = spillUserKey("space-1", "user-b");

describe("oversized tool results spill to the bot computer", () => {
  it("saves a 200k result that read_file pages back byte for byte", async () => {
    const { text } = fathomTranscript(200_000);
    await runScenario(async (request, sandbox) => {
      const saved = await spillOf(request)({
        toolName: "FATHOM_GET_TRANSCRIPT",
        executionId: "exec-1",
        text,
      });
      const relative = `.cortexai/tool-results/${keyA}/run-1/01-fathom-get-transcript.txt`;
      expect(saved).toEqual({
        path: `${ROOT}/${relative}`,
        totalChars: text.length,
        savedChars: text.length,
      });
      expect(stored(sandbox, relative)).toBe(text);
      if (!("path" in saved)) throw new Error("not saved");
      let offset: unknown = 0;
      let joined = "";
      while (offset !== undefined) {
        const page = await tool(request, "read_file", { path: saved.path, offset, limit: 8_000 });
        expect(page.total_chars).toBe(text.length);
        joined += String(page.content);
        offset = page.next_offset;
      }
      expect(joined).toBe(text);
    });
  });

  it("quotes exactly from any position in a transcript over 100k characters", async () => {
    const { text, lines } = fathomTranscript(240_000);
    const starts: number[] = [];
    for (let index = 0, at = 0; index < lines.length; at += lines[index]!.length, index++) {
      starts.push(at);
    }
    await runScenario(async (request) => {
      const saved = await spillOf(request)({ toolName: "fathom", executionId: "e", text });
      if (!("path" in saved)) throw new Error("not saved");
      const receipt = formatSpillReceipt(saved, text, 12_000);
      const previewHead = receipt.slice(receipt.indexOf("\n") + 1).split("\n…\n")[0]!.length;
      const previewTail = receipt.length - receipt.lastIndexOf("\n…\n") - 3;
      const emoji = text.indexOf("🎙", 100_000);
      const samples = [
        0,
        previewHead,
        ...[0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9].map((fraction) =>
          Math.floor(text.length * fraction),
        ),
        text.length - previewTail - 1,
        text.length - 100,
        emoji + 1,
      ];
      for (const sample of samples) {
        const page = await tool(request, "read_file", { path: saved.path, offset: sample });
        const start = sample === emoji + 1 ? emoji : sample;
        const content = String(page.content);
        expect(page.offset, `offset ${sample}`).toBe(start);
        expect(content, `offset ${sample}`).toBe(text.slice(start, start + content.length));
        if (start + content.length < text.length) {
          expect(page.next_offset).toBe(start + content.length);
        }
        for (const [index, lineStart] of starts.entries()) {
          if (lineStart >= start && lineStart + lines[index]!.length <= start + content.length) {
            expect(content).toContain(`marker-${index} `);
          }
        }
      }
      for (const offset of [text.length, text.length + 1]) {
        const page = await tool(request, "read_file", { path: saved.path, offset });
        expect(page.content).toBe("");
        expect(page).not.toHaveProperty("next_offset");
      }
      // The middle of the meeting is outside the preview yet one read away.
      const middle = lines[Math.floor(lines.length / 2)]!;
      expect(receipt).not.toContain(middle);
      const path = /at (\S+)\. Search it/.exec(receipt)![1]!;
      const page = await tool(request, "read_file", {
        path,
        offset: text.indexOf(middle) - 50,
      });
      expect(String(page.content)).toContain(middle);
    });
  });

  it.each([
    ["docker", () => new DockerSandboxProvider("http://supervisor.invalid", "token")],
    ["createos", () => new CreateOSSandboxProvider({ apiKey: "key" })],
    ["e2b", () => new E2BSandboxProvider("key")],
    ["box", () => new BoxSandboxProvider({ apiKey: "key" }, {} as never)],
    ["daytona", () => new DaytonaSandboxProvider({ apiKey: "key" }, {} as never)],
    ["fake", () => new FakeSandboxProvider()],
    ["desktop", () => new DesktopSandboxProvider()],
  ] as const)("opens the exact receipt path with read_file on %s computers", async (kind, make) => {
    const { workspaceRoot } = make().describe().capabilities as { workspaceRoot?: string };
    const { text } = fathomTranscript(240_000);
    const middle = Math.floor(text.length / 2);
    await runScenario(
      async (request) => {
        const saved = await spillOf(request)({ toolName: "fathom", executionId: "e", text });
        if (!("path" in saved)) throw new Error("not saved");
        const structured = formatStructuredSpill(saved, { transcript: text }, 12_000)!;
        const paths = [
          /at (\S+)\. Search it/.exec(formatSpillReceipt(saved, text, 12_000))![1]!,
          JSON.parse(structured).fullResult.path as string,
        ];
        for (const path of paths) {
          expect(path).toBe(saved.path);
          for (const offset of [0, middle]) {
            const page = await tool(request, "read_file", { path, offset });
            expect(page, `${kind} ${path} @${offset}`).not.toHaveProperty("error");
            expect(page.total_chars).toBe(text.length);
            expect(text.startsWith(String(page.content), offset)).toBe(true);
          }
        }
      },
      {
        sandbox: new SpillSandbox(workspaceRoot),
        kind: kind === "desktop" ? "desktop" : undefined,
      },
    );
  });

  it("redacts run secrets before writing", async () => {
    await runScenario(async (request, sandbox) => {
      const text = `${"a".repeat(20_000)} token=${RUN_SECRET} ${"b".repeat(20_000)}`;
      await spillOf(request)({ toolName: "echo", executionId: "e", text });
      const file = stored(sandbox, `.cortexai/tool-results/${keyA}/run-1/01-echo.txt`);
      expect(file).toBeDefined();
      expect(file).not.toContain(RUN_SECRET);
      expect(file).toContain("[redacted]");
    });
  });

  it("refuses to spill onto another user's private computer", async () => {
    const sandbox = await runScenario(
      async (request) => {
        expect(
          await spillOf(request)({
            toolName: "fathom",
            executionId: "e",
            text: "x".repeat(50_000),
          }),
        ).toEqual({ unavailable: "shared-computer" });
      },
      { computerOwner: "user-a", runUser: "user-b" },
    );
    expect([...[...sandbox.boxes.values()][0]!.files.keys()]).toEqual([]);
  });

  it("spills on a multi-member Team Computer and hides it from other users' file tools", async () => {
    const teamPath = `bots/bot-1/.cortexai/tool-results/${keyA}/run-1/01-fathom.txt`;
    const sandbox = await runScenario(
      async (request, box) => {
        const saved = await spillOf(request)({
          toolName: "fathom",
          executionId: "e",
          text: "t".repeat(50_000),
        });
        expect(saved).toMatchObject({ path: `${ROOT}/${teamPath}` });
        expect(stored(box, teamPath)).toHaveLength(50_000);
      },
      { scope: "team", computerOwner: "user-a" },
    );
    await runScenario(
      async (request) => {
        const notFound = { error: "not found" };
        for (const path of [
          `${ROOT}/${teamPath}`,
          teamPath,
          `.cortexai/tool-results/${keyA}/run-1`,
        ]) {
          expect(await tool(request, "read_file", { path })).toMatchObject(notFound);
          expect(await tool(request, "read_file", { path, offset: 0 })).toMatchObject(notFound);
          expect(await tool(request, "list_files", { path })).toMatchObject(notFound);
          expect(await tool(request, "attach_file", { path })).toMatchObject(notFound);
          expect(await tool(request, "open_path", { path })).toMatchObject(notFound);
        }
        const listing = await tool(request, "list_files", { path: ".cortexai/tool-results" });
        expect(JSON.stringify(listing)).not.toContain(keyA);
        const own = await spillOf(request)({
          toolName: "x",
          executionId: "e",
          text: "y".repeat(20_000),
        });
        if (!("path" in own)) throw new Error("not saved");
        expect(own.path).toContain(keyB);
        expect(await tool(request, "read_file", { path: own.path, offset: 0 })).toMatchObject({
          total_chars: 20_000,
        });
      },
      { scope: "team", computerOwner: "user-a", runUser: "user-b", sandbox },
    );
  });

  it("prunes before each write with the fixed retention command", async () => {
    const sandbox = await runScenario(async (request) => {
      await spillOf(request)({ toolName: "one", executionId: "e1", text: "1".repeat(20_000) });
      await spillOf(request)({ toolName: "two", executionId: "e2", text: "2".repeat(20_000) });
    });
    const prunes = sandbox.commands.filter((argv) => argv.join(" ").includes("tool-results"));
    expect(prunes).toHaveLength(2);
    expect(prunes[0]!.at(-1)).toContain(`'.cortexai/tool-results/${keyA}'`);
    expect(prunes[0]!.at(-1)).toContain("-mtime +6");
  });

  it("does not prune when nothing spills", async () => {
    const sandbox = await runScenario(async (request) => {
      await tool(request, "list_files", { path: "" });
    });
    expect(sandbox.commands.filter((argv) => argv.join(" ").includes("tool-results"))).toEqual([]);
  });

  it("falls back when the computer cannot take the file", async () => {
    const sandbox = new SpillSandbox();
    sandbox.failWrites = true;
    await runScenario(
      async (request) => {
        expect(
          await spillOf(request)({
            toolName: "fathom",
            executionId: "e",
            text: "z".repeat(30_000),
          }),
        ).toEqual({ unavailable: "no-computer" });
      },
      { sandbox },
    );
  });
});
