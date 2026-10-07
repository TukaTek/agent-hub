import { notConfiguredHubPolicy } from "@cortexai-agent-hub/auth";
import { describe, expect, it, vi } from "vitest";
import { startApiHubPolicy } from "./hub-policy.js";

const hub = { AUTH_MODE: "hub", HUB_AUTH_ORIGIN: "https://hub.example.test" };

describe("API Hub policy startup", () => {
  it("does nothing in local mode", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect(await startApiHubPolicy({ AUTH_MODE: "local" }, logger)).toBeUndefined();
  });

  it("starts not configured without the tenant or service credential, naming what is missing", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    // No DATABASE_URL either: a not-configured process never opens a policy pool.
    const runtime = await startApiHubPolicy({ ...hub }, logger);
    expect(runtime).toBeDefined();
    expect(await runtime!.policy.status()).toMatchObject({
      state: "not_configured",
      code: "HUB_NOT_CONFIGURED",
      missing: ["HUB_AUTH_TENANT_ID", "HUB_SERVICE_API_ID", "HUB_SERVICE_SECRET_FILE"],
    });
    await expect(runtime!.policy.check()).rejects.toMatchObject({ code: "HUB_NOT_CONFIGURED" });
    expect(logger.error).toHaveBeenCalledOnce();
    const [message, attributes] = logger.error.mock.calls[0]!;
    expect(message).toContain("HUB_AUTH_TENANT_ID is unset");
    expect(message).toContain("HUB_SERVICE_SECRET_FILE is unset");
    expect(message).toContain("docs/hub-auth.md#configuring-hub-mode");
    expect(attributes).toMatchObject({
      "hub.missing": "HUB_AUTH_TENANT_ID,HUB_SERVICE_API_ID,HUB_SERVICE_SECRET_FILE",
      "hub.doc": "docs/hub-auth.md#configuring-hub-mode",
    });
    await runtime!.close();
  });

  it("never logs the secret file path or contents when the file cannot be read", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runtime = await startApiHubPolicy(
      {
        ...hub,
        HUB_AUTH_TENANT_ID: "tenant-1",
        HUB_SERVICE_API_ID: "api-id-1",
        HUB_SERVICE_SECRET_FILE: "/nonexistent/synthetic-secret-path",
      },
      logger,
    );
    expect((await runtime!.policy.status()).missing).toEqual(["HUB_SERVICE_SECRET_FILE"]);
    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).toContain("HUB_SERVICE_SECRET_FILE is unreadable");
    expect(logged).not.toContain("synthetic-secret-path");
    await runtime!.close();
  });

  it("starts with policy off: warns once, opens no pool and never contacts Hub (CAAH-83)", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      // No DATABASE_URL: a process with policy off never opens a policy pool.
      const runtime = await startApiHubPolicy({ ...hub, HUB_POLICY_ENFORCEMENT: "off" }, logger);
      expect((await runtime!.policy.status()).state).toBe("disabled");
      await expect(runtime!.policy.check()).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledOnce();
      expect(logger.warn.mock.calls[0]![0]).toContain("HUB_POLICY_ENFORCEMENT=off");
      expect(logger.error).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      await runtime!.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses to start with policy off and SSO on (CAAH-83)", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await expect(
      startApiHubPolicy({ ...hub, HUB_POLICY_ENFORCEMENT: "off", HUB_SSO_ENABLED: "true" }, logger),
    ).rejects.toThrow("HUB_SSO_ENABLED=true requires HUB_POLICY_ENFORCEMENT=on");
  });

  it("refuses to start with an unknown HUB_POLICY_ENFORCEMENT (CAAH-83)", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await expect(
      startApiHubPolicy({ ...hub, HUB_POLICY_ENFORCEMENT: "false" }, logger),
    ).rejects.toThrow("HUB_POLICY_ENFORCEMENT must be on or off");
  });

  it("shares the not-configured policy shape with the auth package", async () => {
    const policy = notConfiguredHubPolicy({ missing: ["HUB_AUTH_TENANT_ID"] });
    expect(await policy.workAllowed({ tenant: "t", subject: "s" })).toBe(false);
  });
});
