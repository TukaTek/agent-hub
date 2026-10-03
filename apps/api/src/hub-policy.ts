import { readFileSync } from "node:fs";
import {
  type HubPolicyRestart,
  type HubPolicyRuntime,
  hubAuthFromEnv,
  hubConfigFetch,
  hubNotConfiguredLogEntry,
  hubPolicyAutoRestart,
  hubPolicyLogEntry,
  notConfiguredHubPolicy,
  prismaHubPolicyStore,
  startHubPolicyRuntime,
} from "@cortexai-agent-hub/auth";
import { resolveEncryptionKey } from "@cortexai-agent-hub/core";
import { createDb } from "@cortexai-agent-hub/db";
import type { Logger } from "@cortexai-agent-hub/logging";

/**
 * CAAH-36: in Hub mode the API asks Hub for this deployment's Agent Hub policy before
 * the environment is parsed, stores it for the worker, and overlays the settings Hub
 * manages onto `source`. Local values remain only for settings Hub does not manage.
 *
 * Without its tenant or service credential the API still starts, fail closed: every
 * sign-in is refused with HUB_NOT_CONFIGURED, no session or work is admitted, health
 * reports degraded, and the log names what is missing (F1).
 *
 * When Hub changes a startup-bound setting, `onRestartRequired` is called once so the
 * entry point can drain and exit for the supervisor to restart it (F3).
 */
export async function startApiHubPolicy(
  source: NodeJS.ProcessEnv,
  logger: Pick<Logger, "info" | "warn" | "error">,
  options: { onRestartRequired?: (restart: HubPolicyRestart) => void } = {},
): Promise<(HubPolicyRuntime & { close(): Promise<void> }) | undefined> {
  const hub = hubAuthFromEnv(source, { readSecretFile: (path) => readFileSync(path, "utf8") });
  if (!hub) return undefined;
  if (hub.notConfigured) {
    const entry = hubNotConfiguredLogEntry(hub.notConfigured.missing);
    logger.error(entry.message, entry.attributes);
    const policy = notConfiguredHubPolicy({
      missing: hub.notConfigured.missing.map((item) => item.name),
    });
    return {
      policy,
      applied: { revision: null, digest: "" },
      stop: () => undefined,
      close: async () => undefined,
    };
  }
  if (!hub.tenantId) throw new Error("Hub mode requires HUB_AUTH_TENANT_ID");
  if (!source.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const { prisma, pool } = createDb(source.DATABASE_URL, {
    poolMax: 2,
    applicationName: "cortexai-agent-hub-api-hub-policy",
  });
  const runtime = await startHubPolicyRuntime({
    store: prismaHubPolicyStore(prisma, resolveEncryptionKey(source)),
    tenantId: hub.tenantId,
    env: source,
    fetchConfig: hubConfigFetch(hub),
    deploymentSettings: () => prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
    log: (signal) => {
      const entry = hubPolicyLogEntry(signal);
      logger[entry.level](entry.message, entry.attributes);
    },
    onRestartRequired: hubPolicyAutoRestart(source) ? options.onRestartRequired : undefined,
  });
  return {
    ...runtime,
    close: async () => {
      runtime.stop();
      await pool.end();
    },
  };
}

/** EX_TEMPFAIL: the supervisor restarts the process onto Hub's new revision. */
export const HUB_POLICY_RESTART_EXIT_CODE = 75;
