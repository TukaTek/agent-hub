import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/agent-hub-auth.v2.json" with { type: "json" };
import web from "./fixtures/agent-hub-web-sso.v1.json" with { type: "json" };
import {
  createHubClient,
  HubRequestError,
  HubUnsupportedIdpError,
  hubAuthFromEnv,
  hubUserId,
} from "./hub-client.js";

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
  it("looks up the sign-in method without calling login", async () => {
    const native = setup();
    await expect(native.client.lookup(" user@example.test ")).resolves.toEqual({
      tenant: "fixture-tenant",
      idpType: "native",
    });
    expect(native.fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(native.fetcher.mock.calls[0]![1].body)).toEqual({
      email: "user@example.test",
    });
    const entra = setup({ lookup: { tenantId: "fixture-tenant", idpType: "entra" } });
    await expect(entra.client.lookup("user@example.test")).resolves.toEqual({
      tenant: "fixture-tenant",
      idpType: "entra",
    });
    await expect(entra.client.login("user@example.test", "password")).rejects.toThrow(
      HubUnsupportedIdpError,
    );
    const google = setup({ lookup: { tenantId: "fixture-tenant", idpType: "google" } });
    await expect(google.client.lookup("user@example.test")).resolves.toEqual({
      tenant: "fixture-tenant",
      idpType: "google",
    });
    const invalid = setup({ lookup: { tenantId: "fixture-tenant" } });
    await expect(invalid.client.lookup("user@example.test")).rejects.toThrow(
      "Invalid Hub response",
    );
    const pinned = createHubClient({ origin, tenantId: "other" }, setup().fetcher);
    await expect(pinned.lookup("user@example.test")).rejects.toThrow();
    const unknown = setup({ lookup: new Response("not found", { status: 404 }) });
    await expect(unknown.client.lookup("missing@example.test")).rejects.toThrow();
  });
  describe("Entra tenant with Hub's per-user Always Native override", () => {
    const tenantLookup = {
      tenantId: "fixture-tenant",
      tenantName: "Fixture",
      tenantSlug: "fixture",
    };
    it("signs an always_native user in with a password", async () => {
      const { client, fetcher } = setup({ lookup: { ...tenantLookup, idpType: "native" } });
      await expect(client.lookup("user@example.test")).resolves.toEqual({
        tenant: "fixture-tenant",
        idpType: "native",
      });
      await expect(client.login("user@example.test", "synthetic-password")).resolves.toMatchObject({
        subject: "fixture-user",
        tenant: "fixture-tenant",
      });
      expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        "/api/tenant-auth/lookup",
        "/api/tenant-auth/lookup",
        "/api/tenant-auth/login",
        "/api/tenant-auth/session",
        "/api/tenant-auth/config",
      ]);
    });
    it("reports other users in the same tenant as not native and never sends a password", async () => {
      const { client, fetcher } = setup({ lookup: { ...tenantLookup, idpType: "entra" } });
      await expect(client.lookup("user@example.test")).resolves.toEqual({
        tenant: "fixture-tenant",
        idpType: "entra",
      });
      await expect(client.login("user@example.test", "synthetic-password")).rejects.toThrow(
        HubUnsupportedIdpError,
      );
      expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).not.toContain(
        "/api/tenant-auth/login",
      );
    });
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

