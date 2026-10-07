import { createHash } from "node:crypto";
import {
  hubManagedDeploymentSettings,
  setHubManagedDeploymentSettings,
} from "@cortexai-agent-hub/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/agent-hub-service-config.v1.json" with { type: "json" };
import hubSample from "./fixtures/hub-agent-hub-service-config.v1.sample.json" with {
  type: "json",
};
import { HubRequestError } from "./hub-client.js";
import {
  applyHubPolicyAtStartup,
  createHubPolicy,
  disabledHubPolicy,
  type HubConfigFetch,
  type HubPolicySignal,
  hubPolicyDigest,
  notConfiguredHubPolicy,
} from "./hub-policy.js";
import { HubPolicyError } from "./hub-policy-contract.js";
import { memoryHubPolicyStore } from "./hub-policy-store.js";
import { hubPolicyBodyForTests } from "./hub-policy-testing.js";

const TENANT = "tenant-a";
const assigned = { tenant: TENANT, subject: "subject-1" };
const clone = <T>(value: T): T => structuredClone(value);
const ok = (body: unknown, etag = `"etag-${Math.random()}"`) =>
  vi.fn<HubConfigFetch>(async () => ({ status: 200, body, etag }));
const configured = () => clone(fixture.cases.configured);
const dnsFailure = () =>
  Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
const timeout = () =>
  Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HubPolicyError);
    return (error as HubPolicyError).code;
  }
  return "admitted";
}

/** One API process (fetches Hub) and one worker (reads the shared store), started together. */
async function start(fetchConfig: HubConfigFetch, store = memoryHubPolicyStore()) {
  const signals: HubPolicySignal[] = [];
  const log = (signal: HubPolicySignal) => signals.push(signal);
  const apiEnv: NodeJS.ProcessEnv = { PI_DEFAULT_PROVIDER: "openrouter" };
  const apiApplied = await applyHubPolicyAtStartup({
    store,
    tenantId: TENANT,
    fetchConfig,
    env: apiEnv,
    log,
  });
  const api = createHubPolicy({ store, tenantId: TENANT, fetchConfig, applied: apiApplied, log });
  const workerEnv: NodeJS.ProcessEnv = { PI_DEFAULT_PROVIDER: "openrouter" };
  const workerApplied = await applyHubPolicyAtStartup({
    store,
    tenantId: TENANT,
    env: workerEnv,
    log,
  });
  const worker = createHubPolicy({ store, tenantId: TENANT, applied: workerApplied, log });
  return { api, worker, store, signals, apiEnv, workerEnv, apiApplied, workerApplied };
}

afterEach(() => {
  vi.useRealTimers();
  setHubManagedDeploymentSettings({});
});

