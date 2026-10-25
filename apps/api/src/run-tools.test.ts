import type { Actor, RunTool } from "@cortexai-agent-hub/contracts";
import type { PrismaClient } from "@cortexai-agent-hub/db";
import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "fixture@example.test",
  isDeploymentOwner: false,
} satisfies Actor;

const entry = (
  runId: string,
  callId: string,
  status: RunTool["status"],
  startedAt = "2026-10-24T10:00:00.000Z",
): RunTool => ({
  runId,
  callId,
  tool: "web_search",
  summary: `query: ${callId}`,
  status,
  startedAt,
  endedAt: status === "running" ? null : "2026-10-24T10:00:01.000Z",
});

const LONG_RUN_CALLS = 150;

/** The Prisma `where` subset runs.tools uses: equality, `seq.lt`, JSON paths and `OR`. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") {
      return (value as Record<string, unknown>[]).some((option) => matches(row, option));
    }
    if (key === "payload") {
      const { path, equals } = value as { path: string[]; equals: unknown };
      return (row.payload as Record<string, unknown>)[path[0]!] === equals;
    }
    if (key === "seq") return (row.seq as number) < (value as { lt: number }).lt;
    return row[key] === value;
  });
}

/** Rows for a run whose calls each log running, then done, one after the other. */
function manyCalls(runId: string, count: number) {
  return Array.from({ length: count }, (_, index) =>
    (["running", "done"] as const).map((status, offset) => ({
      spaceId: "space-1",
      threadId: "thread-1",
      runId,
      type: "run.tool",
      seq: 10_000 + 2 * index + offset,
      payload: entry(runId, `many-${index}`, status),
    })),
  ).flat();
}

function fixture(extraRows: ReturnType<typeof manyCalls> = []) {
  const bot = {
    id: "bot-1",
    userId: actor.userId,
    spaceId: actor.spaceId,
    archivedAt: null,
    thread: { id: "thread-1" },
    computer: null,
  };
  const findBot = vi.fn(
    async ({ where }: { where: { id: string; userId: string; spaceId: string } }) =>
      where.id === bot.id && where.userId === bot.userId && where.spaceId === bot.spaceId
        ? bot
        : null,
  );
  const rows = [
    {
      spaceId: "space-1",
      threadId: "thread-1",
      runId: "run-1",
      type: "run.tool",
      seq: 1,
      payload: entry("run-1", "a", "running"),
    },
    {
      spaceId: "space-1",
      threadId: "thread-1",
      runId: "run-1",
      type: "run.tool",
      seq: 2,
      payload: entry("run-1", "b", "running"),
    },
    {
      spaceId: "space-1",
      threadId: "thread-1",
      runId: "run-1",
      type: "run.tool",
      seq: 3,
      payload: { malformed: true },
    },
    {
      spaceId: "space-1",
      threadId: "thread-1",
      runId: "run-1",
      type: "run.tool",
      seq: 4,
      payload: entry("run-1", "a", "done", "2026-10-24T10:05:00.000Z"),
    },
    {
      spaceId: "space-1",
      threadId: "thread-1",
      runId: "run-1",
      type: "agent.tool.called",
      seq: 5,
      payload: {},
    },
    // A peer conversation and a ticket run in the same thread.
    {
      spaceId: "space-1",
      threadId: "thread-1",
      runId: "run-peer",
      type: "run.tool",
      seq: 6,
      payload: entry("run-peer", "p", "done"),
    },
    {
      spaceId: "space-1",
      threadId: "thread-1",
      runId: "run-ticket",
      type: "run.tool",
      seq: 7,
      payload: entry("run-ticket", "t", "done"),
    },
    // Another user's run in another thread of the same space.
    {
      spaceId: "space-1",
      threadId: "thread-2",
      runId: "run-2",
      type: "run.tool",
      seq: 1,
      payload: entry("run-2", "x", "done"),
    },
    // A long run: call i starts at seq 100 + 2i and finishes right after, except call 49,
    // which finishes after every other call.
    ...Array.from({ length: LONG_RUN_CALLS }, (_, index) => [
      {
        spaceId: "space-1",
        threadId: "thread-1",
        runId: "run-long",
        type: "run.tool",
        seq: 100 + 2 * index,
        payload: entry("run-long", `call-${index}`, "running"),
      },
      {
        spaceId: "space-1",
        threadId: "thread-1",
        runId: "run-long",
        type: "run.tool",
        seq: index === 49 ? 1_000 : 101 + 2 * index,
        payload: entry("run-long", `call-${index}`, "done"),
      },
    ]).flat(),
    ...extraRows,
  ];
  const findEvents = vi.fn(
    async ({
      where,
      orderBy,
      take,
    }: {
      where: Record<string, unknown>;
      orderBy: { seq: "asc" | "desc" };
      take?: number;
    }) =>
      rows
        .filter((row) => matches(row, where))
        .sort((left, right) =>
          orderBy.seq === "asc" ? left.seq - right.seq : right.seq - left.seq,
        )
        .slice(0, take),
  );
  const triggers: Record<string, string> = {
    "run-long": "user",
    "run-many": "user",
    "run-1": "user",
    "run-2": "user",
    "run-peer": "bot_message",
    "run-ticket": "tickets",
  };
  const prisma = {
    bot: { findFirst: findBot },
    run: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        triggers[where.id] ? { trigger: triggers[where.id] } : null,
      ),
    },
    chatGroup: { findFirst: vi.fn(async () => null) },
    event: { findMany: findEvents },
  };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    env: { webOrigin: "http://127.0.0.1", sandboxProvider: "fake", agentRuntime: "scripted" },
  } as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  async function call(input: unknown, requestActor: Actor = actor) {
    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/runs/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor: requestActor } },
    );
    return { status: response.status, body: await response.json() };
  }
  return { call, findEvents };
}

