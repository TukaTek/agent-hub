import { describe, expect, it } from "vitest";
import { mapHubOwner } from "./provisioning.js";

// No database call may happen for a refused mapping.
const prisma = new Proxy(
  {},
  {
    get: () => {
      throw new Error("database touched");
    },
  },
) as never;
const base = {
  hubOrigin: "https://hub.example.test",
  hubTenant: "tenant-a",
  hubUserId: "tu-1",
  transfer: false,
};

describe("mapHubOwner tenant check (CAAH-43 M1)", () => {
  it("refuses without the deployment's HUB_AUTH_TENANT_ID and changes nothing", async () => {
    for (const configuredTenant of ["", "  ", undefined as unknown as string]) {
      await expect(mapHubOwner(prisma, { ...base, configuredTenant })).rejects.toMatchObject({
        code: "NOT_CONFIGURED",
        message: expect.stringContaining("set HUB_AUTH_TENANT_ID first"),
      });
    }
  });

  it("refuses a --hub-tenant that differs from HUB_AUTH_TENANT_ID", async () => {
    await expect(
      mapHubOwner(prisma, { ...base, configuredTenant: "tenant-b" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