describe("Hub agent-hub-web SSO contract", () => {
  const sso = fixture.sso;
  const config = {
    origin,
    tenantId: web.ssoStartRequest.body.tenantId,
    deploymentId: web.ssoStartRequest.body.deploymentId,
    sso: { apiId: sso.serviceTokenRequest.apiId, secret: sso.serviceTokenRequest.secret },
  };
  function ssoSetup(overrides: Record<string, unknown> = {}) {
    const replies: Record<string, unknown> = {
      "service-token": sso.serviceTokenResponse,
      "sso-start": web.ssoStartResponse,
      "sso-exchange": web.exchangeResponse,
      session: {
        valid: true,
        userId: web.exchangeResponse.user.id,
        tenantId: web.exchangeResponse.tenantId,
      },
      config: { product: "cortexai-agent-hub", products: web.exchangeResponse.products },
      ...overrides,
    };
    const fetcher = vi.fn(async (url: any, options: any) => {
      expect(new URL(String(url)).origin).toBe(origin);
      expect(options.redirect).toBe("error");
      const value = replies[new URL(String(url)).pathname.split("/").at(-1)!];
      return typeof value === "function"
        ? value(options)
        : value instanceof Response
          ? value.clone()
          : Response.json(value);
    });
    const calls = (name: string) =>
      fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith(`/${name}`));
    return { client: createHubClient(config, fetcher), fetcher, calls };
  }
  const redirectUri = new URL(web.exchangeRequest.body.redirectUri).href;

  it("starts with Hub's published request shape and a service bearer", async () => {
    const { client, calls } = ssoSetup();
    const body = web.ssoStartRequest.body;
    await expect(client.ssoStart(body.email, body.state, body.codeChallenge)).resolves.toBe(
      web.ssoStartResponse.authorizeUrl,
    );
    const [tokenUrl, tokenInit] = calls("service-token")[0]!;
    expect(new URL(String(tokenUrl)).pathname).toBe(fixture.endpoints.serviceToken);
    expect(JSON.parse(tokenInit.body)).toEqual(sso.serviceTokenRequest);
    expect(tokenInit.headers.authorization).toBeUndefined();
    const [startUrl, startInit] = calls("sso-start")[0]!;
    expect(new URL(String(startUrl)).pathname).toBe(fixture.endpoints.ssoStart);
    expect(JSON.parse(startInit.body)).toEqual(body);
    expect(startInit.headers.authorization).toBe(`Bearer ${sso.serviceTokenResponse.token}`);
  });

  it("asks the IdP for fresh credentials with the email as login_hint, sending Hub only its fields", async () => {
    const direct =
      "https://login.example.test/tenant/oauth2/v2.0/authorize?client_id=synthetic-client&response_type=code&scope=openid&state=opaque";
    const { client, calls } = ssoSetup({ "sso-start": { authorizeUrl: direct } });
    const body = web.ssoStartRequest.body;
    const url = new URL(await client.ssoStart(`  ${body.email} `, body.state, body.codeChallenge));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "synthetic-client",
      response_type: "code",
      scope: "openid",
      state: "opaque",
      prompt: "login",
      login_hint: body.email,
    });
    expect(url.origin + url.pathname).toBe(direct.split("?")[0]);
    expect(JSON.parse(calls("sso-start")[0]![1].body)).toEqual(body);
  });

  it("overrides a weaker prompt but keeps Hub's own login_hint", async () => {
    const { client } = ssoSetup({
      "sso-start": {
        authorizeUrl:
          "https://login.example.test/authorize?client_id=c&response_type=code&prompt=none&login_hint=hub%40example.test",
      },
    });
    const body = web.ssoStartRequest.body;
    const url = new URL(await client.ssoStart(body.email, body.state, body.codeChallenge));
    expect(url.searchParams.getAll("prompt")).toEqual(["login"]);
    expect(url.searchParams.getAll("login_hint")).toEqual(["hub@example.test"]);
  });

  it("leaves an authorize URL that is not a direct OIDC request unchanged", async () => {
    const { client } = ssoSetup();
    const body = web.ssoStartRequest.body;
    await expect(client.ssoStart(body.email, body.state, body.codeChallenge)).resolves.toBe(
      web.ssoStartResponse.authorizeUrl,
    );
  });

  it("exchanges with Hub's published request shape and returns the native grant", async () => {
    const { client, calls } = ssoSetup();
    const body = web.exchangeRequest.body;
    await expect(client.ssoExchange(body.code, body.codeVerifier, redirectUri)).resolves.toEqual({
      subject: web.exchangeResponse.user.id,
      tenant: web.exchangeResponse.tenantId,
      accessToken: web.exchangeResponse.accessToken,
      refreshToken: web.exchangeResponse.refreshToken,
      accessUntil: new Date(web.exchangeResponse.accessTokenExpiresAt),
      displayName: web.exchangeResponse.user.displayName,
    });
    const [url, init] = calls("sso-exchange")[0]!;
    expect(new URL(String(url)).pathname).toBe(fixture.endpoints.ssoExchange);
    expect(JSON.parse(init.body)).toEqual(body);
    expect(init.headers.authorization).toBe(`Bearer ${sso.serviceTokenResponse.token}`);
    expect(new URL(redirectUri).pathname).toBe(`${web.callbackPath}`);
    expect(sso.callbackPath).toBe(web.callbackPath);
    expect(sso.returnChannel).toBe(web.returnChannel);
    expect(calls("session")).toHaveLength(1);
    expect(calls("config")).toHaveLength(1);
  });

  it.each([
    ["another tenant", { "sso-exchange": { ...web.exchangeResponse, tenantId: "tenant-b" } }],
    [
      "another tenant's user",
      {
        "sso-exchange": {
          ...web.exchangeResponse,
          user: { ...web.exchangeResponse.user, tenantId: "tenant-b" },
        },
      },
    ],
    [
      "another deployment",
      {
        "sso-exchange": {
          ...web.exchangeResponse,
          deploymentId: "22222222-2222-4222-8222-222222222222",
        },
      },
    ],
    ["no deployment", { "sso-exchange": { ...web.exchangeResponse, deploymentId: null } }],
    ["no Agent Hub entitlement", { "sso-exchange": { ...web.exchangeResponse, products: [] } }],
    ["config denial", { config: new Response("denied", { status: 403 }) }],
  ])("rejects an exchange grant for %s", async (_case, overrides) => {
    const body = web.exchangeRequest.body;
    await expect(
      ssoSetup(overrides).client.ssoExchange(body.code, body.codeVerifier, redirectUri),
    ).rejects.toThrow();
  });

  it.each(web.errors.filter((entry) => entry.endpoint === "sso-exchange"))(
    "surfaces exchange $status $error once, never retrying the code",
    async ({ status, error }) => {
      const { client, calls } = ssoSetup({ "sso-exchange": Response.json({ error }, { status }) });
      const body = web.exchangeRequest.body;
      const failure = await client
        .ssoExchange(body.code, body.codeVerifier, redirectUri)
        .catch((caught: unknown) => caught);
      expect(failure).toBeInstanceOf(HubRequestError);
      expect(failure).toMatchObject({ status, code: error });
      expect(calls("sso-exchange")).toHaveLength(1);
    },
  );

  it.each(web.errors.filter((entry) => entry.endpoint === "sso-start"))(
    "surfaces start $status $error without leaking secrets",
    async ({ status, error }) => {
      const { client } = ssoSetup({ "sso-start": Response.json({ error }, { status }) });
      const body = web.ssoStartRequest.body;
      const failure = await client
        .ssoStart(body.email, body.state, body.codeChallenge)
        .catch((caught: unknown) => caught);
      expect(failure).toMatchObject({ status, code: error });
      expect(String(failure)).not.toContain(config.sso.secret);
      expect(String(failure)).not.toContain(body.state);
    },
  );

  it("retries start once with a fresh service token after invalid_service_token", async () => {
    let starts = 0;
    const { client, calls } = ssoSetup({
      "sso-start": () =>
        ++starts === 1
          ? Response.json({ error: "invalid_service_token" }, { status: 401 })
          : Response.json(web.ssoStartResponse),
    });
    const body = web.ssoStartRequest.body;
    await expect(client.ssoStart(body.email, body.state, body.codeChallenge)).resolves.toBe(
      web.ssoStartResponse.authorizeUrl,
    );
    expect(calls("service-token")).toHaveLength(2);
    expect(calls("sso-start")).toHaveLength(2);
  });

  it("drops the cached service token when Hub rejects it at exchange", async () => {
    const { client, calls } = ssoSetup({
      "sso-exchange": Response.json({ error: "invalid_service_token" }, { status: 401 }),
    });
    const body = web.exchangeRequest.body;
    await expect(client.ssoExchange(body.code, body.codeVerifier, redirectUri)).rejects.toThrow();
    await expect(client.ssoExchange(body.code, body.codeVerifier, redirectUri)).rejects.toThrow();
    expect(calls("service-token")).toHaveLength(2);
  });

  it("caches Hub's 300 s service token and renews it 45 s before expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { client, calls } = ssoSetup();
      const body = web.ssoStartRequest.body;
      await Promise.all([
        client.ssoStart(body.email, body.state, body.codeChallenge),
        client.ssoStart(body.email, body.state, body.codeChallenge),
      ]);
      expect(calls("service-token")).toHaveLength(1);
      vi.setSystemTime(Date.now() + 254_000);
      await client.ssoStart(body.email, body.state, body.codeChallenge);
      expect(calls("service-token")).toHaveLength(1);
      vi.setSystemTime(Date.now() + 2_000);
      await Promise.all([
        client.ssoStart(body.email, body.state, body.codeChallenge),
        client.ssoStart(body.email, body.state, body.codeChallenge),
      ]);
      expect(calls("service-token")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews once when concurrent starts are rejected with the same token", async () => {
    let issued = 0;
    const { client, calls } = ssoSetup({
      "service-token": () =>
        Response.json({ ...sso.serviceTokenResponse, token: `synthetic-token-${++issued}` }),
      "sso-start": (init: RequestInit) =>
        (init.headers as Record<string, string>).authorization === "Bearer synthetic-token-1"
          ? Response.json({ error: "invalid_service_token" }, { status: 401 })
          : Response.json(web.ssoStartResponse),
    });
    const body = web.ssoStartRequest.body;
    await expect(
      Promise.all([
        client.ssoStart(body.email, body.state, body.codeChallenge),
        client.ssoStart(body.email, body.state, body.codeChallenge),
      ]),
    ).resolves.toEqual([web.ssoStartResponse.authorizeUrl, web.ssoStartResponse.authorizeUrl]);
    expect(calls("service-token")).toHaveLength(2);
    expect(calls("sso-start")).toHaveLength(4);
  });

  it("keeps a renewed token when a slower request is rejected with the old one", async () => {
    let issued = 0;
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let starts = 0;
    const { client, calls } = ssoSetup({
      "service-token": () =>
        Response.json({ ...sso.serviceTokenResponse, token: `synthetic-token-${++issued}` }),
      "sso-start": async (init: RequestInit) => {
        const call = ++starts;
        if ((init.headers as Record<string, string>).authorization !== "Bearer synthetic-token-1")
          return Response.json(web.ssoStartResponse);
        if (call === 1) await slow;
        return Response.json({ error: "invalid_service_token" }, { status: 401 });
      },
    });
    const body = web.ssoStartRequest.body;
    const slowStart = client.ssoStart(body.email, body.state, body.codeChallenge);
    await vi.waitFor(() => expect(starts).toBe(1));
    await client.ssoStart(body.email, body.state, body.codeChallenge);
    expect(calls("service-token")).toHaveLength(2);
    releaseSlow();
    await expect(slowStart).resolves.toBe(web.ssoStartResponse.authorizeUrl);
    await client.ssoStart(body.email, body.state, body.codeChallenge);
    expect(calls("service-token")).toHaveLength(2);
  });

  it.each([
    [
      "an access_token-style field",
      { accessToken: "synthetic-token", tokenType: "Bearer", expiresIn: 300 },
    ],
    ["snake_case expires_in", { token: "synthetic-token", tokenType: "Bearer", expires_in: 300 }],
    ["another token type", { ...fixture.sso.serviceTokenResponse, tokenType: "DPoP" }],
    ["whitespace in the token", { ...fixture.sso.serviceTokenResponse, token: "synthetic token" }],
    ["an oversized token", { ...fixture.sso.serviceTokenResponse, token: "t".repeat(16385) }],
    ["a non-positive lifetime", { ...fixture.sso.serviceTokenResponse, expiresIn: 0 }],
  ])("refuses a service-token reply with %s", async (_case, reply) => {
    const { client, calls } = ssoSetup({ "service-token": reply });
    const body = web.ssoStartRequest.body;
    await expect(client.ssoStart(body.email, body.state, body.codeChallenge)).rejects.toThrow(
      "Invalid Hub response",
    );
    expect(calls("sso-start")).toHaveLength(0);
  });

  it.each(fixture.sso.serviceTokenErrors)(
    "surfaces service-token $status $error without calling start or retrying",
    async ({ status, error }) => {
      const { client, calls } = ssoSetup({
        "service-token": Response.json(error ? { error } : {}, { status }),
      });
      const body = web.ssoStartRequest.body;
      const failure = await client
        .ssoStart(body.email, body.state, body.codeChallenge)
        .catch((caught: unknown) => caught);
      expect(failure).toMatchObject({ status, code: error });
      expect(String(failure)).not.toContain(config.sso.secret);
      expect(calls("service-token")).toHaveLength(1);
      expect(calls("sso-start")).toHaveLength(0);
    },
  );

  it("never puts the service secret in an error when the token request fails", async () => {
    const { client } = ssoSetup({
      "service-token": new Response(`bad secret ${config.sso.secret}`, { status: 401 }),
    });
    const body = web.ssoStartRequest.body;
    const failure = await client
      .ssoStart(body.email, body.state, body.codeChallenge)
      .catch((caught: unknown) => caught);
    expect(JSON.stringify(failure)).not.toContain(config.sso.secret);
    expect(String(failure)).not.toContain(config.sso.secret);
  });

  it("refuses a non-HTTPS authorize URL", async () => {
    const { client } = ssoSetup({ "sso-start": { authorizeUrl: "http://login.example.test/" } });
    const body = web.ssoStartRequest.body;
    await expect(client.ssoStart(body.email, body.state, body.codeChallenge)).rejects.toThrow();
  });

  it("refuses to start or exchange without SSO configuration", async () => {
    const client = createHubClient({ origin, tenantId: config.tenantId }, vi.fn());
    await expect(client.ssoStart("user@example.test", "s".repeat(43), "c")).rejects.toThrow(
      "Hub SSO is not configured",
    );
    await expect(client.ssoExchange("code", "verifier", redirectUri)).rejects.toThrow(
      "Hub SSO is not configured",
    );
  });
});