describe("Hub policy last-known-good cache", () => {
  it("stores the validated document with revision, freshness and source", async () => {
    const { store } = await start(ok(configured(), '"etag-7"'));
    const record = await store.read(TENANT);
    expect(record).toMatchObject({
      tenant: TENANT,
      revision: 7,
      etag: '"etag-7"',
      state: "ok",
      source: "hub",
      assignmentsSource: "hub",
    });
    expect(record?.fetchedAt).toBeInstanceOf(Date);
    expect(record?.checkedAt).toBeInstanceOf(Date);
    expect(record?.document?.overrides["model.defaultProvider"]).toBe("anthropic");
  });

  it("revalidates with the stored ETag and keeps the document on 304", async () => {
    const fetchConfig = ok(configured(), '"etag-7"');
    const { api, store } = await start(fetchConfig);
    fetchConfig.mockResolvedValueOnce({ status: 304 });
    vi.useFakeTimers({ now: Date.now() + 10_000 });
    await api.refresh();
    expect(fetchConfig).toHaveBeenLastCalledWith('"etag-7"');
    const record = await store.read(TENANT);
    expect(record).toMatchObject({ revision: 7, state: "ok", source: "hub" });
    expect(record?.checkedAt?.getTime()).toBeGreaterThan(record!.fetchedAt!.getTime());
  });

  it.each([
    ["a timeout", timeout],
    ["a DNS failure", dnsFailure],
    ["HTTP 500", () => new HubRequestError(500, undefined)],
    ["HTTP 502", () => new HubRequestError(502, undefined)],
    ["HTTP 503", () => new HubRequestError(503, "configuration_unavailable")],
    ["HTTP 429", () => new HubRequestError(429, undefined)],
  ])("treats %s as HUB_UNAVAILABLE and keeps last-known-good", async (_name, failure) => {
    const fetchConfig = ok(configured());
    const { api, store, signals } = await start(fetchConfig);
    fetchConfig.mockRejectedValue(failure());
    vi.useFakeTimers({ now: Date.now() + 10_000 });
    expect(await codeOf(api.check())).toBe("HUB_UNAVAILABLE");
    const record = await store.read(TENANT);
    expect(record).toMatchObject({ state: "unavailable", revision: 7, source: "last_known_good" });
    expect(record?.document?.revision).toBe(7);
    expect(signals).toContainEqual(
      expect.objectContaining({ event: "hub_policy_refresh_failed", code: "HUB_UNAVAILABLE" }),
    );
  });

  it.each([
    [
      401,
      "invalid_service_token",
      "HUB_CREDENTIAL_INVALID",
      "credential_invalid",
      "invalid_service_token",
    ],
    [
      401,
      "invalid_credentials",
      "HUB_CREDENTIAL_INVALID",
      "credential_invalid",
      "invalid_credentials",
    ],
    [401, "something_else", "HUB_CREDENTIAL_INVALID", "credential_invalid", "http_401"],
    [403, "access_denied", "TENANT_DISABLED", "tenant_disabled", "access_denied"],
    [403, "service_grant_missing", "TENANT_DISABLED", "tenant_disabled", "service_grant_missing"],
    [403, "tenant_disabled", "TENANT_DISABLED", "tenant_disabled", "tenant_disabled"],
    [403, "product_disabled", "TENANT_DISABLED", "tenant_disabled", "product_disabled"],
    [403, "unexpected_code", "TENANT_DISABLED", "tenant_disabled", "access_denied"],
  ])("treats Hub %i %s as %s and stops new work", async (status, code, expected, state, reason) => {
    const fetchConfig = ok(configured());
    const { api, worker, store } = await start(fetchConfig);
    expect(await worker.workAllowed(assigned)).toBe(true);
    fetchConfig.mockRejectedValue(new HubRequestError(status, code));
    vi.useFakeTimers({ now: Date.now() + 10_000 });
    expect(await codeOf(api.check())).toBe(expected);
    // The sub-code is for operators: it is the log reason only, never shown to users.
    expect(await store.read(TENANT)).toMatchObject({ state, reason });
    expect((await api.status()).code).toBe(expected);
    expect(await api.workAllowed(assigned)).toBe(false);
    expect(await worker.workAllowed(assigned)).toBe(false);
    expect(await worker.sessionAllowed(assigned)).toBe(false);
  });

  it.each([
    ["a malformed document", () => "not json"],
    ["an unknown schema", () => ({ ...configured(), schemaVersion: "agent-hub-settings-v9" })],
    ["another tenant's document", () => ({ ...configured(), tenantId: "tenant-b" })],
    ["an all-tools field", () => ({ ...configured(), composio: { allToolkits: true } })],
  ])("rejects %s as HUB_CONFIG_INVALID without replacing last-known-good", async (_name, body) => {
    const fetchConfig = ok(configured());
    const { api, store } = await start(fetchConfig);
    fetchConfig.mockResolvedValue({ status: 200, body: body(), etag: '"bad"' });
    vi.useFakeTimers({ now: Date.now() + 10_000 });
    expect(await codeOf(api.check())).toBe("HUB_CONFIG_INVALID");
    const record = await store.read(TENANT);
    expect(record).toMatchObject({ state: "invalid", revision: 7 });
    expect(record?.etag).not.toBe('"bad"');
    expect(record?.document?.toolkits).toEqual({ status: "configured", allowed: ["github"] });
  });

  it("recovers when Hub returns", async () => {
    const fetchConfig = ok(configured(), '"etag-7"');
    const { api } = await start(fetchConfig);
    fetchConfig.mockRejectedValueOnce(dnsFailure());
    vi.useFakeTimers({ now: Date.now() + 10_000 });
    expect(await codeOf(api.check())).toBe("HUB_UNAVAILABLE");
    fetchConfig.mockResolvedValueOnce({ status: 304 });
    vi.setSystemTime(Date.now() + 10_000);
    expect(await codeOf(api.check())).toBe("admitted");
    expect(await api.admit(assigned)).toBe("assigned");
  });

  it("accepts a rollback to an older Hub revision and signals it", async () => {
    const fetchConfig = ok(configured());
    const { api, store, signals } = await start(fetchConfig);
    fetchConfig.mockResolvedValue({
      status: 200,
      body: { ...configured(), revision: 5 },
      etag: '"etag-5"',
    });
    vi.useFakeTimers({ now: Date.now() + 10_000 });
    await api.refresh();
    expect((await store.read(TENANT))?.revision).toBe(5);
    expect(signals).toContainEqual({
      event: "hub_policy_rollback",
      fromRevision: 7,
      toRevision: 5,
    });
  });

  it("shares one Hub request between concurrent sign-ins and reuses a result for five seconds", async () => {
    const fetchConfig = ok(configured());
    const { api } = await start(fetchConfig);
    vi.useFakeTimers({ now: Date.now() + 10_000 });
    fetchConfig.mockClear();
    await Promise.all([api.check(), api.check(), api.admit(assigned)]);
    expect(fetchConfig).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 4_000);
    await api.check();
    expect(fetchConfig).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 2_000);
    await api.check();
    expect(fetchConfig).toHaveBeenCalledTimes(2);
  });

  it("asks Hub again on the next sign-in after a refusal, so recovery is immediate", async () => {
    const fetchConfig = ok(configured());
    const { api } = await start(fetchConfig);
    vi.useFakeTimers({ now: Date.now() + 10_000 });
    fetchConfig.mockRejectedValueOnce(dnsFailure());
    expect(await codeOf(api.check())).toBe("HUB_UNAVAILABLE");
    expect(await codeOf(api.admit(assigned))).toBe("admitted");
    expect(fetchConfig).toHaveBeenCalledTimes(3);
  });
});

