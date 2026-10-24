import type { ProductEvent, RunTool } from "@cortexai-agent-hub/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import { appendEventInTransaction } from "./events.js";

const endedAt = new Date("2026-10-24T11:00:00.000Z");

const call = (callId: string, status: RunTool["status"]): RunTool => ({
  runId: "run-1",
  callId,
  tool: "shell",
  summary: `command: ${callId}`,
  status,
  startedAt: "2026-10-24T10:00:00.000Z",
  endedAt: status === "running" ? null : "2026-10-24T10:00:01.000Z",
});

interface Row {
  seq: number;
  type: string;
  runId: string | null;
  payload: unknown;
}

function fakeTx(runStatus: string, payloads: unknown[]) {
  const rows: Row[] = payloads.map((payload, index) => ({
    seq: index,
    type: "run.tool",
    runId: "run-1",
    payload,
  }));
  let nextEventSeq = rows.length;
  const tx = {
    thread: {
      update: vi.fn(async ({ data }: { data: { nextEventSeq: { increment: number } } }) => {
        nextEventSeq += data.nextEventSeq.increment;
        return { nextEventSeq };
      }),
    },
    run: {
      findUnique: vi.fn(async () => ({ status: runStatus, firstResponseAt: new Date() })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    event: {
      findMany: vi.fn(async ({ where }: { where: { runId: string; type: string } }) =>
        rows
          .filter((row) => row.runId === where.runId && row.type === where.type)
          .sort((left, right) => left.seq - right.seq),
      ),
      create: vi.fn(async ({ data }: { data: Row }) => {
        rows.push(data);
        return { ...data, id: `event-${data.seq}`, createdAt: new Date() };
      }),
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        rows.push(...data);
        return { count: data.length };
      }),
    },
  };
  const appended = () => rows.slice(payloads.length).sort((left, right) => left.seq - right.seq);
  return { tx: tx as unknown as Prisma.TransactionClient, fake: tx, appended };
}

const terminal = (type: ProductEvent["type"]) => ({
  spaceId: "space-1",
  threadId: "thread-1",
  botId: "bot-1",
  runId: "run-1",
  type,
  payload: {},
});

describe("run end closes open run tool calls", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(endedAt);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["run.completed", "completed"],
    ["run.failed", "failed"],
    ["run.cancelled", "cancelled"],
  ] as const)("%s interrupts every call still running, just before itself", async (type, runStatus) => {
    const { tx, appended } = fakeTx(runStatus, [
      call("a", "running"),
      call("b", "running"),
      { malformed: true },
      call("b", "done"),
      call("c", "running"),
      { ...call("c", "running"), summary: "command: c updated" },
    ]);

    await appendEventInTransaction(tx, terminal(type));

    expect(appended().map((row) => [row.seq, row.type, row.payload])).toEqual([
      [6, "run.tool", { ...call("a", "interrupted"), endedAt: endedAt.toISOString() }],
      [
        7,
        "run.tool",
        {
          ...call("c", "interrupted"),
          summary: "command: c updated",
          endedAt: endedAt.toISOString(),
        },
      ],
      [8, type, {}],
    ]);
  });

  it("writes only the terminal event when no call is open", async () => {
    const { tx, fake, appended } = fakeTx("completed", [call("a", "running"), call("a", "done")]);

    await appendEventInTransaction(tx, terminal("run.completed"));

    expect(appended().map((row) => row.type)).toEqual(["run.completed"]);
    expect(fake.thread.update).toHaveBeenCalledOnce();
    expect(fake.event.createMany).not.toHaveBeenCalled();
  });

  it("leaves open calls alone on other run events", async () => {
    const { tx, fake } = fakeTx("running", [call("a", "running")]);

    await appendEventInTransaction(tx, terminal("run.waiting_input"));

    expect(fake.event.findMany).not.toHaveBeenCalled();
  });
});
