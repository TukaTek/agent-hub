import { PurgeInterruptedError } from "@cortexai-agent-hub/adapters";
import { createLogger, createTestSink } from "@cortexai-agent-hub/logging";
import { describe, expect, it, vi } from "vitest";
import {
  runTaughtSkillsSecretPurgeAtStartup,
  TAUGHT_SKILLS_PURGE_MARKER,
} from "./taught-skills-purge-startup.js";

const counts = {
  skillsScanned: 3,
  skillsChanged: 1,
  recordingsScrubbed: 1,
  playbooksScrubbed: 1,
  skippedConcurrent: 0,
  draftMessagesScanned: 2,
  draftMessagesScrubbed: 1,
  draftMessagesSkippedConcurrent: 0,
};

/** An in-memory maintenance_markers table. */
function markerPrisma(initial: Record<string, Date> = {}) {
  const rows = new Map(Object.entries(initial));
  const maintenanceMarker = {
    findUnique: vi.fn(async ({ where }: { where: { name: string } }) => {
      const completedAt = rows.get(where.name);
      return completedAt ? { completedAt } : null;
    }),
    upsert: vi.fn(async ({ where }: { where: { name: string } }) => {
      if (!rows.has(where.name)) rows.set(where.name, new Date("2026-10-03T00:00:00.000Z"));
      return { name: where.name, completedAt: rows.get(where.name) };
    }),
  };
  return { rows, prisma: { maintenanceMarker } as never, maintenanceMarker };
}

function setup(nodeEnv: string, skip = false) {
  const sink = createTestSink();
  const logger = createLogger({ service: "test-api", level: "debug", sinks: [sink] });
  const env = { nodeEnv, skipTaughtSkillsPurge: skip, webOrigin: "https://agents.example.test" };
  const markers = markerPrisma();
  return { sink, logger, env, prisma: markers.prisma, markers };
}

describe("runTaughtSkillsSecretPurgeAtStartup", () => {
  it("runs the purge and logs one count-only line naming the deployment", async () => {
    const { sink, logger, env, prisma } = setup("production");
    const purge = vi.fn(async () => counts);
    await runTaughtSkillsSecretPurgeAtStartup({ env, prisma, logger, purge });
    expect(purge).toHaveBeenCalledWith(prisma, { signal: undefined });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      level: "info",
      message: "taught_skills secret purge complete",
      deployment: "agents.example.test",
      ...counts,
      markerRecorded: true,
      durationMs: expect.any(Number),
    });
  });

  it("records a done marker so later starts skip the full scan", async () => {
    const { sink, logger, env, prisma, markers } = setup("production");
    const purge = vi.fn(async () => counts);
    await runTaughtSkillsSecretPurgeAtStartup({ env, prisma, logger, purge });
    expect(markers.maintenanceMarker.upsert).toHaveBeenCalledTimes(1);
    expect([...markers.rows.keys()]).toEqual([TAUGHT_SKILLS_PURGE_MARKER]);

    // The next start (a redeploy or a CAAH-36 self-restart) finds the marker.
    for (let restart = 0; restart < 3; restart += 1) {
      await runTaughtSkillsSecretPurgeAtStartup({ env, prisma, logger, purge });
    }
    expect(purge).toHaveBeenCalledTimes(1);
    expect(markers.maintenanceMarker.upsert).toHaveBeenCalledTimes(1);
    expect(sink.events.slice(1)).toEqual(
      Array.from({ length: 3 }, () =>
        expect.objectContaining({
          level: "info",
          message: "taught_skills secret purge skipped",
          reason: "done",
          deployment: "agents.example.test",
          completedAt: "2026-10-03T00:00:00.000Z",
        }),
      ),
    );
  });

  it("records no marker when a row or card changed concurrently, so the next start retries", async () => {
    for (const skipped of [
      { skippedConcurrent: 1 },
      { draftMessagesSkippedConcurrent: 1 },
    ] as const) {
      const { sink, logger, env, prisma, markers } = setup("production");
      const purge = vi
        .fn()
        .mockResolvedValueOnce({ ...counts, ...skipped })
        .mockResolvedValueOnce(counts);
      await runTaughtSkillsSecretPurgeAtStartup({ env, prisma, logger, purge });
      expect(markers.rows.size).toBe(0);
      expect(sink.events[0]).toMatchObject({ ...skipped, markerRecorded: false });
      await runTaughtSkillsSecretPurgeAtStartup({ env, prisma, logger, purge });
      expect(purge).toHaveBeenCalledTimes(2);
      expect(markers.rows.has(TAUGHT_SKILLS_PURGE_MARKER)).toBe(true);
    }
  });

  it("warns and records no marker when shutdown interrupts the purge", async () => {
    const { sink, logger, env, prisma, markers } = setup("production");
    const controller = new AbortController();
    const purge = vi.fn(async (_prisma: unknown, options: { signal?: AbortSignal }) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      throw new PurgeInterruptedError();
    });
    await expect(
      runTaughtSkillsSecretPurgeAtStartup({
        env,
        prisma,
        logger,
        purge,
        signal: controller.signal,
      }),
    ).resolves.toBeUndefined();
    expect(markers.rows.size).toBe(0);
    expect(sink.events).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "taught_skills secret purge interrupted",
        deployment: "agents.example.test",
      }),
    ]);
  });

  it("is skipped in tests and when SKIP_TAUGHT_SKILLS_PURGE is set", async () => {
    for (const [nodeEnv, skip, reason] of [
      ["test", false, "test"],
      ["production", true, "disabled"],
    ] as const) {
      const { sink, logger, env, prisma } = setup(nodeEnv, skip);
      const purge = vi.fn(async () => counts);
      await runTaughtSkillsSecretPurgeAtStartup({ env, prisma, logger, purge });
      expect(purge).not.toHaveBeenCalled();
      expect(sink.events).toEqual([
        expect.objectContaining({ message: "taught_skills secret purge skipped", reason }),
      ]);
    }
  });

  it("logs a SKIP_TAUGHT_SKILLS_PURGE skip at warn level so a left-on flag is visible", async () => {
    const { sink, logger, env, prisma, markers } = setup("production", true);
    const purge = vi.fn(async () => counts);
    await runTaughtSkillsSecretPurgeAtStartup({ env, prisma, logger, purge });
    expect(sink.events).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "taught_skills secret purge skipped",
        reason: "disabled",
        deployment: "agents.example.test",
      }),
    ]);
    expect(markers.maintenanceMarker.findUnique).not.toHaveBeenCalled();
    expect(markers.rows.size).toBe(0);
  });

  it("never throws and never logs the failing value", async () => {
    const { sink, logger, env, prisma } = setup("production");
    const failure = Object.assign(
      new Error('Invalid update { recording: { key: "Summer2026!" } }'),
      {
        name: "PrismaClientValidationError",
        code: "P2009",
      },
    );
    const purge = vi.fn(async () => {
      throw failure;
    });
    await expect(
      runTaughtSkillsSecretPurgeAtStartup({ env, prisma, logger, purge }),
    ).resolves.toBeUndefined();
    expect(sink.events).toEqual([
      expect.objectContaining({
        level: "error",
        message: "taught_skills secret purge failed",
        deployment: "agents.example.test",
        errorName: "PrismaClientValidationError",
        errorCode: "P2009",
      }),
    ]);
    expect(JSON.stringify(sink.events)).not.toContain("Summer2026!");
  });
});
