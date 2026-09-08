import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/agent-hub-auth.v2.json" with { type: "json" };
import { createHubClient, hubAuthFromEnv, hubUserId } from "./hub-client.js";

const origin = "https://hub.example.test";
function setup(overrides: Record<string, unknown> = {}) {
  const replies: Record<string, unknown> = {
    lookup: { tenantId: "fixture-tenant", idpType: "native" },
    login: fixture.sessionResponse,
    refresh: fixture.sessionResponse,
    session: { valid: true, userId: "fixture-user", tenantId: "fixture-tenant" },
    config: {
      product: "cortexai-agent-hub",
      products: fixture.sessionResponse.products,
      apiKey: "do-not-expose",
    },
    revoke: { success: true },
    ...overrides,
  };
  const fetcher = vi.fn(async (url: any, options: any) => {
    expect(new URL(String(url)).origin).toBe(origin);
    expect(options.redirect).toBe("error");
    const value = replies[new URL(String(url)).pathname.split("/").at(-1)!];
    return value instanceof Response ? value : Response.json(value);
  });
  return { client: createHubClient({ origin }, fetcher), fetcher };
}
describe("Hub Workbench-style tenant authentication", () => {
  it("discovers tenant and consumes opaque tokens without OAuth client setup", async () => {
    const { client, fetcher } = setup();
    const grant = await client.login("user@example.test", "synthetic-password");
    expect(grant).toMatchObject({
      subject: "fixture-user",
      tenant: "fixture-tenant",
      accessToken: fixture.sessionResponse.accessToken,
    });
    expect(JSON.stringify(grant)).not.toContain("do-not-expose");
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/api/tenant-auth/lookup",
      "/api/tenant-auth/login",
      "/api/tenant-auth/session",
      "/api/tenant-auth/config",
    ]);
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
      email: "user@example.test",
      password: "synthetic-password",
    });
  });
  it.each([
    { lookup: { tenantId: "another-tenant", idpType: "native" } },
    { lookup: { tenantId: "fixture-tenant", idpType: "oidc" } },
    { login: { ...fixture.sessionResponse, products: [] } },
    { login: { ...fixture.sessionResponse, accessTokenExpiresAt: "2000-01-01" } },
    { login: { ...fixture.sessionResponse, refreshToken: "" } },
    { session: { valid: true, userId: "another-user", tenantId: "fixture-tenant" } },
    { config: { product: "cortexai-agent-hub", products: [] } },
    { config: new Response("denied", { status: 403 }) },
  ])("fails closed for invalid identity or entitlement: %j", async (overrides) => {
    await expect(setup(overrides).client.login("user@example.test", "password")).rejects.toThrow();
  });
  it("refreshes and revokes using native endpoints", async () => {
    const { client, fetcher } = setup();
    await expect(client.refresh("old-refresh")).resolves.toMatchObject({
      refreshToken: fixture.sessionResponse.refreshToken,
    });
    await client.revoke("saved-refresh");
    expect(fetcher.mock.calls.at(-1)![1].body).toBe(
      JSON.stringify({ refreshToken: "saved-refresh" }),
    );
  });
  it("revalidates current entitlement on each verification", async () => {
    const { client, fetcher } = setup();
    const identity = { subject: "fixture-user", tenant: "fixture-tenant" };
    await client.verify("opaque", identity);
    fetcher.mockResolvedValueOnce(
      Response.json({ valid: true, userId: identity.subject, tenantId: identity.tenant }),
    );
    fetcher.mockResolvedValueOnce(new Response("denied", { status: 403 }));
    await expect(client.verify("opaque", identity)).rejects.toThrow();
  });
  it("requires a configured trusted HTTPS origin with optional tenant restriction", async () => {
    expect(hubAuthFromEnv({ AUTH_MODE: "hub", HUB_AUTH_ORIGIN: origin })).toEqual({ origin });
    expect(hubAuthFromEnv({})).toBeUndefined();
    expect(() =>
      hubAuthFromEnv({ AUTH_MODE: "hub", HUB_AUTH_ORIGIN: "http://hub.example.test" }),
    ).toThrow();
    const f = setup();
    await expect(
      createHubClient({ origin, tenantId: "other" }, f.fetcher).login(
        "user@example.test",
        "password",
      ),
    ).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps ownership stable across transport changes and distinct across tenants", () => {
    expect(hubUserId(origin, "tenant", "user")).toBe(hubUserId(origin, "tenant", "user"));
    expect(hubUserId(origin, "other", "user")).not.toBe(hubUserId(origin, "tenant", "user"));
  });
});