describe("CAH-204 product assignment guard", () => {
  it("keeps last-known-good assignments when Hub sends an empty list", async () => {
    const fetchConfig = ok(configured());
    const { api, store, signals } = await start(fetchConfig);
    const empty = configured();
    empty.access.productAssignments = [];
    fetchConfig.mockResolvedValue({ status: 200, body: empty, etag: '"empty"' });
    vi.useFakeTimers({ now: Date.now() + 10_000 });
    await api.refresh();
    const record = await store.read(TENANT);
    expect(record?.assignmentsSource).toBe("last_known_good");
    expect(record?.document?.assignments).toEqual({
      status: "configured",
      subjects: ["subject-1", "subject-2"],
    });
    expect(await api.admit(assigned)).toBe("assigned");
    expect(signals).toContainEqual({
      event: "hub_policy_assignments_unknown",
      hubRevision: 7,
      kept: "last_known_good",
    });
  });

  it("without last-known-good allows sign-in but grants no product or tool access", async () => {
    const { api, worker, signals } = await start(ok(fixture.cases.empty));
    expect(await api.admit(assigned)).toBe("pending");
    expect(await api.sessionAllowed(assigned)).toBe(true);
    expect(await api.workAllowed(assigned)).toBe(false);
    expect(await worker.workAllowed(assigned)).toBe(false);
    expect((await api.status()).assignments).toBe("pending");
    expect(signals).toContainEqual({
      event: "hub_policy_assignments_unknown",
      hubRevision: 0,
      kept: "none",
    });
  });

  it("refuses a user Hub's assignment list does not include", async () => {
    const { api, worker } = await start(ok(configured()));
    const other = { tenant: TENANT, subject: "subject-9" };
    expect(await codeOf(api.admit(other))).toBe("HUB_ACCESS_DENIED");
    expect(await worker.sessionAllowed(other)).toBe(false);
    expect(await worker.workAllowed(other)).toBe(false);
  });
});

