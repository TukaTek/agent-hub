import { createHash } from "node:crypto";
import { setHubManagedDeploymentSettings } from "@cortexai-agent-hub/core";
import { HubRequestError } from "./hub-client.js";
import {
  HUB_ACCESS_DENIED,
  HUB_CONFIG_INVALID,
  HUB_CONFIG_RESTART_REQUIRED,
  HUB_UNAVAILABLE,
  type HubPolicyCode,
  type HubPolicyDocument,
  HubPolicyError,
  parseHubPolicy,
  TENANT_DISABLED,
} from "./hub-policy-contract.js";
import {
  type HubOverrideSignal,
  hubDeploymentSettings,
  overlayHubEnv,
} from "./hub-policy-overlay.js";
import type { HubPolicyRecord, HubPolicyState, HubPolicyStore } from "./hub-policy-store.js";

/** One conditional service-config read. Throws HubRequestError or a transport error. */
export type HubConfigFetch = (
  etag?: string,
) => Promise<{ status: 304 } | { status: 200; body: unknown; etag?: string }>;

export interface HubPolicyIdentity {
  tenant: string;
  subject: string;
}

/** What this process applied at startup. Startup-bound settings change only on restart. */
export interface AppliedHubPolicy {
  revision: number | null;
  digest: string;
}

export type HubPolicySignal =
  | HubOverrideSignal
  | { event: "hub_policy_rollback"; fromRevision: number; toRevision: number }
  | {
      event: "hub_policy_assignments_unknown";
      hubRevision: number;
      kept: "last_known_good" | "none";
    }
  | { event: "hub_policy_refresh_failed"; code: HubPolicyCode; reason: string }
  | {
      event: "hub_policy_restart_required";
      appliedRevision: number | null;
      hubRevision: number | null;
    };

export interface HubPolicyStatus {
  state: HubPolicyState | "missing" | "restart_required";
  code: HubPolicyCode | null;
  tenant: string;
  hubRevision: number | null;
  appliedRevision: number | null;
  fetchedAt: string | null;
  checkedAt: string | null;
  source: HubPolicyRecord["source"] | null;
  assignments: "configured" | "pending";
  toolkits: "configured" | "unknown";
}

/** Sign-in reuses a Hub answer this recent instead of asking again. */
const SIGN_IN_REUSE_MS = 5_000;

const defaultLog = (signal: HubPolicySignal) =>
  console.warn("[hub-policy]", JSON.stringify(signal));

