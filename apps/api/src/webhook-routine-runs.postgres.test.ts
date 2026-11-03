import type { Actor } from "@cortexai-agent-hub/contracts";
import type { PrismaClient } from "@cortexai-agent-hub/db";
import {
  asSystem,
  createDb,
  expireStuckRun,
  finalizeRun,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
  sendUserMessage,
} from "@cortexai-agent-hub/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listRoutineRuns } from "./routine-runs.js";
import { deliverWebhookEvent } from "./webhook-inbound.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("webhook runs in routine run history (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let actor: Actor;
  let botId: string;
  let threadId: string;
  let provisioned = false;
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
  const enqueue = vi.fn().mockResolvedValue(undefined);

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      try {
        await db.prisma.$disconnect();
      } finally {
        await db.pool.end();
      }
    };
    const identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "sendblue", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    ({ botId, threadId } = identity);
    actor = {
      userId: identity.userId,
      spaceId: identity.spaceId,
      email: "webhook-routine@cortexai-agent-hub.test",
      isDeploymentOwner: false,
    };
    provisioned = true;
  });

  afterAll(async () => {
    try {
      if (prisma && provisioned) {
        await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
        await system.organization.deleteMany({ where: { id: actor.spaceId } });
        await system.user.deleteMany({ where: { id: actor.userId } });
      }
    } finally {
      await close?.();
    }
  });

  beforeEach(async () => {
    await system.run.updateMany({
      where: { threadId, status: { in: ["queued", "leased", "running", "waiting_input"] } },
      data: { status: "cancelled" },
    });
    await system.steeringMessage.deleteMany({ where: { botId, runId: null } });
    await system.routine.deleteMany({ where: { botId } });
  });

  const asOwner = <T>(fn: () => Promise<T>) =>
    runAsTenant({ spaceId: actor.spaceId, userId: actor.userId }, fn);

  async function routine(name: string, createdAt: Date) {
    return system.routine.create({
      data: {
        spaceId: actor.spaceId,
        botId,
        userId: actor.userId,
        name,
        prompt: `Handle ${name}`,
        crons: [],
        active: true,
        webhookEnabled: true,
        createdAt,
      },
      select: { id: true, createdAt: true, name: true, prompt: true },
    });
  }

  function deliver(
    routines: Array<{ id: string; createdAt: Date; name: string; prompt: string }>,
    key: string,
  ) {
    return asOwner(() =>
      deliverWebhookEvent(
        {
          events: { sendUserMessage: (input) => sendUserMessage(prisma, input) },
          jobs: { enqueue } as never,
        },
        { bot: { id: botId, spaceId: actor.spaceId, userId: actor.userId }, threadId },
        {
          prompt: `{"event":"${key}"}`,
          routines: routines.map((r) => ({
            ...r,
            modelProvider: null,
            modelId: null,
            thinkingLevel: null,
          })),
          source: "webhook",
          idempotencyKey: `${key}-${Math.random()}`,
        },
      ),
    );
  }

  /** A running chat turn so a webhook delivery is held as steering. */
  async function busyRun(status: "running" | "queued" = "running") {
    const task = await system.task.create({
      data: {
        spaceId: actor.spaceId,
        botId,
        threadId,
        userId: actor.userId,
        prompt: "busy",
        status: "running",
      },
    });
    const run = await system.run.create({
      data: {
        spaceId: actor.spaceId,
        botId,
        threadId,
        taskId: task.id,
        userId: actor.userId,
        status,
        trigger: "user",
        startedAt: new Date(),
        leaseOwner: status === "running" ? "worker-1" : null,
        leaseFence: 1,
      },
    });
    const attempt = await system.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    return { task, run, attempt };
  }

  function finish(busy: Awaited<ReturnType<typeof busyRun>>, outcome: "completed" | "failed") {
    return asOwner(() =>
      finalizeRun(prisma, {
        spaceId: actor.spaceId,
        threadId,
        botId,
        runId: busy.run.id,
        taskId: busy.task.id,
        attemptId: busy.attempt.id,
        leaseOwner: "worker-1",
        leaseFence: 1,
        ...(outcome === "completed"
          ? { outcome, blocks: [{ kind: "text" as const, text: "Done." }] }
          : { outcome, error: "stream idle timeout" }),
      }),
    );
  }

  async function historyIds(routineId: string) {
    const history = await asOwner(() => listRoutineRuns(prisma, actor, routineId));
    return history.runs.map((run) => run.id);
  }

  it("saves an idle-thread webhook run on the oldest matching routine and lists it", async () => {
    const older = await routine("Tracker Events", new Date("2026-01-01T00:00:00Z"));
    const newer = await routine("Other", new Date("2026-02-01T00:00:00Z"));
    const sent = await deliver([newer, older], "idle");
    expect(sent.runId).toEqual(expect.any(String));
    const run = await system.run.findUniqueOrThrow({ where: { id: sent.runId! } });
    expect(run).toMatchObject({ trigger: "webhook", routineId: older.id });
    expect(await historyIds(older.id)).toContain(sent.runId);
    expect(await historyIds(newer.id)).not.toContain(sent.runId);
  });

  it("leaves the run unattributed when no routine matched", async () => {
    const sent = await deliver([], "none");
    const run = await system.run.findUniqueOrThrow({ where: { id: sent.runId! } });
    expect(run.routineId).toBeNull();
  });

  it.each(["completed", "failed"] as const)(
    "attributes the continuation of a held delivery after the busy run %s",
    async (outcome) => {
      const tracker = await routine("Tracker Events", new Date());
      const busy = await busyRun();
      const sent = await deliver([tracker], `held-${outcome}`);
      expect(sent.runId).toBe(busy.run.id);
      const held = await system.steeringMessage.findFirstOrThrow({
        where: { botId, runId: null, originTrigger: "webhook" },
      });
      expect(held.routineId).toBe(tracker.id);

      const result = await finish(busy, outcome);

      const continuationRunId = (result as { continuationRunId: string | null }).continuationRunId;
      expect(continuationRunId).toEqual(expect.any(String));
      const continuation = await system.run.findUniqueOrThrow({
        where: { id: continuationRunId! },
      });
      expect(continuation).toMatchObject({ trigger: "webhook", routineId: tracker.id });
      expect(await historyIds(tracker.id)).toContain(continuationRunId);
    },
  );

  it("attributes the continuation when a stuck queued run expires", async () => {
    const tracker = await routine("Tracker Events", new Date());
    const busy = await busyRun("queued");
    await deliver([tracker], "stuck");
    const { updatedAt } = await system.run.findUniqueOrThrow({ where: { id: busy.run.id } });
    const expired = await system.$transaction((tx) =>
      expireStuckRun(tx, {
        runId: busy.run.id,
        threadId,
        status: "queued",
        updatedAt,
        now: new Date(),
      }),
    );
    expect(expired?.continuationRunId).toEqual(expect.any(String));
    const continuation = await system.run.findUniqueOrThrow({
      where: { id: expired!.continuationRunId! },
    });
    expect(continuation.routineId).toBe(tracker.id);
  });

  it("still continues a held delivery after its routine is deleted", async () => {
    const tracker = await routine("Tracker Events", new Date());
    const busy = await busyRun();
    await deliver([tracker], "deleted");
    await system.routine.delete({ where: { id: tracker.id } });
    const held = await system.steeringMessage.findFirstOrThrow({
      where: { botId, runId: null, originTrigger: "webhook" },
    });
    expect(held.routineId).toBeNull();

    const result = await finish(busy, "completed");

    const continuationRunId = (result as { continuationRunId: string | null }).continuationRunId;
    expect(continuationRunId).toEqual(expect.any(String));
    const continuation = await system.run.findUniqueOrThrow({
      where: { id: continuationRunId! },
    });
    expect(continuation).toMatchObject({ trigger: "webhook", routineId: null });
    expect((await system.run.findUniqueOrThrow({ where: { id: busy.run.id } })).status).toBe(
      "completed",
    );
  });
});