describe("Hub session product and deployment binding", () => {
  const identity = { subject: "fixture-user", tenant: "fixture-tenant" };
  const deploymentId = "11111111-1111-4111-8111-111111111111";
  const replies = (session: Record<string, unknown>) =>
    vi.fn(async (url: any) =>
      new URL(String(url)).pathname.endsWith("/session")
        ? Response.json({
            valid: true,
            userId: "fixture-user",
            tenantId: "fixture-tenant",
            ...session,
          })
        : Response.json({
            product: "cortexai-agent-hub",
            products: fixture.sessionResponse.products,
          }),
    );
  it.each([
    [{}],
    [{ product: null, deploymentId: null }],
    [{ product: "cortexai-agent-hub", deploymentId }],
  ])("accepts %j", async (session) => {
    const client = createHubClient({ origin, deploymentId }, replies(session));
    await expect(client.verify("opaque", identity)).resolves.toBeUndefined();
  });
  it.each([
    [{ product: "cortexai-workbench" }],
    [{ deploymentId: "22222222-2222-4222-8222-222222222222" }],
  ])("rejects %j", async (session) => {
    const client = createHubClient({ origin, deploymentId }, replies(session));
    await expect(client.verify("opaque", identity)).rejects.toThrow();
  });
  it("rejects a deployment-bound session when this deployment has no id", async () => {
    const client = createHubClient({ origin }, replies({ deploymentId }));
    await expect(client.verify("opaque", identity)).rejects.toThrow();
  });
});

