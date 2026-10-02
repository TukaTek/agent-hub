import {
  type AppliedHubPolicy,
  applyHubPolicyAtStartup,
  createHubPolicy,
  type HubConfigFetch,
  type HubPolicy,
  type HubPolicySignal,
} from "./hub-policy.js";
import type { HubPolicyStore } from "./hub-policy-store.js";

export interface HubPolicyRuntime {
  policy: HubPolicy;
  applied: AppliedHubPolicy;
  stop(): void;
}

const SNAPSHOT_POLL_MS = 2_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts Hub policy for one process. Call it before anything reads the settings
 * Hub manages: it overlays `env` in place with the applied revision.
 *
 * - The API passes `fetchConfig`: it asks Hub at startup, stores the result for both
 *   processes, and polls every `pollMs`.
 * - The worker never contacts Hub. It applies the revision the API stored, waiting up
 *   to `waitForSnapshotMs` for the API's first one so both start on the same revision.
 *   Without one it applies nothing and refuses work until it is restarted.
 */
export async function startHubPolicyRuntime(options: {
  store: HubPolicyStore;
  tenantId: string;
  env: NodeJS.ProcessEnv;
  fetchConfig?: HubConfigFetch;
  deploymentSettings?: () => Promise<Record<string, unknown> | null>;
  log?: (signal: HubPolicySignal) => void;
  pollMs?: number;
  waitForSnapshotMs?: number;
}): Promise<HubPolicyRuntime> {
  const { store, tenantId, fetchConfig } = options;
  if (!fetchConfig) {
    const deadline = Date.now() + (options.waitForSnapshotMs ?? 60_000);
    while (!(await store.read(tenantId))?.document && Date.now() < deadline)
      await sleep(SNAPSHOT_POLL_MS);
  }
  const applied = await applyHubPolicyAtStartup(options);
  const policy = createHubPolicy({ store, tenantId, fetchConfig, applied, log: options.log });
  let timer: NodeJS.Timeout | undefined;
  if (fetchConfig) {
    timer = setInterval(() => {
      policy.refresh().catch(() => undefined);
    }, options.pollMs ?? 60_000);
    timer.unref();
  }
  return { policy, applied, stop: () => clearInterval(timer) };
}

/**
 * How a signal is logged. Signals carry setting paths, revisions, sources and fixed
 * reason tokens only, so the attributes can never contain a setting value.
 */
export function hubPolicyLogEntry(signal: HubPolicySignal): {
  level: "info" | "warn";
  message: string;
  attributes: Record<string, string | number | null>;
} {
  const attributes: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(signal))
    attributes[`hub.policy.${key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`] = value;
  return {
    level: signal.event === "hub_policy_override" ? "info" : "warn",
    message: signal.event,
    attributes,
  };
}
