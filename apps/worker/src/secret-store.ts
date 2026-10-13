import type { RealtimeFanout, SecretStore } from "@cortexai-agent-hub/adapter-kit";
import { createSecretStore } from "@cortexai-agent-hub/adapters";
import { resolveEncryptionKey } from "@cortexai-agent-hub/core";

/** Worker composition without starting job hosts or database connections. */
export async function createWorkerSecretStore(
  source: NodeJS.ProcessEnv,
  realtime?: RealtimeFanout,
): Promise<SecretStore> {
  const store = createSecretStore(resolveEncryptionKey(source), source, realtime);
  await store.start();
  return store;
}