/** Digest of the startup-bound overrides; toolkits and assignments are read live. */
export function hubPolicyDigest(document: Pick<HubPolicyDocument, "overrides"> | null): string {
  const overrides = document?.overrides ?? {};
  const canonical = Object.keys(overrides)
    .sort()
    .map((key) => [key, overrides[key]]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function classify(error: unknown): { state: HubPolicyState; code: HubPolicyCode; reason: string } {
  if (error instanceof HubPolicyError)
    return { state: "invalid", code: HUB_CONFIG_INVALID, reason: error.reason };
  if (error instanceof HubRequestError) {
    if (error.status === 401 || error.status === 403)
      return { state: "tenant_disabled", code: TENANT_DISABLED, reason: `http_${error.status}` };
    if (error.status === 408 || error.status === 429 || error.status >= 500)
      return { state: "unavailable", code: HUB_UNAVAILABLE, reason: `http_${error.status}` };
    return { state: "invalid", code: HUB_CONFIG_INVALID, reason: `http_${error.status}` };
  }
  // Timeouts, DNS and connection failures: Hub cannot be reached.
  return { state: "unavailable", code: HUB_UNAVAILABLE, reason: "unreachable" };
}

const STATE_CODE: Record<HubPolicyState, HubPolicyCode | null> = {
  ok: null,
  unavailable: HUB_UNAVAILABLE,
  invalid: HUB_CONFIG_INVALID,
  tenant_disabled: TENANT_DISABLED,
};

async function refreshRecord(
  store: HubPolicyStore,
  tenantId: string,
  fetchConfig: HubConfigFetch,
  log: (signal: HubPolicySignal) => void,
): Promise<HubPolicyRecord> {
  const previous = await store.read(tenantId);
  const now = new Date();
  const kept: HubPolicyRecord = previous ?? {
    tenant: tenantId,
    document: null,
    revision: null,
    etag: null,
    digest: null,
    state: "unavailable",
    reason: null,
    source: "hub",
    assignmentsSource: "hub",
    fetchedAt: null,
    checkedAt: null,
    attemptedAt: now,
  };
  let next: HubPolicyRecord;
  try {
    const reply = await fetchConfig(kept.document ? (kept.etag ?? undefined) : undefined);
    if (reply.status === 304) {
      if (!kept.document)
        throw new HubPolicyError(HUB_CONFIG_INVALID, "not_modified_without_snapshot");
      next = {
        ...kept,
        state: "ok",
        reason: null,
        source: "hub",
        checkedAt: now,
        attemptedAt: now,
      };
    } else {
      let document = parseHubPolicy(reply.body, tenantId);
      let assignmentsSource: HubPolicyRecord["assignmentsSource"] = "hub";
      if (document.assignments.status === "unknown") {
        const lastKnown = kept.document?.assignments;
        if (lastKnown?.status === "configured") {
          document = { ...document, assignments: lastKnown };
          assignmentsSource = "last_known_good";
        }
        log({
          event: "hub_policy_assignments_unknown",
          hubRevision: document.revision,
          kept: assignmentsSource === "last_known_good" ? "last_known_good" : "none",
        });
      }
      if (kept.revision !== null && document.revision < kept.revision)
        log({
          event: "hub_policy_rollback",
          fromRevision: kept.revision,
          toRevision: document.revision,
        });
      next = {
        tenant: tenantId,
        document,
        revision: document.revision,
        etag: reply.etag ?? null,
        digest: hubPolicyDigest(document),
        state: "ok",
        reason: null,
        source: "hub",
        assignmentsSource,
        fetchedAt: now,
        checkedAt: now,
        attemptedAt: now,
      };
    }
  } catch (error) {
    const failure = classify(error);
    log({ event: "hub_policy_refresh_failed", code: failure.code, reason: failure.reason });
    next = {
      ...kept,
      state: failure.state,
      reason: failure.reason,
      source: kept.document ? "last_known_good" : "hub",
      attemptedAt: now,
    };
  }
  await store.write(next);
  return next;
}

/**
 * Hub policy for one pinned tenant. The API passes `fetchConfig` and keeps the shared
 * snapshot fresh; the worker only reads it. Sign-in requires a fresh, valid answer
 * from Hub. Active sessions use the stored last-known-good snapshot.
 */
export function createHubPolicy(options: {
  store: HubPolicyStore;
  tenantId: string;
  fetchConfig?: HubConfigFetch;
  applied: AppliedHubPolicy;
  log?: (signal: HubPolicySignal) => void;
}) {
  const { store, tenantId, fetchConfig, applied } = options;
  const log = options.log ?? defaultLog;
  let pending: Promise<HubPolicyRecord> | undefined;
  let last: { at: number; record: HubPolicyRecord } | undefined;
  let restartSignalled: number | null | undefined;

  function refresh(): Promise<HubPolicyRecord> {
    if (!fetchConfig) return store.read(tenantId).then((record) => record ?? missing());
    pending ??= refreshRecord(store, tenantId, fetchConfig, log)
      .then((record) => {
        last = { at: Date.now(), record };
        return record;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }

  function missing(): HubPolicyRecord {
    return {
      tenant: tenantId,
      document: null,
      revision: null,
      etag: null,
      digest: null,
      state: "unavailable",
      reason: "no_snapshot",
      source: "hub",
      assignmentsSource: "hub",
      fetchedAt: null,
      checkedAt: null,
      attemptedAt: new Date(0),
    };
  }

  const stale = (record: HubPolicyRecord) =>
    Boolean(record.document) && record.digest !== applied.digest;

  function restartRequired(record: HubPolicyRecord) {
    if (!stale(record)) return false;
    if (restartSignalled !== record.revision) {
      restartSignalled = record.revision;
      log({
        event: "hub_policy_restart_required",
        appliedRevision: applied.revision,
        hubRevision: record.revision,
      });
    }
    return true;
  }

  /** Throws the refusal for a snapshot that cannot admit new sign-ins. */
  function assertUsable(record: HubPolicyRecord): HubPolicyDocument {
    const code = STATE_CODE[record.state];
    if (code) throw new HubPolicyError(code, record.reason ?? record.state);
    if (!record.document) throw new HubPolicyError(HUB_UNAVAILABLE, "no_snapshot");
    if (restartRequired(record))
      throw new HubPolicyError(HUB_CONFIG_RESTART_REQUIRED, "restart_required");
    return record.document;
  }

  function assignment(document: HubPolicyDocument, identity: HubPolicyIdentity) {
    if (identity.tenant !== tenantId) return "denied" as const;
    if (document.assignments.status !== "configured") return "pending" as const;
    return document.assignments.subjects.includes(identity.subject)
      ? ("assigned" as const)
      : ("denied" as const);
  }

  /** Every sign-in asks Hub (fail closed); the worker cannot, so it never admits one. */
  async function liveRecord(): Promise<HubPolicyRecord> {
    if (!fetchConfig) throw new HubPolicyError(HUB_UNAVAILABLE, "no_hub_access");
    if (last && Date.now() - last.at < SIGN_IN_REUSE_MS && !pending) return last.record;
    return refresh();
  }

  async function check(): Promise<void> {
    assertUsable(await liveRecord());
  }

  return {
    refresh,
    check,
    /** For a sign-in that is about to create a session. */
    async admit(identity: HubPolicyIdentity): Promise<"assigned" | "pending"> {
      const document = assertUsable(await liveRecord());
      const access = assignment(document, identity);
      if (access === "denied") throw new HubPolicyError(HUB_ACCESS_DENIED, "not_assigned");
      return access;
    },
    /** Whether an existing session may continue once its cached Hub verification lapses. */
    async sessionAllowed(identity: HubPolicyIdentity): Promise<boolean> {
      const record = (await store.read(tenantId)) ?? missing();
      try {
        return assignment(assertUsable(record), identity) !== "denied";
      } catch {
        return false;
      }
    },
    /** Whether new work may start. Uses last-known-good while Hub is degraded. */
    async workAllowed(identity: HubPolicyIdentity): Promise<boolean> {
      const record = await store.read(tenantId);
      if (!record?.document || record.state === "tenant_disabled" || restartRequired(record))
        return false;
      return assignment(record.document, identity) === "assigned";
    },
    async status(): Promise<HubPolicyStatus> {
      const record = await store.read(tenantId);
      const restart = record ? stale(record) && record.state === "ok" : false;
      const state: HubPolicyStatus["state"] = !record
        ? "missing"
        : restart
          ? "restart_required"
          : record.state;
      return {
        state,
        code: restart
          ? HUB_CONFIG_RESTART_REQUIRED
          : record
            ? STATE_CODE[record.state]
            : HUB_UNAVAILABLE,
        tenant: tenantId,
        hubRevision: record?.revision ?? null,
        appliedRevision: applied.revision,
        fetchedAt: record?.fetchedAt?.toISOString() ?? null,
        checkedAt: record?.checkedAt?.toISOString() ?? null,
        source: record?.source ?? null,
        assignments:
          record?.document?.assignments.status === "configured" ? "configured" : "pending",
        toolkits: record?.document?.toolkits.status ?? "unknown",
      };
    },
  };
}

export type HubPolicy = ReturnType<typeof createHubPolicy>;

/**
 * Applies the stored Hub revision to this process before anything reads its settings:
 * Hub values replace the environment inputs they manage (in place, so direct readers
 * see them too) and the persisted deployment defaults they manage. The API refreshes
 * from Hub first; the worker applies what the API stored.
 */
export async function applyHubPolicyAtStartup(options: {
  store: HubPolicyStore;
  tenantId: string;
  env: NodeJS.ProcessEnv;
  fetchConfig?: HubConfigFetch;
  deploymentSettings?: () => Promise<Record<string, unknown> | null>;
  log?: (signal: HubPolicySignal) => void;
}): Promise<AppliedHubPolicy> {
  const log = options.log ?? defaultLog;
  const record = options.fetchConfig
    ? await refreshRecord(options.store, options.tenantId, options.fetchConfig, log)
    : await options.store.read(options.tenantId);
  const document = record?.document ?? null;
  if (!document) {
    setHubManagedDeploymentSettings({});
    return { revision: null, digest: hubPolicyDigest(null) };
  }
  const { env, signals } = overlayHubEnv(options.env, document);
  for (const key of Object.keys(options.env)) if (!(key in env)) delete options.env[key];
  Object.assign(options.env, env);
  const row = options.deploymentSettings
    ? await options.deploymentSettings().catch(() => null)
    : null;
  const deployment = hubDeploymentSettings(document, row);
  setHubManagedDeploymentSettings(deployment.managed);
  for (const signal of [...signals, ...deployment.signals]) log(signal);
  return { revision: document.revision, digest: record?.digest ?? hubPolicyDigest(document) };
}
