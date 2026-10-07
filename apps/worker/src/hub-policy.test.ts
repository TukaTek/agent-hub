import type { PrismaClient } from "@cortexai-agent-hub/db";
import { describe, expect, it, vi } from "vitest";
import { startWorkerHubPolicy } from "./hub-policy.js";

const hub = { AUTH_MODE: "hub", HUB_AUTH_ORIGIN: "https://hub.example.test" };
// The local, not-configured and disabled branches never touch the database.
const prisma = {} as PrismaClient;
const identity = { tenant: "tenant-1", subject: "subject-1" };
const quietLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe("worker Hub policy startup", () => {
  it("does nothing in local mode", async () => {
    expect(await startWorkerHubPolicy({ AUTH_MODE: "local" }, quietLogger(), prisma)).toEqual({
      config: undefined,
      policy: undefined,
    });
  });

  it("runs work with policy off and no Hub values, warning once (CAAH-83)", async () => {
    const logger = quietLogger();
    const { config, policy } = await startWorkerHubPolicy(
      { ...hub, HUB_POLICY_ENFORCEMENT: "off" },
      logger,
      prisma,
    );
    expect(config).toEqual({ origin: hub.HUB_AUTH_ORIGIN, policyDisabled: true });
    expect((await policy!.status()).state).toBe("disabled");
    expect(await policy!.workAllowed(identity)).toBe(true);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0]![0]).toContain("HUB_POLICY_ENFORCEMENT=off");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("stays locked with policy on and no Hub values (F1)", async () => {
    const logger = quietLogger();
    const { policy } = await startWorkerHubPolicy({ ...hub }, logger, prisma);
    expect((await policy!.status()).state).toBe("not_configured");
    expect(await policy!.workAllowed(identity)).toBe(false);
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0]![0]).toContain("HUB_AUTH_TENANT_ID is unset");
  });

  it("refuses to start with policy off and SSO on (CAAH-83)", async () => {
    await expect(
      startWorkerHubPolicy(
        { ...hub, HUB_POLICY_ENFORCEMENT: "off", HUB_SSO_ENABLED: "true" },
        quietLogger(),
        prisma,
      ),
    ).rejects.toThrow("HUB_SSO_ENABLED=true requires HUB_POLICY_ENFORCEMENT=on");
  });
});
