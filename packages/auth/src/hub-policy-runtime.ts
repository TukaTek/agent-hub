import { HUB_CONFIG_DOC, type HubConfigProblem } from "./hub-client.js";
import {
  type AppliedHubPolicy,
  applyHubPolicyAtStartup,
  createHubPolicy,
  HUB_POLICY_POLL_MS,
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

export interface HubPolicyRestart {
  appliedRevision: number | null;
  hubRevision: number | null;
}

const SNAPSHOT_POLL_MS = 2_000;
/** The worker reads the shared snapshot this often to notice a revision the API stored. */
const WORKER_POLL_MS = 15_000;
/** A process runs at least this long before a restart, so a flapping Hub cannot crash-loop. */
const MIN_UPTIME_MS = 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts Hub policy for one process. Call it before anything reads the settings
 * Hub manages: it overlays `env` in place with the applied revision.
 *
 * - The API passes `fetchConfig`: it asks Hub at startup, stores the result for both
 *   processes, and polls every `pollMs`.
 * - The worker never contacts Hub. It applies the revision the API stored, waiting up
 *   to `waitForSnapshotMs` for the API's first one so both start on the same revision,
 *   and then reads the shared snapshot every `pollMs`.
 * - When the stored policy changes a startup-bound setting this process applied, it
 *   calls `onRestartRequired` once, so the entry point can drain and exit and the
 *   supervisor (Compose `restart: unless-stopped`, systemd `Restart=`) starts it on the
 *   new revision (F3). It waits until the process has run `minUptimeMs`, and checks
 *   again then: a Hub that flips back to the applied revision causes no exit.
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
  onRestartRequired?: (restart: HubPolicyRestart) => void;
  minUptimeMs?: number;
}): Promise<HubPolicyRuntime> {
  const startedAt = Date.now();
  const { store, tenantId, fetchConfig, onRestartRequired } = options;
  if (!fetchConfig) {
    const deadline = Date.now() + (options.waitForSnapshotMs ?? 60_000);
    while (!(await store.read(tenantId))?.document && Date.now() < deadline)
      await sleep(SNAPSHOT_POLL_MS);
  }
  const applied = await applyHubPolicyAtStartup(options);
  const policy = createHubPolicy({ store, tenantId, fetchConfig, applied, log: options.log });
  const minUptimeMs = options.minUptimeMs ?? MIN_UPTIME_MS;
  let stopped = false;
  let restarting: NodeJS.Timeout | undefined;
  let restarted = false;

  async function considerRestart() {
    if (!onRestartRequired || restarted || restarting || stopped) return;
    if (!(await policy.needsRestart())) return;
    const wait = Math.max(0, startedAt + minUptimeMs - Date.now());
    restarting = setTimeout(() => {
      restarting = undefined;
      void policy
        .needsRestart()
        .then((restart) => {
          if (!restart || stopped || restarted) return;
          restarted = true;
          onRestartRequired(restart);
        })
        .catch(() => undefined);
    }, wait);
    restarting.unref();
  }

  const timer = setInterval(
    () => {
      const tick = fetchConfig ? policy.refresh().then(() => undefined) : Promise.resolve();
      tick.then(considerRestart).catch(() => undefined);
    },
    options.pollMs ?? (fetchConfig ? HUB_POLICY_POLL_MS : WORKER_POLL_MS),
  );
  timer.unref();
  return {
    policy,
    applied,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(restarting);
    },
  };
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

/**
 * The operator log line for a Hub-mode process started without its tenant or service
 * credential (F1). It names each missing setting and the runbook, never a value or path.
 */
export function hubNotConfiguredLogEntry(missing: readonly HubConfigProblem[]): {
  message: string;
  attributes: Record<string, string>;
} {
  const problems = missing.map((item) => `${item.name} is ${item.problem}`).join(", ");
  return {
    message:
      `Hub mode is not configured: ${problems}. Every sign-in is refused with ` +
      `HUB_NOT_CONFIGURED and no work runs until this is fixed and the process restarts. ` +
      `See ${HUB_CONFIG_DOC}`,
    attributes: {
      "hub.missing": missing.map((item) => item.name).join(","),
      "hub.problems": problems,
      "hub.doc": HUB_CONFIG_DOC,
    },
  };
}

const HUB_POLICY_DISABLED_DOC = "docs/hub-auth.md#running-without-hub-registration";

/** The operator warning for a Hub-mode process run with `HUB_POLICY_ENFORCEMENT=off`. */
export function hubPolicyDisabledLogEntry(): {
  message: string;
  attributes: Record<string, string>;
} {
  return {
    message:
      "Hub policy is off (HUB_POLICY_ENFORCEMENT=off): Hub sign-in and entitlement still " +
      "apply, but tenant policy, assignments and Hub-managed settings are not enforced. " +
      `See ${HUB_POLICY_DISABLED_DOC}`,
    attributes: { "hub.policy": "disabled", "hub.doc": HUB_POLICY_DISABLED_DOC },
  };
}

/**
 * `HUB_POLICY_AUTO_RESTART` (default `true`): exit for the supervisor to restart the
 * process when Hub changes a startup-bound setting. `false` keeps the manual restart
 * for hosts without a supervisor.
 */
export function hubPolicyAutoRestart(source: NodeJS.ProcessEnv): boolean {
  const value = source.HUB_POLICY_AUTO_RESTART?.trim() || "true";
  if (value !== "true" && value !== "false")
    throw new Error(`HUB_POLICY_AUTO_RESTART must be true or false. See ${HUB_CONFIG_DOC}`);
  return value === "true";
}
