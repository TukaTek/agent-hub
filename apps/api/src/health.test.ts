import { InfisicalSecretStore } from "@cortexai-agent-hub/adapters";
import { describe, expect, it } from "vitest";
import { infisicalFake } from "../../../packages/adapters/src/secret-store-fake.js";
import { healthRoutes, hubPolicyHealth } from "./health.js";

const app = healthRoutes(() => ({ runtime: "pi", sandbox: "docker", revision: "abc123" }));

describe("health routes", () => {
  it("reports degraded readiness during a store outage and recovers on later reads", async () => {
    const fake = infisicalFake();
    const writer = new InfisicalSecretStore(fake.options);
    const record = await writer.put("fake", {
      operationId: "test",
      traceId: "test",
      userId: "test",
      spaceId: "test",
      signal: new AbortController().signal,
    });
    await writer.close();
    fake.offline = true;
    const store = new InfisicalSecretStore(fake.options);
    await store.start();
    const health = healthRoutes(() => ({ degraded: store.describe().capabilities.degraded }));
    try {
      const response = await health.request("/ready");
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ ok: false, degraded: true });
      expect((await health.request("/health")).status).toBe(200);
      fake.offline = false;
      await store.load(record.ref, record.id);
      expect((await health.request("/ready")).status).toBe(200);
    } finally {
      await store.close();
    }
  });
  it("keeps public liveness free of deployment details", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("serves details to direct requests on the API port", async () => {
    const response = await app.request("/internal/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      runtime: "pi",
      sandbox: "docker",
      revision: "abc123",
    });
  });

  it("hides details from requests that came through a reverse proxy", async () => {
    for (const headers of [
      { "x-forwarded-for": "203.0.113.7" },
      { forwarded: "for=203.0.113.7;proto=https" },
    ]) {
      const response = await app.request("/internal/health", { headers });
      expect(response.status).toBe(404);
    }
  });

  it("keeps liveness up but reports degraded when Hub mode is not configured", async () => {
    const status = {
      state: "not_configured",
      code: "HUB_NOT_CONFIGURED",
      missing: ["HUB_AUTH_TENANT_ID"],
    } as const;
    const degraded = healthRoutes(() => hubPolicyHealth(status));
    expect(await (await degraded.request("/health")).json()).toEqual({ ok: true });
    expect(await (await degraded.request("/internal/health")).json()).toEqual({
      ok: true,
      status: "degraded",
      hubPolicy: status,
    });
  });

  it("reports ok only while Hub policy is ok, and nothing without Hub", () => {
    expect(hubPolicyHealth({ state: "ok" })).toEqual({ status: "ok", hubPolicy: { state: "ok" } });
    for (const state of ["unavailable", "invalid", "stale", "restart_required", "missing"])
      expect(hubPolicyHealth({ state }).status).toBe("degraded");
    expect(hubPolicyHealth(null)).toEqual({ status: "ok", hubPolicy: null });
  });

  it("reports ok with the disabled policy visible (CAAH-83)", () => {
    expect(hubPolicyHealth({ state: "disabled" })).toEqual({
      status: "ok",
      hubPolicy: { state: "disabled" },
    });
  });
});
