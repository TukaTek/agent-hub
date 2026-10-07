import {
  disabledHubPolicy,
  type HubAuthConfig,
  type HubPolicy,
  type HubPolicyRestart,
  hubAuthFromEnv,
  hubNotConfiguredLogEntry,
  hubPolicyAutoRestart,
  hubPolicyDisabledLogEntry,
  hubPolicyLogEntry,
  notConfiguredHubPolicy,
  prismaHubPolicyStore,
  startHubPolicyRuntime,
} from "@cortexai-agent-hub/auth";
import { resolveEncryptionKey } from "@cortexai-agent-hub/core";
import type { PrismaClient } from "@cortexai-agent-hub/db";
import type { Logger } from "@cortexai-agent-hub/logging";

/**
 * CAAH-36: before anything reads settings, apply the Hub revision the API stored. The
 * worker never contacts Hub; it uses the same revision as the API. Without its tenant
 * it starts fail closed and admits no work (F1). With `HUB_POLICY_ENFORCEMENT=off` it
 * warns once and runs work without Hub tenant policy (CAAH-83).
 */
export async function startWorkerHubPolicy(
  source: NodeJS.ProcessEnv,
  logger: Pick<Logger, "info" | "warn" | "error">,
  prisma: PrismaClient,
  options: { onRestartRequired?: (restart: HubPolicyRestart) => void } = {},
): Promise<{ config: HubAuthConfig | undefined; policy: HubPolicy | undefined }> {
  const config = hubAuthFromEnv(source);
  if (!config) return { config, policy: undefined };
  if (config.notConfigured) {
    const entry = hubNotConfiguredLogEntry(config.notConfigured.missing);
    logger.error(entry.message, entry.attributes);
    return {
      config,
      policy: notConfiguredHubPolicy({
        missing: config.notConfigured.missing.map((item) => item.name),
      }),
    };
  }
  if (config.policyDisabled) {
    const entry = hubPolicyDisabledLogEntry();
    logger.warn(entry.message, entry.attributes);
    return { config, policy: disabledHubPolicy({ tenantId: config.tenantId }) };
  }
  if (!config.tenantId) throw new Error("Hub mode requires HUB_AUTH_TENANT_ID");
  const runtime = await startHubPolicyRuntime({
    store: prismaHubPolicyStore(prisma, resolveEncryptionKey(source)),
    tenantId: config.tenantId,
    env: source,
    deploymentSettings: () => prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
    log: (signal) => {
      const entry = hubPolicyLogEntry(signal);
      logger[entry.level](entry.message, entry.attributes);
    },
    onRestartRequired: hubPolicyAutoRestart(source) ? options.onRestartRequired : undefined,
  });
  return { config, policy: runtime.policy };
}