describe("Agent Hub assignment contract marker (agent-hub-assignments.v1)", () => {
  const marked = (subjects: string[], revision: number) =>
    hubPolicyBodyForTests(TENANT, subjects, revision, { contract: true });
  const other = { tenant: TENANT, subject: "subject-2" };

  it("admits only the users Hub lists", async () => {
    const { api, worker } = await start(ok(marked(["subject-1"], 1)));
    expect(await api.admit(assigned)).toBe("assigned");
    expect(await worker.workAllowed(assigned)).toBe(true);
    expect(await codeOf(api.admit(other))).toBe("HUB_ACCESS_DENIED");
    expect(await worker.sessionAllowed(other)).toBe(false);
    expect(await worker.workAllowed(other)).toBe(false);
  });

  it("denies everyone on an empty list instead of keeping last-known-good", async () => {
    const fetchConfig = ok(marked(["subject-1"], 1));
    const { api, worker, store, signals } = await start(fetchConfig);
    expect(await worker.workAllowed(assigned)).toBe(true);
    fetchConfig.mockResolvedValue({ status: 200, body: marked([], 2), etag: '"nobody"' });
    await api.refresh();
    const record = await store.read(TENANT);
    expect(record?.assignmentsSource).toBe("hub");
    expect(record?.document?.assignments).toEqual({
      status: "configured",
      subjects: [],
      contract: "agent-hub-assignments.v1",
    });
    expect(await codeOf(api.admit(assigned))).toBe("HUB_ACCESS_DENIED");
    for (const process of [api, worker]) {
      expect(await process.sessionAllowed(assigned)).toBe(false);
      expect(await process.workAllowed(assigned)).toBe(false);
    }
    expect((await api.status()).assignments).toBe("configured");
    expect(signals.map((signal) => signal.event)).not.toContain("hub_policy_assignments_unknown");
  });

  it("moves from pending to denied when Hub's first marked list is empty", async () => {
    const fetchConfig = ok(hubPolicyBodyForTests(TENANT, [], 1));
    const { api, worker } = await start(fetchConfig);
    expect(await api.admit(assigned)).toBe("pending");
    expect(await worker.sessionAllowed(assigned)).toBe(true);
    fetchConfig.mockResolvedValue({ status: 200, body: marked([], 2), etag: '"nobody"' });
    await api.refresh();
    expect(await codeOf(api.admit(assigned))).toBe("HUB_ACCESS_DENIED");
    expect(await worker.sessionAllowed(assigned)).toBe(false);
    expect(await worker.workAllowed(assigned)).toBe(false);
    expect((await api.status()).assignments).toBe("configured");
  });

  it("keeps last-known-good and grants nothing when Hub sends an unknown marker", async () => {
    const fetchConfig = ok(marked(["subject-1"], 1));
    const { api, worker, store } = await start(fetchConfig);
    const unknown: any = marked(["subject-1", "subject-2"], 2);
    unknown.access.contract = "agent-hub-assignments.v2";
    fetchConfig.mockResolvedValue({ status: 200, body: unknown, etag: '"v2"' });
    await api.refresh();
    expect((await store.read(TENANT))?.revision).toBe(1);
    expect(await codeOf(api.admit(other))).toBe("HUB_CONFIG_INVALID");
    expect(await codeOf(api.admit(assigned))).toBe("HUB_CONFIG_INVALID");
    expect(await worker.workAllowed(other)).toBe(false);
  });
});

