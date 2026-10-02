import { readFileSync } from "node:fs";
import {
  type HubPolicyRuntime,
  hubAuthFromEnv,
  hubConfigFetch,
  hubPolicyLogEntry,
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
 */
export async function startApiHubPolicy(
  source: NodeJS.ProcessEnv,
  logger: Pick<Logger, "info" | "warn">,
): Promise<(HubPolicyRuntime & { close(): Promise<void> }) | undefined> {
  const hub = hubAuthFromEnv(source, { readSecretFile: (path) => readFileSync(path, "utf8") });
  if (!hub) return undefined;
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
  });
  return {
    ...runtime,
    close: async () => {
      runtime.stop();
      await pool.end();
    },
  };
}
