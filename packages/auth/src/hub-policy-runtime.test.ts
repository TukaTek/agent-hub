import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/agent-hub-service-config.v1.json" with { type: "json" };
import type { HubConfigFetch } from "./hub-policy.js";
import { hubPolicyLogEntry, startHubPolicyRuntime } from "./hub-policy-runtime.js";
import { memoryHubPolicyStore } from "./hub-policy-store.js";

const TENANT = "tenant-a";
const assigned = { tenant: TENANT, subject: "subject-1" };
const configured = () => structuredClone(fixture.cases.configured);
const quiet = () => undefined;

afterEach(() => vi.useRealTimers());

describe("Hub policy runtime for the API and the worker", () => {
  it("applies Hub's revision to the API environment at startup and keeps polling Hub", async () => {
    vi.useFakeTimers();
    const fetchConfig = vi.fn<HubConfigFetch>(async () => ({ status: 200, body: configured() }));
    const env: NodeJS.ProcessEnv = { PI_DEFAULT_PROVIDER: "openrouter" };
    const api = await startHubPolicyRuntime({
      store: memoryHubPolicyStore(),
      tenantId: TENANT,
      env,
      fetchConfig,
      log: quiet,
      pollMs: 60_000,
    });
    expect(env.PI_DEFAULT_PROVIDER).toBe("anthropic");
    expect(api.applied.revision).toBe(7);
    expect(fetchConfig).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchConfig).toHaveBeenCalledTimes(2);
    api.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchConfig).toHaveBeenCalledTimes(2);
  });

  it("starts the worker on the revision the API stored, waiting for the first one", async () => {
    vi.useFakeTimers();
    const store = memoryHubPolicyStore();
    const workerEnv: NodeJS.ProcessEnv = { PI_DEFAULT_PROVIDER: "openrouter" };
    const workerStarting = startHubPolicyRuntime({
      store,
      tenantId: TENANT,
      env: workerEnv,
      log: quiet,
      waitForSnapshotMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(4_000);
    const api = await startHubPolicyRuntime({
      store,
      tenantId: TENANT,
      env: {},
      fetchConfig: async () => ({ status: 200, body: configured() }),
      log: quiet,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const worker = await workerStarting;
    expect(worker.applied).toEqual(api.applied);
    expect(workerEnv.PI_DEFAULT_PROVIDER).toBe("anthropic");
    expect((await worker.policy.status()).hubRevision).toBe(7);
    expect(await worker.policy.workAllowed(assigned)).toBe(true);
    api.stop();
    worker.stop();
  });

  it("starts a worker with nothing applied when no revision arrives, and refuses work", async () => {
    vi.useFakeTimers();
    const env: NodeJS.ProcessEnv = { PI_DEFAULT_PROVIDER: "openrouter" };
    const starting = startHubPolicyRuntime({
      store: memoryHubPolicyStore(),
      tenantId: TENANT,
      env,
      log: quiet,
      waitForSnapshotMs: 10_000,
    });
    await vi.advanceTimersByTimeAsync(12_000);
    const worker = await starting;
    expect(worker.applied.revision).toBeNull();
    expect(env.PI_DEFAULT_PROVIDER).toBe("openrouter");
    expect(await worker.policy.workAllowed(assigned)).toBe(false);
    await expect(worker.policy.check()).rejects.toMatchObject({ code: "HUB_UNAVAILABLE" });
  });
});

describe("Hub policy log attributes", () => {
  it("logs an override as the key, Hub revision and overridden source, never the value", () => {
    expect(
      hubPolicyLogEntry({
        event: "hub_policy_override",
        key: "model.credentials.anthropic",
        hubRevision: 7,
        overriddenSource: "env:ANTHROPIC_API_KEY",
      }),
    ).toEqual({
      level: "info",
      message: "hub_policy_override",
      attributes: {
        "hub.policy.event": "hub_policy_override",
        "hub.policy.key": "model.credentials.anthropic",
        "hub.policy.hub_revision": 7,
        "hub.policy.overridden_source": "env:ANTHROPIC_API_KEY",
      },
    });
  });

  it("warns on rollback, refresh failure, unknown assignments and restart", () => {
    for (const signal of [
      { event: "hub_policy_rollback", fromRevision: 7, toRevision: 5 },
      { event: "hub_policy_refresh_failed", code: "HUB_UNAVAILABLE", reason: "unreachable" },
      { event: "hub_policy_assignments_unknown", hubRevision: 3, kept: "none" },
      { event: "hub_policy_restart_required", appliedRevision: 2, hubRevision: 3 },
    ] as const)
      expect(hubPolicyLogEntry(signal).level).toBe("warn");
  });
});