describe("Hub's published service-config sample (CAH-204)", () => {
  it("admits its listed users and denies them once the list is emptied", async () => {
    const tenant = hubSample.tenantId;
    const store = memoryHubPolicyStore();
    const fetchConfig = vi.fn<HubConfigFetch>(async () => ({
      status: 200,
      body: clone(hubSample),
      etag: '"sample"',
    }));
    const applied = await applyHubPolicyAtStartup({
      store,
      tenantId: tenant,
      fetchConfig,
      env: {},
      log: () => undefined,
    });
    const api = createHubPolicy({
      store,
      tenantId: tenant,
      fetchConfig,
      applied,
      log: () => undefined,
    });
    const users = hubSample.access.productAssignments.map((row) => ({
      tenant,
      subject: row.tenantUserId,
    }));
    for (const user of users) expect(await api.admit(user)).toBe("assigned");
    expect(await codeOf(api.admit({ tenant, subject: "usr_not_listed" }))).toBe(
      "HUB_ACCESS_DENIED",
    );
    const emptied = clone(hubSample);
    emptied.access.productAssignments = [];
    fetchConfig.mockResolvedValue({ status: 200, body: emptied, etag: '"emptied"' });
    await api.refresh();
    for (const user of users) {
      expect(await codeOf(api.admit(user))).toBe("HUB_ACCESS_DENIED");
      expect(await api.sessionAllowed(user)).toBe(false);
      expect(await api.workAllowed(user)).toBe(false);
    }
  });
});

describe("assignment contract marker is sticky once seen (F4)", () => {
  const marked = (subjects: string[], revision: number) =>
    hubPolicyBodyForTests(TENANT, subjects, revision, { contract: true });
  const alice = { tenant: TENANT, subject: "subject-1" };

  it.each([
    ["an unmarked empty list", () => hubPolicyBodyForTests(TENANT, [], 2)],
    ["an unmarked list", () => hubPolicyBodyForTests(TENANT, ["subject-1", "subject-2"], 2)],
    [
      "the marker with a status other than configured",
      () => {
        const body: any = marked(["subject-1"], 2);
        body.access.status = "pending";
        return body;
      },
    ],
    [
      "unattributable rows",
      () => {
        const body: any = hubPolicyBodyForTests(TENANT, [], 2);
        body.access = { status: "configured", productAssignments: [{ tenantUserId: "subject-1" }] };
        return body;
      },
    ],
  ])("rejects %s after an authoritative list instead of keeping it", async (_name, next) => {
    const fetchConfig = ok(marked(["subject-1"], 1));
    const { api, worker, store, signals } = await start(fetchConfig);
    expect(await api.admit(alice)).toBe("assigned");
    fetchConfig.mockResolvedValue({ status: 200, body: next(), etag: '"lost"' });
    vi.useFakeTimers({ now: Date.now() + 10_000 });
    expect(await codeOf(api.admit(alice))).toBe("HUB_CONFIG_INVALID");
    const record = await store.read(TENANT);
    expect(record).toMatchObject({ state: "invalid", reason: "assignments_contract_missing" });
    expect(record?.assignmentsSource).toBe("hub");
    expect(await worker.sessionAllowed(alice)).toBe(false);
    expect(signals).not.toContainEqual(
      expect.objectContaining({ event: "hub_policy_assignments_unknown" }),
    );
  });

  it("stays sticky across a restart because it is stored with last-known-good", async () => {
    const store = memoryHubPolicyStore();
    const fetchConfig = ok(marked(["subject-1"], 1));
    await start(fetchConfig, store);
    fetchConfig.mockResolvedValue({
      status: 200,
      body: hubPolicyBodyForTests(TENANT, [], 2),
      etag: '"lost"',
    });
    const restarted = await start(fetchConfig, store);
    expect(await codeOf(restarted.api.admit(alice))).toBe("HUB_CONFIG_INVALID");
    expect((await store.read(TENANT))?.document?.assignments).toMatchObject({
      contract: "agent-hub-assignments.v1",
      subjects: ["subject-1"],
    });
  });

  it("recovers as soon as Hub sends the marker again", async () => {
    const fetchConfig = ok(marked(["subject-1"], 1));
    const { api } = await start(fetchConfig);
    fetchConfig.mockResolvedValue({ status: 200, body: hubPolicyBodyForTests(TENANT, [], 2) });
    vi.useFakeTimers({ now: Date.now() + 10_000 });
    expect(await codeOf(api.admit(alice))).toBe("HUB_CONFIG_INVALID");
    fetchConfig.mockResolvedValue({ status: 200, body: marked(["subject-1"], 3) });
    expect(await api.admit(alice)).toBe("assigned");
  });

  it("signals when an authoritative list is empty, so a lockout's cause is in the logs", async () => {
    const fetchConfig = ok(marked(["subject-1"], 1));
    const { api, signals } = await start(fetchConfig);
    fetchConfig.mockResolvedValue({ status: 200, body: marked([], 2), etag: '"empty"' });
    await api.refresh();
    expect(signals).toContainEqual({ event: "hub_policy_assignments_empty", hubRevision: 2 });
  });
});

