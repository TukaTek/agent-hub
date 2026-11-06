import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { LocalKeyProvider, masterKeysFromEnv } from "./content-keys.js";
import { appendEvent } from "./events.js";
import { runAsSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

const master = { id: "test-fake-audit", key: randomBytes(32) };

describePostgres("tool completion audit idempotency (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `test-fake-audit-user-${suffix}`;
  const organizationId = `test-fake-audit-org-${suffix}`;
  const spaceId = `test-fake-audit-space-${suffix}`;
  const botId = `test-fake-audit-bot-${suffix}`;
  const clients: Array<ReturnType<typeof createDb>> = [];

  /** Each client has its own pool, like a separate worker process. */
  function client(poolMax = 4) {
    const db = createDb(databaseUrl!, {
      poolMax,
      keyProvider: new LocalKeyProvider([master, ...masterKeysFromEnv()]),
      encryptContent: true,
    });
    clients.push(db);
    return db;
  }

  const first = () => clients[0]!;

  async function runInNewThread() {
    // threads.botId is unique, so each fixture thread needs its own bot.
    const threadId = `test-fake-audit-thread-${randomUUID()}`;
    const threadBotId = `test-fake-audit-bot-${randomUUID()}`;
    const { prisma } = first();
    await prisma.bot.create({
      data: { id: threadBotId, spaceId, userId, name: "Ada", color: "ink" },
    });
    await prisma.thread.create({ data: { id: threadId, spaceId, userId, botId: threadBotId } });
    const task = await prisma.task.create({
      data: {
        spaceId,
        botId: threadBotId,
        threadId,
        userId,
        prompt: "test-fake-prompt",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        botId: threadBotId,
        threadId,
        taskId: task.id,
        userId,
        status: "running",
        trigger: "user",
        startedAt: new Date(),
      },
    });
    return { threadId, runId: run.id, botId: threadBotId };
  }

  function audit(
    target: { threadId: string; runId: string; botId: string },
    payload: { auditId: string; executionId: string; outcome?: string },
  ) {
    return {
      spaceId,
      threadId: target.threadId,
      botId: target.botId,
      runId: target.runId,
      type: "agent.tool.completed" as const,
      payload: { name: "shell", durationMs: 1, outcome: "succeeded", ...payload },
    };
  }

  async function threadRows(threadId: string) {
    const { pool } = first();
    const events = await pool.query<{
      id: string;
      seq: number;
      auditId: string | null;
      executionId: string | null;
    }>(
      `SELECT id, seq, payload->>'auditId' AS "auditId", payload->>'executionId' AS "executionId"
         FROM events WHERE "threadId" = $1 ORDER BY seq`,
      [threadId],
    );
    const thread = await pool.query<{ nextEventSeq: number }>(
      `SELECT "nextEventSeq" FROM threads WHERE id = $1`,
      [threadId],
    );
    return { events: events.rows, nextEventSeq: thread.rows[0]!.nextEventSeq };
  }

  beforeAll(() =>
    runAsSystem("test fixture", async () => {
      client();
      client();
      const { prisma } = first();
      await prisma.user.create({
        data: {
          id: userId,
          name: "test-fake-audit",
          email: `${userId}@cortexai-agent-hub.test`,
          emailVerified: false,
        },
      });
      await prisma.organization.create({
        data: {
          id: organizationId,
          name: "test-fake-audit",
          slug: organizationId,
          createdAt: new Date(),
        },
      });
      await prisma.space.create({ data: { id: spaceId, organizationId, name: "General" } });
      await prisma.bot.create({ data: { id: botId, spaceId, userId, name: "Ada", color: "ink" } });
    }),
  );

  afterAll(async () => {
    try {
      await runAsSystem("test fixture", async () => {
        await first()?.prisma.organization.deleteMany({ where: { id: organizationId } });
        await first()?.prisma.user.deleteMany({ where: { id: userId } });
      });
    } finally {
      for (const db of clients) {
        await db.prisma.$disconnect().catch(() => undefined);
        await db.pool.end().catch(() => undefined);
      }
    }
  });

  it("keeps the audit key readable on encrypted rows", () =>
    runAsSystem("test", async () => {
      const target = await runInNewThread();
      const auditId = randomUUID();
      await appendEvent(
        first().prisma,
        audit(target, { auditId, executionId: "test-fake-call-encrypted" }),
      );

      const { events } = await threadRows(target.threadId);
      expect(events).toEqual([expect.objectContaining({ auditId, executionId: null })]);
    }));

  it("writes exactly one row when two processes append the same audit concurrently", () =>
    runAsSystem("test", async () => {
      const target = await runInNewThread();
      const input = audit(target, { auditId: randomUUID(), executionId: "test-fake-call-race" });

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) => appendEvent(clients[index % 2]!.prisma, input)),
      );

      const { events, nextEventSeq } = await threadRows(target.threadId);
      expect(events).toHaveLength(1);
      expect(new Set(results.map((event) => event.id))).toEqual(new Set([events[0]!.id]));
      expect(results.every((event) => event.seq === events[0]!.seq)).toBe(true);
      // Losing inserts rolled back their sequence increment.
      expect(nextEventSeq).toBe(events[0]!.seq + 1);
    }));

  it("turns a retry of an already committed audit into a no-op without a sequence hole", () =>
    runAsSystem("test", async () => {
      const target = await runInNewThread();
      const input = audit(target, { auditId: randomUUID(), executionId: "test-fake-call-retry" });
      const committed = await appendEvent(first().prisma, input);
      const before = await threadRows(target.threadId);

      const retried = await appendEvent(clients[1]!.prisma, input);
      const next = await appendEvent(
        first().prisma,
        audit(target, { auditId: randomUUID(), executionId: "test-fake-call-next" }),
      );

      expect(retried.id).toBe(committed.id);
      const after = await threadRows(target.threadId);
      expect(before.nextEventSeq).toBe(committed.seq + 1);
      expect(after.events.map((event) => event.seq)).toEqual([committed.seq, committed.seq + 1]);
      expect(next.seq).toBe(committed.seq + 1);
    }));

  it("records a paused completion and its resumed completion for one executionId", () =>
    runAsSystem("test", async () => {
      const target = await runInNewThread();
      await appendEvent(
        first().prisma,
        audit(target, {
          auditId: randomUUID(),
          executionId: "test-fake-call-1",
          outcome: "paused",
        }),
      );
      await appendEvent(
        clients[1]!.prisma,
        audit(target, { auditId: randomUUID(), executionId: "test-fake-call-1" }),
      );

      const { events } = await threadRows(target.threadId);
      expect(events).toHaveLength(2);
    }));

  it("keeps distinct audits of one run in append order", () =>
    runAsSystem("test", async () => {
      const target = await runInNewThread();
      const auditIds = Array.from({ length: 6 }, () => randomUUID());
      for (const [index, auditId] of auditIds.entries())
        await appendEvent(
          clients[index % 2]!.prisma,
          audit(target, { auditId, executionId: `test-fake-call-${index}` }),
        );

      const { events } = await threadRows(target.threadId);
      expect(events.map((event) => event.auditId)).toEqual(auditIds);
      expect(events.map((event) => event.seq)).toEqual(
        events.map((_, index) => events[0]!.seq + index),
      );
    }));

  it("leaves audits without an auditId outside the index", () =>
    runAsSystem("test", async () => {
      const target = await runInNewThread();
      // The previous release writes no auditId during a deploy overlap.
      const legacy = audit(target, { auditId: "", executionId: "test-fake-call-legacy" });
      await appendEvent(first().prisma, legacy);
      await appendEvent(first().prisma, legacy);

      const { events } = await threadRows(target.threadId);
      expect(events).toHaveLength(2);
    }));
});
