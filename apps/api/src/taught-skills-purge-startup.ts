import {
  type PurgePrisma,
  purgeTaughtSkillSecrets,
  type TaughtSkillPurgeCounts,
} from "@cortexai-agent-hub/adapters";
import type { Logger } from "@cortexai-agent-hub/logging";

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
 * CAAH-71 legacy purge, run once per API start from createApp. Idempotent, so every start
 * on every deployment converges; skipped under NODE_ENV=test or SKIP_TAUGHT_SKILLS_PURGE=true.
 * It logs counts only and, on failure, only the error's name and code: a Prisma error message
 * can quote the row it was writing.
 */
export async function runTaughtSkillsSecretPurgeAtStartup(input: {
  env: { nodeEnv: string; skipTaughtSkillsPurge: boolean; webOrigin?: string };
  prisma: PurgePrisma;
  logger: Logger;
  purge?: (prisma: PurgePrisma) => Promise<TaughtSkillPurgeCounts>;
}): Promise<void> {
  const { env, prisma, logger } = input;
  if (env.nodeEnv === "test" || env.skipTaughtSkillsPurge) {
    logger.info("taught_skills secret purge skipped", {
      reason: env.nodeEnv === "test" ? "test" : "disabled",
    });
    return;
  }
  const deployment = deploymentName(env.webOrigin);
  const started = Date.now();
  try {
    const counts = await (input.purge ?? purgeTaughtSkillSecrets)(prisma);
    logger.info("taught_skills secret purge complete", {
      deployment,
      ...counts,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    logger.error("taught_skills secret purge failed", {
      deployment,
      errorName: errorField(error, "name") ?? "Error",
      errorCode: errorField(error, "code"),
      durationMs: Date.now() - started,
    });
  }
}