describe("snapshot max age (F5)", () => {
  it("refuses sessions and work on a snapshot older than three poll intervals", async () => {
    const { worker } = await start(ok(configured()));
    vi.useFakeTimers({ now: Date.now() + 179_000 });
    expect(await worker.sessionAllowed(assigned)).toBe(true);
    expect(await worker.workAllowed(assigned)).toBe(true);
    vi.setSystemTime(Date.now() + 2_000);
    expect(await worker.sessionAllowed(assigned)).toBe(false);
    expect(await worker.workAllowed(assigned)).toBe(false);
    expect(await worker.status()).toMatchObject({ state: "stale", code: "HUB_UNAVAILABLE" });
  });

  it("is refreshed by a 304, which counts as a successful Hub contact", async () => {
    const fetchConfig = ok(configured());
    const { api, worker } = await start(fetchConfig);
    fetchConfig.mockResolvedValue({ status: 304 } as never);
    vi.useFakeTimers({ now: Date.now() + 170_000 });
    await api.refresh();
    vi.setSystemTime(Date.now() + 170_000);
    expect(await worker.workAllowed(assigned)).toBe(true);
  });

  it("re-asks Hub for a sign-in once the reused answer is older than five seconds", async () => {
    const fetchConfig = ok(configured());
    const { api } = await start(fetchConfig);
    await api.check();
    const calls = fetchConfig.mock.calls.length;
    await api.check();
    expect(fetchConfig).toHaveBeenCalledTimes(calls);
    vi.useFakeTimers({ now: Date.now() + 5_001 });
    await api.check();
    expect(fetchConfig).toHaveBeenCalledTimes(calls + 1);
  });
});

describe("Hub not configured (F1)", () => {
  const missing = ["HUB_AUTH_TENANT_ID", "HUB_SERVICE_SECRET_FILE"];
  const policy = notConfiguredHubPolicy({ missing });

  it("refuses every sign-in with HUB_NOT_CONFIGURED", async () => {
    expect(await codeOf(policy.check())).toBe("HUB_NOT_CONFIGURED");
    expect(await codeOf(policy.admit(assigned))).toBe("HUB_NOT_CONFIGURED");
  });

  it("admits no session and no work", async () => {
    expect(await policy.sessionAllowed(assigned)).toBe(false);
    expect(await policy.workAllowed(assigned)).toBe(false);
  });

  it("reports degraded status naming only the missing settings", async () => {
    expect(await policy.status()).toMatchObject({
      state: "not_configured",
      code: "HUB_NOT_CONFIGURED",
      missing,
      hubRevision: null,
      appliedRevision: null,
      assignments: "pending",
      toolkits: "unknown",
    });
  });
});