describe("Hub SSO configuration", () => {
  const base = {
    AUTH_MODE: "hub",
    HUB_AUTH_ORIGIN: origin,
    HUB_SSO_ENABLED: "true",
    HUB_AUTH_TENANT_ID: "fixture-tenant",
    HUB_DEPLOYMENT_ID: "11111111-1111-4111-8111-111111111111",
    HUB_SERVICE_API_ID: "fixture-api-id",
    HUB_SERVICE_SECRET_FILE: "/run/secrets/hub-service-secret",
  };
  const readSecretFile = vi.fn((_path: string) => "synthetic-service-secret\n");

  it("defaults off and leaves hub mode exactly as before", () => {
    expect(
      hubAuthFromEnv({ AUTH_MODE: "hub", HUB_AUTH_ORIGIN: origin }, { readSecretFile }),
    ).toEqual({ origin });
    expect(
      hubAuthFromEnv({ ...base, HUB_SSO_ENABLED: "false" }, { readSecretFile })?.sso,
    ).toBeUndefined();
    expect(readSecretFile).not.toHaveBeenCalled();
  });

  it("reads the service secret from its file only in the API process", () => {
    expect(hubAuthFromEnv(base, { readSecretFile })).toEqual({
      origin,
      tenantId: "fixture-tenant",
      deploymentId: base.HUB_DEPLOYMENT_ID,
      sso: { apiId: "fixture-api-id", secret: "synthetic-service-secret" },
    });
    expect(readSecretFile).toHaveBeenCalledWith(base.HUB_SERVICE_SECRET_FILE);
    readSecretFile.mockClear();
    expect(hubAuthFromEnv(base)?.sso).toBeUndefined();
    expect(readSecretFile).not.toHaveBeenCalled();
  });

  it.each([
    ["AUTH_MODE", "local", "HUB_SSO_ENABLED requires AUTH_MODE=hub"],
    ["AUTH_MODE", undefined, "HUB_SSO_ENABLED requires AUTH_MODE=hub"],
    ["HUB_AUTH_TENANT_ID", undefined, "HUB_SSO_ENABLED requires HUB_AUTH_TENANT_ID"],
    ["HUB_DEPLOYMENT_ID", undefined, "HUB_SSO_ENABLED requires HUB_DEPLOYMENT_ID"],
    ["HUB_DEPLOYMENT_ID", "prod-1", "HUB_DEPLOYMENT_ID must be the deployment UUID"],
    ["HUB_SERVICE_API_ID", " ", "HUB_SSO_ENABLED requires HUB_SERVICE_API_ID"],
    ["HUB_SERVICE_SECRET_FILE", undefined, "HUB_SSO_ENABLED requires HUB_SERVICE_SECRET_FILE"],
    ["HUB_SSO_ENABLED", "yes", "HUB_SSO_ENABLED must be true or false"],
    ["HUB_AUTH_TENANT_ID", "t".repeat(257), "HUB_AUTH_TENANT_ID must be at most 256 characters"],
    ["HUB_SERVICE_API_ID", "a".repeat(257), "HUB_SERVICE_API_ID must be at most 256 characters"],
  ])("refuses to start when %s is %s", (key, value, message) => {
    const env: NodeJS.ProcessEnv = { ...base, [key]: value };
    if (value === undefined) delete env[key];
    expect(() => hubAuthFromEnv(env, { readSecretFile })).toThrow(message);
  });

  it("refuses an unreadable or empty secret file without echoing its contents", () => {
    expect(() =>
      hubAuthFromEnv(base, {
        readSecretFile: () => {
          throw new Error("ENOENT synthetic-service-secret");
        },
      }),
    ).toThrow(/^HUB_SERVICE_SECRET_FILE could not be read$/);
    expect(() => hubAuthFromEnv(base, { readSecretFile: () => " \n" })).toThrow(
      "HUB_SERVICE_SECRET_FILE is empty",
    );
    const oversized = "s".repeat(4097);
    const failure = (() => {
      try {
        hubAuthFromEnv(base, { readSecretFile: () => oversized });
      } catch (error) {
        return String(error);
      }
    })();
    expect(failure).toBe("Error: HUB_SERVICE_SECRET_FILE must hold at most 4096 characters");
  });
});