describe("runs/tools", () => {
  it("replays one entry per call for a run in the caller's thread", async () => {
    const { call, findEvents } = fixture();
    const result = await call({ botId: "bot-1", runId: "run-1" });
    expect(result.status).toBe(200);
    expect(result.body.json).toEqual({
      tools: [entry("run-1", "a", "done"), entry("run-1", "b", "running")],
      olderCursor: null,
    });
    for (const [query] of findEvents.mock.calls) {
      expect(query.where).toMatchObject({
        spaceId: "space-1",
        threadId: "thread-1",
        runId: "run-1",
        type: "run.tool",
      });
    }
  });

  it("does not read a run that belongs to another thread", async () => {
    const { call } = fixture();
    const result = await call({ botId: "bot-1", runId: "run-2" });
    expect(result.status).toBe(200);
    expect(result.body.json).toEqual({ tools: [], olderCursor: null });
  });

  it("pages a long run from its newest calls back, with each call on one page", async () => {
    const { call } = fixture();
    const ids = (page: { tools: RunTool[] }) => page.tools.map((tool) => tool.callId);
    const range = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, index) => `call-${from + index}`);

    const newest = await call({ botId: "bot-1", runId: "run-long" });
    expect(newest.status).toBe(200);
    expect(ids(newest.body.json)).toEqual(range(50, LONG_RUN_CALLS));
    expect(newest.body.json.tools.every((tool: RunTool) => tool.status === "done")).toBe(true);
    // The cursor is the first event of the oldest call shown.
    expect(newest.body.json.olderCursor).toBe(100 + 2 * 50);

    const older = await call({
      botId: "bot-1",
      runId: "run-long",
      before: newest.body.json.olderCursor,
    });
    expect(ids(older.body.json)).toEqual(range(0, 50));
    // Finished after every newer call started, yet listed once, where it started, as done.
    expect(older.body.json.tools.at(-1)).toMatchObject({ callId: "call-49", status: "done" });
    expect(older.body.json.olderCursor).toBeNull();
  });

  it("pages back through every call of a run with thousands of calls", async () => {
    const count = 5_001;
    const { call } = fixture(manyCalls("run-many", count));
    const seen: string[] = [];
    let before: number | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await call({ botId: "bot-1", runId: "run-many", before });
      expect(result.status).toBe(200);
      const { tools, olderCursor } = result.body.json as {
        tools: RunTool[];
        olderCursor: number | null;
      };
      seen.unshift(...tools.map((tool) => tool.callId));
      if (olderCursor === null) break;
      before = olderCursor;
    }
    expect(seen).toHaveLength(count);
    expect(seen).toEqual(Array.from({ length: count }, (_, index) => `many-${index}`));
  });

  it("lists a call once when it logs running again after newer calls", async () => {
    const rows = manyCalls("run-many", 101);
    // A summary update for the oldest call, logged after every other call.
    rows.push({ ...rows[0]!, seq: 20_000, payload: { ...rows[0]!.payload, summary: "q: later" } });
    const { call } = fixture(rows);
    const newest = await call({ botId: "bot-1", runId: "run-many" });
    const older = await call({
      botId: "bot-1",
      runId: "run-many",
      before: newest.body.json.olderCursor,
    });
    const ids = [...older.body.json.tools, ...newest.body.json.tools].map(
      (tool: RunTool) => tool.callId,
    );
    expect(ids).toEqual(Array.from({ length: 101 }, (_, index) => `many-${index}`));
    expect(older.body.json.tools[0]).toMatchObject({ callId: "many-0", status: "done" });
  });

  // The live thread stream drops these runs' tool events; replay must not reveal them either.
  it.each([
    ["a peer conversation", "run-peer"],
    ["a background ticket run", "run-ticket"],
  ])("hides %s like the live stream does", async (_label, runId) => {
    const { call, findEvents } = fixture();
    const result = await call({ botId: "bot-1", runId });
    expect(result.status).toBe(200);
    expect(result.body.json).toEqual({ tools: [], olderCursor: null });
    expect(findEvents).not.toHaveBeenCalled();
  });

  // IsolationError is opaque at the RPC boundary; access is denied before any event read.
  it.each([
    ["another user", { ...actor, userId: "user-2" }, { botId: "bot-1", runId: "run-1" }],
    ["another space", { ...actor, spaceId: "space-2" }, { botId: "bot-1", runId: "run-1" }],
    ["another user's group", actor, { groupId: "group-2", runId: "run-1" }],
  ])("denies %s", async (_label, requestActor, input) => {
    const { call, findEvents } = fixture();
    const result = await call(input, requestActor);
    expect(result.status).toBe(500);
    expect(findEvents).not.toHaveBeenCalled();
  });
});