describe("Hub policy disabled (CAAH-83)", () => {
  it("admits sign-in, sessions and work without contacting Hub", async () => {
    const policy = disabledHubPolicy({});
    const identity = { tenant: "any-tenant", subject: "user-1" };
    expect(await codeOf(policy.check())).toBe("admitted");
    expect(await policy.admit(identity)).toBe("assigned");
    expect(await policy.sessionAllowed(identity)).toBe(true);
    expect(await policy.workAllowed(identity)).toBe(true);
    expect(await policy.needsRestart()).toBeNull();
  });

  it("still honours an optional tenant pin", async () => {
    const policy = disabledHubPolicy({ tenantId: TENANT });
    const other = { tenant: "tenant-b", subject: "subject-1" };
    expect(await codeOf(policy.admit(other))).toBe("HUB_ACCESS_DENIED");
    expect(await policy.sessionAllowed(other)).toBe(false);
    expect(await policy.workAllowed(other)).toBe(false);
    expect(await policy.admit(assigned)).toBe("assigned");
    expect(await policy.workAllowed(assigned)).toBe(true);
  });

  it("reports disabled", async () => {
    expect(await disabledHubPolicy({ tenantId: TENANT }).status()).toEqual({
      state: "disabled",
      code: null,
      tenant: TENANT,
      hubRevision: null,
      appliedRevision: null,
      fetchedAt: null,
      checkedAt: null,
      source: null,
      assignments: "pending",
      toolkits: "unknown",
    });
  });
});

describe("overrides digest (F10)", () => {
  const document = { overrides: { "model.credentials.anthropic": "hub-model-secret-not-real" } };

  it("is an HMAC under a server-side key, not a plain hash of the values", () => {
    const plain = createHash("sha256")
      .update(JSON.stringify([["model.credentials.anthropic", "hub-model-secret-not-real"]]))
      .digest("hex");
    const keyed = hubPolicyDigest(document, "offline-key-a-not-real");
    expect(keyed).not.toBe(plain);
    expect(keyed).toBe(hubPolicyDigest(document, "offline-key-a-not-real"));
    expect(keyed).not.toBe(hubPolicyDigest(document, "offline-key-b-not-real"));
  });

  it("stores the keyed digest, which the worker reproduces from the same store", async () => {
    const store = memoryHubPolicyStore("offline-key-a-not-real");
    const { api, worker } = await start(ok(configured()), store);
    const record = await store.read(TENANT);
    expect(record?.digest).toBe(hubPolicyDigest(record!.document, "offline-key-a-not-real"));
    expect(await api.workAllowed(assigned)).toBe(true);
    expect(await worker.workAllowed(assigned)).toBe(true);
  });
});

describe("negative authorization", () => {
  it("refuses an identity from another tenant", async () => {
    const { api, worker } = await start(ok(configured()));
    const foreign = { tenant: "tenant-b", subject: "subject-1" };
    expect(await codeOf(api.admit(foreign))).toBe("HUB_ACCESS_DENIED");
    expect(await worker.sessionAllowed(foreign)).toBe(false);
    expect(await worker.workAllowed(foreign)).toBe(false);
  });

  it("grants nothing before Hub has ever delivered a policy", async () => {
    const { api, worker } = await start(
      vi.fn<HubConfigFetch>(async () => Promise.reject(dnsFailure())),
    );
    expect(await codeOf(api.admit(assigned))).toBe("HUB_UNAVAILABLE");
    expect(await api.sessionAllowed(assigned)).toBe(false);
    expect(await worker.workAllowed(assigned)).toBe(false);
    expect((await worker.status()).state).toBe("unavailable");
  });

  it("a worker without Hub access never fetches and never admits sign-in", async () => {
    const { worker } = await start(ok(configured()));
    expect(await codeOf(worker.check())).toBe("HUB_UNAVAILABLE");
  });

  it("an invalid first document grants nothing", async () => {
    const { api, worker } = await start(ok({ ...configured(), product: "other" }));
    expect(await codeOf(api.check())).toBe("HUB_CONFIG_INVALID");
    expect(await worker.workAllowed(assigned)).toBe(false);
  });
});

