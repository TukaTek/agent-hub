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

function fixture() {
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
    // Another user's run in another thread of the same space.
    {
      spaceId: "space-1",
      threadId: "thread-2",
      runId: "run-2",
      type: "run.tool",
      seq: 1,
      payload: entry("run-2", "x", "done"),
    },
  ];
  const findEvents = vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
    rows
      .filter((row) =>
        Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value),
      )
      .sort((left, right) => left.seq - right.seq),
  );
  const prisma = {
    bot: { findFirst: findBot },
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
    expect(result.body.json).toEqual([entry("run-1", "a", "done"), entry("run-1", "b", "running")]);
    expect(findEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "space-1", threadId: "thread-1", runId: "run-1", type: "run.tool" },
      }),
    );
  });

  it("does not read a run that belongs to another thread", async () => {
    const { call } = fixture();
    const result = await call({ botId: "bot-1", runId: "run-2" });
    expect(result.status).toBe(200);
    expect(result.body.json).toEqual([]);
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
