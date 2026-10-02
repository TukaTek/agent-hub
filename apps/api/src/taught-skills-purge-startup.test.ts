import { createLogger, createTestSink } from "@cortexai-agent-hub/logging";
import { describe, expect, it, vi } from "vitest";
import { runTaughtSkillsSecretPurgeAtStartup } from "./taught-skills-purge-startup.js";

const counts = {
  skillsScanned: 3,
  skillsChanged: 1,
  recordingsScrubbed: 1,
  playbooksScrubbed: 1,
  skippedConcurrent: 0,
  draftMessagesScanned: 2,
  draftMessagesScrubbed: 1,
};

function setup(nodeEnv: string, skip = false) {
  const sink = createTestSink();
  const logger = createLogger({ service: "test-api", level: "debug", sinks: [sink] });
  const env = { nodeEnv, skipTaughtSkillsPurge: skip, webOrigin: "https://agents.example.test" };
  return { sink, logger, env, prisma: {} as never };
}

describe("runTaughtSkillsSecretPurgeAtStartup", () => {
  it("runs the purge and logs one count-only line naming the deployment", async () => {
    const { sink, logger, env, prisma } = setup("production");
    const purge = vi.fn(async () => counts);
    await runTaughtSkillsSecretPurgeAtStartup({ env, prisma, logger, purge });
    expect(purge).toHaveBeenCalledWith(prisma);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      level: "info",
      message: "taught_skills secret purge complete",
      deployment: "agents.example.test",
      ...counts,
      durationMs: expect.any(Number),
    });
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