describe("API and worker revision", () => {
  it("apply the same stored revision at startup", async () => {
    const { apiApplied, workerApplied, apiEnv, workerEnv, api, worker } = await start(
      ok(configured()),
    );
    expect(apiApplied.revision).toBe(7);
    expect(workerApplied).toEqual(apiApplied);
    expect(apiEnv.PI_DEFAULT_PROVIDER).toBe("anthropic");
    expect(workerEnv.PI_DEFAULT_PROVIDER).toBe("anthropic");
    expect(hubManagedDeploymentSettings()).toMatchObject({ defaultModelProvider: "anthropic" });
    expect(await api.status()).toMatchObject({ state: "ok", hubRevision: 7, appliedRevision: 7 });
    expect(await worker.status()).toMatchObject({
      state: "ok",
      hubRevision: 7,
      appliedRevision: 7,
    });
  });

  it("stop new work in both until both restart when Hub changes a startup-bound setting", async () => {
    const fetchConfig = ok(configured());
    const { api, worker, store, signals } = await start(fetchConfig);
    const changed = configured();
    changed.revision = 8;
    changed.overrides.model.defaultProvider = "openrouter";
    fetchConfig.mockResolvedValue({ status: 200, body: changed, etag: '"etag-8"' });
    vi.useFakeTimers({ now: Date.now() + 10_000 });
    expect(await codeOf(api.check())).toBe("HUB_CONFIG_RESTART_REQUIRED");
    expect(await worker.workAllowed(assigned)).toBe(false);
    expect(await worker.sessionAllowed(assigned)).toBe(false);
    expect(await worker.status()).toMatchObject({
      state: "restart_required",
      hubRevision: 8,
      appliedRevision: 7,
    });
    expect(signals).toContainEqual({
      event: "hub_policy_restart_required",
      appliedRevision: 7,
      hubRevision: 8,
    });
    const restarted = await start(fetchConfig, store);
    expect(restarted.apiApplied).toEqual(restarted.workerApplied);
    expect(restarted.apiApplied.revision).toBe(8);
    expect(await restarted.worker.workAllowed(assigned)).toBe(true);
    expect(restarted.workerEnv.PI_DEFAULT_PROVIDER).toBe("openrouter");
  });

  it("do not need a restart when only toolkits or assignments change", async () => {
    const fetchConfig = ok(configured());
    const { api, worker, store } = await start(fetchConfig);
    const changed = configured();
    changed.composio.productAccess.allowedToolkitIds = [];
    changed.access.productAssignments = [changed.access.productAssignments[1]!];
    fetchConfig.mockResolvedValue({ status: 200, body: changed, etag: '"etag-7b"' });
    vi.useFakeTimers({ now: Date.now() + 10_000 });
    await api.check();
    expect((await store.read(TENANT))?.document?.toolkits.allowed).toEqual([]);
    // Policy reduction: subject-1 lost its assignment, so new work stops in both processes.
    expect(await worker.workAllowed(assigned)).toBe(false);
    expect(await worker.workAllowed({ tenant: TENANT, subject: "subject-2" })).toBe(true);
  });

  it("uses last-known-good at startup when Hub is down", async () => {
    const store = memoryHubPolicyStore();
    await start(ok(configured()), store);
    const down = vi.fn<HubConfigFetch>(async () => Promise.reject(timeout()));
    const { apiApplied, apiEnv, api } = await start(down, store);
    expect(apiApplied.revision).toBe(7);
    expect(apiEnv.PI_DEFAULT_PROVIDER).toBe("anthropic");
    expect(await codeOf(api.check())).toBe("HUB_UNAVAILABLE");
  });
});

describe("status", () => {
  it("is deterministic and never carries setting values", async () => {
    const { api } = await start(ok(configured()));
    const status = await api.status();
    expect(Object.keys(status).sort()).toEqual([
      "appliedRevision",
      "assignments",
      "checkedAt",
      "code",
      "fetchedAt",
      "hubRevision",
      "source",
      "state",
      "tenant",
      "toolkits",
    ]);
    expect(JSON.stringify(status)).not.toMatch(/secret|anthropic|github|subject-/);
  });
});
