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

  it("shares the not-configured policy shape with the auth package", async () => {
    const policy = notConfiguredHubPolicy({ missing: ["HUB_AUTH_TENANT_ID"] });
    expect(await policy.workAllowed({ tenant: "t", subject: "s" })).toBe(false);
  });
});
