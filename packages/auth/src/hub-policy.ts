import { setHubManagedDeploymentSettings } from "@cortexai-agent-hub/core";
import { HubRequestError } from "./hub-client.js";
import {
  HUB_ACCESS_DENIED,
  HUB_CONFIG_INVALID,
  HUB_CONFIG_RESTART_REQUIRED,
  HUB_CREDENTIAL_INVALID,
  HUB_NOT_CONFIGURED,
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

export { hubPolicyDigest } from "./hub-policy-store.js";

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
  | { event: "hub_policy_assignments_empty"; hubRevision: number }
  | { event: "hub_policy_refresh_failed"; code: HubPolicyCode; reason: string }
  | {
      event: "hub_policy_restart_required";
      appliedRevision: number | null;
      hubRevision: number | null;
    };

export interface HubPolicyStatus {
  /** `stale`: no successful Hub contact within the snapshot max age (F5). */
  state: HubPolicyState | "missing" | "restart_required" | "stale" | "not_configured";
  code: HubPolicyCode | null;
  tenant: string;
  hubRevision: number | null;
  appliedRevision: number | null;
  fetchedAt: string | null;
  checkedAt: string | null;
  source: HubPolicyRecord["source"] | null;
  assignments: "configured" | "pending";
  toolkits: "configured" | "unknown";
  /** Not-configured only: the names (never values) of the settings that are missing. */
  missing?: readonly string[];
}

/** Sign-in reuses an accepting Hub answer this recent instead of asking again. */
const SIGN_IN_REUSE_MS = 5_000;
/** The API polls Hub every minute; three missed polls mean the snapshot is too old. */
export const HUB_POLICY_POLL_MS = 60_000;
const SNAPSHOT_MAX_AGE_MS = 3 * HUB_POLICY_POLL_MS;

const defaultLog = (signal: HubPolicySignal) =>
  console.warn("[hub-policy]", JSON.stringify(signal));

const CREDENTIAL_REASONS = new Set(["invalid_credentials", "invalid_service_token"]);
const ACCESS_DENIED_REASONS = new Set([
  "access_denied",
  "service_grant_missing",
  "tenant_disabled",
  "product_disabled",
]);

function classify(error: unknown): { state: HubPolicyState; code: HubPolicyCode; reason: string } {
  if (error instanceof HubPolicyError)
    return { state: "invalid", code: HUB_CONFIG_INVALID, reason: error.reason };
  if (error instanceof HubRequestError) {
    // 401: Hub rejected this deployment's service credential (F9). 403: Hub refuses the
    // tenant; token mint says only `access_denied`, verification names the cause. The
    // sub-code is an operator log reason only; users see the stable code.
    if (error.status === 401)
      return {
        state: "credential_invalid",
        code: HUB_CREDENTIAL_INVALID,
        reason: CREDENTIAL_REASONS.has(error.code ?? "") ? error.code! : "http_401",
      };
    if (error.status === 403)
      return {
        state: "tenant_disabled",
        code: TENANT_DISABLED,
        reason: ACCESS_DENIED_REASONS.has(error.code ?? "") ? error.code! : "access_denied",
      };
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
  credential_invalid: HUB_CREDENTIAL_INVALID,
};

/** States in which Hub has withdrawn this deployment, so work stops at once. */
const WITHDRAWN: ReadonlySet<HubPolicyState> = new Set(["tenant_disabled", "credential_invalid"]);

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
      // Once Hub has sent its authoritative assignment list, a list without the contract
      // is a Hub regression, never "pending" with last-known-good assignments (F4).
      if (kept.document?.assignments.contract && !document.assignments.contract)
        throw new HubPolicyError(HUB_CONFIG_INVALID, "assignments_contract_missing");
      if (document.assignments.contract && document.assignments.subjects.length === 0)
        log({ event: "hub_policy_assignments_empty", hubRevision: document.revision });
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
        digest: store.digest(document),
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
  /** A snapshot without a successful Hub contact for longer than this is unusable (F5). */
  maxSnapshotAgeMs?: number;
}) {
  const { store, tenantId, fetchConfig, applied } = options;
  const log = options.log ?? defaultLog;
  const maxAgeMs = options.maxSnapshotAgeMs ?? SNAPSHOT_MAX_AGE_MS;
  /** No successful Hub contact (200 or 304) within the max age: treat as unavailable. */
  const tooOld = (record: HubPolicyRecord) =>
    !record.checkedAt || Date.now() - record.checkedAt.getTime() > maxAgeMs;
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
    if (tooOld(record)) throw new HubPolicyError(HUB_UNAVAILABLE, "snapshot_stale");
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
    // Only acceptance is reused, so a sign-in after a refusal asks Hub again.
    if (last?.record.state === "ok" && Date.now() - last.at < SIGN_IN_REUSE_MS && !pending)
      return last.record;
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
      if (!record?.document || WITHDRAWN.has(record.state) || tooOld(record)) return false;
      if (restartRequired(record)) return false;
      return assignment(record.document, identity) === "assigned";
    },
    /**
     * Whether the stored policy changes a startup-bound setting this process applied.
     * The runtime uses it to exit so the supervisor restarts onto the new revision (F3).
     */
    async needsRestart(): Promise<{
      appliedRevision: number | null;
      hubRevision: number | null;
    } | null> {
      const record = await store.read(tenantId);
      if (!record || !restartRequired(record)) return null;
      return { appliedRevision: applied.revision, hubRevision: record.revision };
    },
    async status(): Promise<HubPolicyStatus> {
      const record = await store.read(tenantId);
      const restart = record ? stale(record) && record.state === "ok" : false;
      const old = record?.state === "ok" && Boolean(record.document) && tooOld(record);
      const state: HubPolicyStatus["state"] = !record
        ? "missing"
        : restart
          ? "restart_required"
          : old
            ? "stale"
            : record.state;
      return {
        state,
        code: restart
          ? HUB_CONFIG_RESTART_REQUIRED
          : old
            ? HUB_UNAVAILABLE
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
 * The policy of a Hub-mode process started without its tenant or service credential
 * (F1). It never contacts Hub and admits nothing: every sign-in is refused with
 * HUB_NOT_CONFIGURED, and no session or work is allowed. Status names what is missing.
 */
export function notConfiguredHubPolicy(options: {
  missing: readonly string[];
  tenantId?: string;
}): HubPolicy {
  const refuse = () => new HubPolicyError(HUB_NOT_CONFIGURED, "not_configured");
  const record = (): HubPolicyRecord => ({
    tenant: options.tenantId ?? "",
    document: null,
    revision: null,
    etag: null,
    digest: null,
    state: "unavailable",
    reason: "not_configured",
    source: "hub",
    assignmentsSource: "hub",
    fetchedAt: null,
    checkedAt: null,
    attemptedAt: new Date(0),
  });
  return {
    refresh: async () => record(),
    check: async () => {
      throw refuse();
    },
    admit: async () => {
      throw refuse();
    },
    sessionAllowed: async () => false,
    workAllowed: async () => false,
    needsRestart: async () => null,
    status: async () => ({
      state: "not_configured",
      code: HUB_NOT_CONFIGURED,
      tenant: options.tenantId ?? "",
      hubRevision: null,
      appliedRevision: null,
      fetchedAt: null,
      checkedAt: null,
      source: null,
      assignments: "pending",
      toolkits: "unknown",
      missing: [...options.missing],
    }),
  };
}

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
    return { revision: null, digest: options.store.digest(null) };
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
  return { revision: document.revision, digest: record?.digest ?? options.store.digest(document) };
}
