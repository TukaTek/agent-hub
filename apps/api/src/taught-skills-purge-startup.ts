import {
  PurgeInterruptedError,
  type PurgePrisma,
  purgeTaughtSkillSecrets,
  type TaughtSkillPurgeCounts,
} from "@cortexai-agent-hub/adapters";
import type { PrismaClient } from "@cortexai-agent-hub/db";
import type { Logger } from "@cortexai-agent-hub/logging";

/** maintenance_markers row recorded once the CAAH-71 purge has finished on a database. */
export const TAUGHT_SKILLS_PURGE_MARKER = "caah71-taught-skills-secret-purge";

export type PurgeStartupPrisma = PurgePrisma & Pick<PrismaClient, "maintenanceMarker">;

function deploymentName(webOrigin: string | undefined): string {
  try {
    return webOrigin ? new URL(webOrigin).host : "unknown";
  } catch {
    return "unknown";
  }
}

function errorField(error: unknown, field: "name" | "code"): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value.slice(0, 80) : undefined;
}

/**
 * CAAH-71 legacy purge. The API starts it in the background after it is listening, so a big
 * messages table never delays readiness. It records a done marker once every row and card was
 * handled; later starts (including CAAH-36 self-restarts) skip it. A run that skipped a
 * concurrently changed row, was interrupted by shutdown or failed records no marker, so the
 * next start retries. Skipped under NODE_ENV=test, and with a warning when
 * SKIP_TAUGHT_SKILLS_PURGE=true. It logs counts only and, on failure, only the error's name
 * and code: a Prisma error message can quote the row it was writing.
 */
export async function runTaughtSkillsSecretPurgeAtStartup(input: {
  env: { nodeEnv: string; skipTaughtSkillsPurge: boolean; webOrigin?: string };
  prisma: PurgeStartupPrisma;
  logger: Logger;
  signal?: AbortSignal;
  purge?: (
    prisma: PurgePrisma,
    options: { signal?: AbortSignal },
  ) => Promise<TaughtSkillPurgeCounts>;
}): Promise<void> {
  const { env, prisma, logger, signal } = input;
  if (env.nodeEnv === "test") {
    logger.info("taught_skills secret purge skipped", { reason: "test" });
    return;
  }
  const deployment = deploymentName(env.webOrigin);
  if (env.skipTaughtSkillsPurge) {
    // Warn: a left-on flag means legacy Teach Me secrets may still be stored.
    logger.warn("taught_skills secret purge skipped", { deployment, reason: "disabled" });
    return;
  }
  const started = Date.now();
  try {
    const marker = await prisma.maintenanceMarker.findUnique({
      where: { name: TAUGHT_SKILLS_PURGE_MARKER },
      select: { completedAt: true },
    });
    if (marker) {
      logger.info("taught_skills secret purge skipped", {
        deployment,
        reason: "done",
        completedAt: marker.completedAt.toISOString(),
      });
      return;
    }
    const counts = await (input.purge ?? purgeTaughtSkillSecrets)(prisma, { signal });
    const markerRecorded =
      counts.skippedConcurrent === 0 && counts.draftMessagesSkippedConcurrent === 0;
    if (markerRecorded) {
      await prisma.maintenanceMarker.upsert({
        where: { name: TAUGHT_SKILLS_PURGE_MARKER },
        create: { name: TAUGHT_SKILLS_PURGE_MARKER },
        update: {},
      });
    }
    logger.info("taught_skills secret purge complete", {
      deployment,
      ...counts,
      markerRecorded,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    if (error instanceof PurgeInterruptedError || signal?.aborted) {
      logger.warn("taught_skills secret purge interrupted", {
        deployment,
        durationMs: Date.now() - started,
      });
      return;
    }
    logger.error("taught_skills secret purge failed", {
      deployment,
      errorName: errorField(error, "name") ?? "Error",
      errorCode: errorField(error, "code"),
      durationMs: Date.now() - started,
    });
  }
}
