import { randomBytes, randomUUID } from "node:crypto";
import type { AppendEventInput } from "@cortexai-agent-hub/db";
import {
  appendEvent,
  createDb,
  createThreadEvents,
  LocalKeyProvider,
  masterKeysFromEnv,
  runAsSystem,
} from "@cortexai-agent-hub/db";
import { createLogger, createTestSink, installLogger } from "@cortexai-agent-hub/logging";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appendToolCompletionAudit } from "./tool-completion-audit.js";
import {
  createToolCompletionAuditQueue,
  TOOL_COMPLETION_AUDIT_PROCESS_CONCURRENCY,
} from "./tool-completion-audit-queue.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

const master = { id: "test-fake-audit-load", key: randomBytes(32) };

describePostgres("tool completion audits under pool pressure (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `test-fake-audit-load-user-${suffix}`;
  const organizationId = `test-fake-audit-load-org-${suffix}`;
  const spaceId = `test-fake-audit-load-space-${suffix}`;
  const botId = `test-fake-audit-load-bot-${suffix}`;
  const clients: Array<ReturnType<typeof createDb>> = [];
  let sink: ReturnType<typeof createTestSink>;
  const warnings = () =>
    sink.events.filter((event) => event.message === "agent tool completion audit append failed");

  function client(poolMax: number) {
    const db = createDb(databaseUrl!, {
      poolMax,
      keyProvider: new LocalKeyProvider([master, ...masterKeysFromEnv()]),
      encryptContent: true,
    });
    clients.push(db);
    return db;
  }

  async function runInNewThread() {
    // threads.botId is unique, so each fixture thread needs its own bot.
    const { prisma } = clients[0]!;
    const threadId = `test-fake-audit-load-thread-${randomUUID()}`;
    const threadBotId = `test-fake-audit-load-bot-${randomUUID()}`;
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
    return { spaceId, threadId, botId: threadBotId, runId: run.id };
  }

  async function auditRows(runId: string) {
    const { rows } = await clients[0]!.pool.query<{ seq: number; auditId: string | null }>(
      `SELECT seq, payload->>'auditId' AS "auditId" FROM events
        WHERE "runId" = $1 AND type = 'agent.tool.completed' ORDER BY seq`,
      [runId],
    );
    return rows;
  }

  beforeAll(() =>
    runAsSystem("test fixture", async () => {
      const { prisma } = client(2);
      await prisma.user.create({
        data: {
          id: userId,
          name: "test-fake-audit-load",
          email: `${userId}@cortexai-agent-hub.test`,
          emailVerified: false,
        },
      });
      await prisma.organization.create({
        data: {
          id: organizationId,
          name: "test-fake-audit-load",
          slug: organizationId,
          createdAt: new Date(),
        },
      });
      await prisma.space.create({ data: { id: spaceId, organizationId, name: "General" } });
      await prisma.bot.create({ data: { id: botId, spaceId, userId, name: "Ada", color: "ink" } });
    }),
  );

  beforeEach(() => {
    sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
  });

  afterAll(async () => {
    installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
    try {
      await runAsSystem("test fixture", async () => {
        await clients[0]?.prisma.organization.deleteMany({ where: { id: organizationId } });
        await clients[0]?.prisma.user.deleteMany({ where: { id: userId } });
      });
    } finally {
      for (const db of clients) {
        await db.prisma.$disconnect().catch(() => undefined);
        await db.pool.end().catch(() => undefined);
      }
    }
  });

  it("keeps a tool burst within the process cap while a required write still commits", () =>
    runAsSystem("test", async () => {
      const { prisma } = client(4);
      const events = createThreadEvents(prisma);
      const queue = createToolCompletionAuditQueue();
      let inFlight = 0;
      let maxInFlight = 0;
      const append = async (input: AppendEventInput) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await events.append(input);
        } finally {
          inFlight -= 1;
        }
      };
      const targets = await Promise.all(Array.from({ length: 6 }, () => runInNewThread()));

      const burst = Promise.all(
        Array.from({ length: 30 }, (_, index) =>
          appendToolCompletionAudit(
            { events: { append }, auditQueue: queue },
            targets[index % targets.length]!,
            { name: "shell", executionId: `test-fake-call-${index}`, durationMs: 1 },
          ),
        ),
      );
      // A run.started-style required write shares the same pool during the burst.
      const required = await appendEvent(prisma, {
        ...targets[0]!,
        type: "run.started",
        payload: {},
      });
      await burst;

      expect(required.seq).toEqual(expect.any(Number));
      expect(maxInFlight).toBeLessThanOrEqual(TOOL_COMPLETION_AUDIT_PROCESS_CONCURRENCY);
      expect(warnings()).toEqual([]);
      for (const target of targets) expect(await auditRows(target.runId)).toHaveLength(5);
    }));

  it("retries an audit whose transaction could not start on a starved pool", () =>
    runAsSystem("test", async () => {
      const { prisma, pool } = client(1);
      const events = createThreadEvents(prisma);
      const target = await runInNewThread();
      const held = await pool.connect();
      let attempts = 0;
      const failures: unknown[] = [];
      const append = async (input: AppendEventInput) => {
        attempts += 1;
        try {
          return await events.append(input);
        } catch (error) {
          failures.push(error);
          // Free the pool once the first transaction failed to start.
          if (attempts === 1) held.release();
          throw error;
        }
      };

      await appendToolCompletionAudit(
        {
          events: { append },
          auditQueue: createToolCompletionAuditQueue({ retryBaseMs: 50 }),
        },
        target,
        { name: "shell", executionId: "test-fake-call-starved", durationMs: 1 },
      );

      expect(failures).toEqual([
        expect.objectContaining({
          code: "P2028",
          message: expect.stringContaining("Unable to start a transaction in the given time"),
        }),
      ]);
      expect(attempts).toBe(2);
      expect(warnings()).toEqual([]);
      expect(await auditRows(target.runId)).toHaveLength(1);
    }));

  it("warns retries_exhausted instead of dropping silently when the pool stays starved", () =>
    runAsSystem("test", async () => {
      const { prisma, pool } = client(1);
      const events = createThreadEvents(prisma);
      const target = await runInNewThread();
      const held = await pool.connect();
      try {
        await appendToolCompletionAudit(
          {
            events,
            auditQueue: createToolCompletionAuditQueue({ random: () => 0 }),
          },
          target,
          { name: "shell", executionId: "test-fake-call-exhausted", durationMs: 1 },
        );
      } finally {
        held.release();
      }

      expect(warnings()).toEqual([
        expect.objectContaining({ reason: "retries_exhausted", attempts: 3 }),
      ]);
      expect(await auditRows(target.runId)).toHaveLength(0);
    }));
});
