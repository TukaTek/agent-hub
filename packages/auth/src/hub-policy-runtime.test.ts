import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/agent-hub-service-config.v1.json" with { type: "json" };
import type { HubConfigFetch } from "./hub-policy.js";
import {
  hubNotConfiguredLogEntry,
  hubPolicyAutoRestart,
  hubPolicyDisabledLogEntry,
  hubPolicyLogEntry,
  startHubPolicyRuntime,
} from "./hub-policy-runtime.js";
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

describe("restart on a startup-bound change (F3)", () => {
  const withProvider = (provider: string, revision: number) => {
    const body = configured();
    body.revision = revision;
    body.overrides.model.defaultProvider = provider;
    return body;
  };
  const changed = withProvider("openrouter", 8);

  async function api(store = memoryHubPolicyStore(), minUptimeMs = 60_000) {
    let body: unknown = configured();
    const onRestartRequired = vi.fn();
    const runtime = await startHubPolicyRuntime({
      store,
      tenantId: TENANT,
      env: {},
      fetchConfig: async () => ({ status: 200, body }),
      log: quiet,
      pollMs: 60_000,
      minUptimeMs,
      onRestartRequired,
    });
    return {
      runtime,
      store,
      onRestartRequired,
      serve: (next: unknown) => {
        body = next;
      },
    };
  }

  it("asks the process to exit once, after the next poll sees the new revision", async () => {
    vi.useFakeTimers();
    const f = await api();
    f.serve(changed);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(f.onRestartRequired).toHaveBeenCalledExactlyOnceWith({
      appliedRevision: 7,
      hubRevision: 8,
    });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.onRestartRequired).toHaveBeenCalledTimes(1);
    f.runtime.stop();
  });

  it("waits for the minimum uptime before exiting, so a flapping Hub cannot crash-loop", async () => {
    vi.useFakeTimers();
    const f = await api(memoryHubPolicyStore(), 300_000);
    f.serve(changed);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.onRestartRequired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(240_000);
    expect(f.onRestartRequired).toHaveBeenCalledTimes(1);
    f.runtime.stop();
  });

  it("does not exit when Hub flips back to the applied revision before the deadline", async () => {
    vi.useFakeTimers();
    const f = await api(memoryHubPolicyStore(), 300_000);
    f.serve(changed);
    await vi.advanceTimersByTimeAsync(60_000);
    f.serve(withProvider("anthropic", 9));
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.onRestartRequired).not.toHaveBeenCalled();
    f.runtime.stop();
  });

  it("does not exit for a revision that changes only assignments or toolkits", async () => {
    vi.useFakeTimers();
    const f = await api();
    const body = configured();
    body.revision = 8;
    body.access.productAssignments = body.access.productAssignments.slice(0, 1);
    f.serve(body);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(f.onRestartRequired).not.toHaveBeenCalled();
    f.runtime.stop();
  });

  it("restarts the worker too, from the revision the API stored", async () => {
    vi.useFakeTimers();
    const f = await api();
    const onRestartRequired = vi.fn();
    const worker = await startHubPolicyRuntime({
      store: f.store,
      tenantId: TENANT,
      env: {},
      log: quiet,
      pollMs: 15_000,
      minUptimeMs: 60_000,
      onRestartRequired,
    });
    f.serve(changed);
    await vi.advanceTimersByTimeAsync(75_000);
    expect(onRestartRequired).toHaveBeenCalledExactlyOnceWith({
      appliedRevision: 7,
      hubRevision: 8,
    });
    f.runtime.stop();
    worker.stop();
  });

  it("starts cleanly after the exit: the new process applies the new revision and stays up", async () => {
    vi.useFakeTimers();
    const f = await api();
    f.serve(changed);
    await vi.advanceTimersByTimeAsync(60_000);
    f.runtime.stop();
    const onRestartRequired = vi.fn();
    const env: NodeJS.ProcessEnv = {};
    const restarted = await startHubPolicyRuntime({
      store: f.store,
      tenantId: TENANT,
      env,
      fetchConfig: async () => ({ status: 200, body: changed }),
      log: quiet,
      onRestartRequired,
    });
    expect(restarted.applied.revision).toBe(8);
    expect(env.PI_DEFAULT_PROVIDER).toBe("openrouter");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(onRestartRequired).not.toHaveBeenCalled();
    expect(await restarted.policy.workAllowed(assigned)).toBe(true);
    restarted.stop();
  });
});

describe("restart and not-configured settings", () => {
  it("restarts automatically unless HUB_POLICY_AUTO_RESTART is false", () => {
    expect(hubPolicyAutoRestart({})).toBe(true);
    expect(hubPolicyAutoRestart({ HUB_POLICY_AUTO_RESTART: "true" })).toBe(true);
    expect(hubPolicyAutoRestart({ HUB_POLICY_AUTO_RESTART: "false" })).toBe(false);
    expect(() => hubPolicyAutoRestart({ HUB_POLICY_AUTO_RESTART: "no" })).toThrow(
      "docs/hub-auth.md#configuring-hub-mode",
    );
  });

  it("names each missing setting and the runbook in the not-configured log line", () => {
    const entry = hubNotConfiguredLogEntry([
      { name: "HUB_AUTH_TENANT_ID", problem: "unset" },
      { name: "HUB_SERVICE_SECRET_FILE", problem: "unreadable" },
    ]);
    expect(entry.message).toBe(
      "Hub mode is not configured: HUB_AUTH_TENANT_ID is unset, HUB_SERVICE_SECRET_FILE is " +
        "unreadable. Every sign-in is refused with HUB_NOT_CONFIGURED and no work runs until " +
        "this is fixed and the process restarts. See docs/hub-auth.md#configuring-hub-mode",
    );
    expect(entry.attributes["hub.missing"]).toBe("HUB_AUTH_TENANT_ID,HUB_SERVICE_SECRET_FILE");
  });

  it("warns that Hub policy is off, linking the runbook (CAAH-83)", () => {
    const doc = "docs/hub-auth.md#running-without-hub-registration";
    const entry = hubPolicyDisabledLogEntry();
    expect(entry.message).toContain("HUB_POLICY_ENFORCEMENT=off");
    expect(entry.message).toContain(doc);
    expect(entry.attributes).toEqual({ "hub.policy": "disabled", "hub.doc": doc });
  });
});
