import { createHash, createHmac } from "node:crypto";
import { HUB_SSO_ACCESS_DENIED } from "@cortexai-agent-hub/core";
import { bootstrapUserSpace } from "@cortexai-agent-hub/db";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nativeContract from "./fixtures/agent-hub-native-sso.v1.json" with { type: "json" };
import { HUB_SIGN_IN_RATE_LIMITS } from "./hub.js";
import {
  createHubClient,
  type HubAuthConfig,
  HubRequestError,
  HubUnsupportedIdpError,
  hubUserId,
} from "./hub-client.js";
import {
  applyHubPolicyAtStartup,
  createHubPolicy,
  type HubPolicy,
  notConfiguredHubPolicy,
} from "./hub-policy.js";
import { memoryHubPolicyStore } from "./hub-policy-store.js";
import { hubPolicyBodyForTests, hubPolicyForTests } from "./hub-policy-testing.js";
import { createHubSessionAuthorizer, createUserWorkAuthorizer } from "./hub-sessions.js";
import { CLIENT_IP_HEADER, createAuth } from "./index.js";

vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return {
    prismaAdapter: (prisma: { authData: Record<string, unknown[]> }) =>
      memoryAdapter(prisma.authData),
  };
});
vi.mock("@cortexai-agent-hub/db", () => ({
  bootstrapUserSpace: vi.fn(async () => ({ spaceId: "space-1" })),
  recordSecurityEvent: vi.fn(async () => undefined),
}));
vi.mock("./hub-client.js", async (original) => ({
  ...(await original<typeof import("./hub-client.js")>()),
  createHubClient: vi.fn(),
}));

const config = {
  origin: "https://hub.example.test",
  tenantId: "tenant-1",
  clientId: "client-1",
  clientSecret: "test-secret",
  audience: "cortexai:caia",
};
const encryptionKey = "offline-encryption-key-not-a-real-secret";
const userId = hubUserId(config.origin, config.tenantId, "subject-1");
const ssoConfig = {
  ...config,
  deploymentId: "11111111-1111-4111-8111-111111111111",
  sso: { apiId: "fixture-api-id", secret: "service-secret-not-real" },
};
const MOBILE_ORIGIN = "cortexai-agent-hub://";
const authSecret = "offline-auth-secret-at-least-32-characters";
const NATIVE_RETURN_TO = {
  desktop: "http://127.0.0.1:53682/hub-sso",
  mobile: "cortexai-agent-hub://hub-sso",
} as const;
const APP_VERIFIER = "synthetic-app-verifier-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const APP_CHALLENGE = createHash("sha256").update(APP_VERIFIER).digest("base64url");

/** Signs a stored session token the way the session cookie and `set-auth-token` do. */
function signedBearer(token: string) {
  return `${token}.${createHmac("sha256", authSecret).update(token).digest("base64")}`;
}

const authorizeUrl = "https://login.microsoftonline.com/synthetic-tenant/oauth2/v2.0/authorize";
function fixture(
  hubClient?: ReturnType<typeof createHubClient>,
  options: {
    sso?: boolean;
    onHubSsoError?: (reason: string) => void;
    policy?: HubPolicy;
    assigned?: readonly string[];
    contract?: boolean;
    hub?: HubAuthConfig;
  } = {},
) {
  const gate = hubPolicyForTests(config.tenantId, options.assigned, {
    contract: options.contract,
  });
  const policy = options.policy ?? gate.policy;
  const data: Record<string, any[]> = { user: [], account: [], session: [], verification: [] };
  const identities = new Map<string, any>();
  const grants = new Map<string, any>();
  let native: any[] = [];
  const nativeMatches = (row: any, where: Record<string, any>) =>
    Object.entries(where).every(([key, value]) =>
      key === "expiresAt"
        ? row.expiresAt < value.lt
        : key === "grantCipher"
          ? row.grantCipher !== null
          : row[key] === value,
    );
  const grant = {
    subject: "subject-1",
    tenant: config.tenantId,
    accessToken: "access-secret-1",
    refreshToken: "refresh-secret-1",
    accessUntil: new Date(Date.now() + 900_000),
  };
  const client = {
    lookup: vi.fn(
      async (): Promise<{ tenant: string; idpType: "native" | "entra" | "google" }> => ({
        tenant: config.tenantId,
        idpType: "native",
      }),
    ),
    login: vi.fn(async () => grant),
    refresh: vi.fn(async () => ({
      ...grant,
      refreshToken: "refresh-secret-2",
      accessUntil: new Date(Date.now() + 900_000),
    })),
    verify: vi.fn(async () => undefined),
    revoke: vi.fn(async () => undefined),
    ssoStart: vi.fn(
      async (_email: string, _state: string, _challenge: string): Promise<string> => authorizeUrl,
    ),
    ssoExchange: vi.fn(async (_code: string, _verifier: string, _redirectUri: string) => grant),
    serviceConfig: vi.fn(async () => ({ status: 304 as const })),
  };
  vi.mocked(createHubClient).mockReturnValue(hubClient ?? client);
  let transaction = Promise.resolve();
  const prisma: any = {
    authData: data,
    $queryRaw: vi.fn(async () => []),
    $transaction: (fn: (tx: any) => Promise<unknown>) => {
      // Simulate the database row lock without a network dependency.
      const result = transaction.then(() => fn(prisma));
      transaction = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    user: {
      findUnique: async ({ where }: any) => data.user!.find((row) => row.id === where.id),
      upsert: async ({ create }: any) => {
        let user = data.user!.find((row) => row.id === create.id);
        if (!user) {
          const { hubIdentity, ...fields } = create;
          user = { ...fields, createdAt: new Date(), updatedAt: new Date(), image: null };
          data.user!.push(user);
          identities.set(user.id, { userId: user.id, ...hubIdentity.create });
        }
        return user;
      },
    },
    hubIdentity: { findUnique: async ({ where }: any) => identities.get(where.userId) },
    hubSession: {
      create: async ({ data: row }: any) => {
        grants.set(row.sessionId, row);
        return row;
      },
      findUnique: async ({ where }: any) => grants.get(where.sessionId),
      update: async ({ where, data: updates }: any) =>
        Object.assign(grants.get(where.sessionId), updates),
    },
    session: {
      findMany: async ({ where }: any) =>
        data.session!.filter(
          (row) =>
            row.userId === where.userId && row.expiresAt > where.expiresAt.gt && grants.has(row.id),
        ),
      findUnique: async ({ where }: any) => data.session!.find((row) => row.id === where.id),
      deleteMany: async ({ where }: any) => {
        data.session = data.session!.filter((row) => row.id !== where.id);
        grants.delete(where.id);
      },
    },
    spaceMember: { findFirst: async () => ({ spaceId: "space-1" }) },
    verification: {
      create: async ({ data: row }: any) => {
        data.verification!.push(row);
        return row;
      },
      findUnique: async ({ where }: any) => data.verification!.find((row) => row.id === where.id),
      deleteMany: async ({ where }: any) => {
        const before = data.verification!.length;
        const matches = (row: any) =>
          where.id !== undefined
            ? row.id === where.id
            : row.identifier.startsWith(where.identifier.startsWith) &&
              row.expiresAt < where.expiresAt.lt;
        data.verification = data.verification!.filter((row) => !matches(row));
        return { count: before - data.verification.length };
      },
    },
    hubSsoNative: {
      create: async ({ data: row }: any) => {
        native.push({ handoffHash: null, grantCipher: null, createdAt: new Date(), ...row });
        return row;
      },
      findUnique: async ({ where }: any) => native.find((row) => nativeMatches(row, where)),
      findMany: async ({ where }: any) => native.filter((row) => nativeMatches(row, where)),
      updateMany: async ({ where, data: updates }: any) => {
        const rows = native.filter((row) => nativeMatches(row, where));
        for (const row of rows) Object.assign(row, updates);
        return { count: rows.length };
      },
      deleteMany: async ({ where }: any) => {
        const before = native.length;
        native = native.filter((row) => !nativeMatches(row, where));
        return { count: before - native.length };
      },
    },
  };
  const web = options.sso ? "https://web.example.test" : "http://web.example.test";
  const auth = createAuth(prisma, {
    secret: authSecret,
    tokenEncryptionKey: encryptionKey,
    baseURL: web,
    webOrigin: web,
    hub: options.hub ?? (options.sso ? ssoConfig : config),
    signupsEnabled: "true",
    signupAllowlist: "",
    onHubSsoError: options.onHubSsoError,
    hubPolicy: policy,
    extraOrigins: [MOBILE_ORIGIN],
  });
  const request = (path: string, cookie = "", body?: unknown, origin = web) =>
    auth.handler(
      new Request(`${web}/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers: { cookie, origin, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  async function login() {
    const response = await request("/hub/sign-in", "", {
      email: "user@example.test",
      password: "test-password",
    });
    expect(response.status).toBe(200);
    expect(await response.clone().text()).not.toContain("access-secret");
    // Native clients use the returned token as their bearer, so it must be the signed one.
    const { token } = (await response.clone().json()) as { token: string };
    expect(token.startsWith(`${data.session!.at(-1)!.token}.`)).toBe(true);
    const headers = new Headers({ authorization: `Bearer ${token}` });
    return { response, headers };
  }
  /** Continue as an Entra user and return what the browser would hold. */
  async function startSso(email = "entra@example.test") {
    client.lookup.mockResolvedValue({ tenant: config.tenantId, idpType: "entra" });
    const response = await request("/hub/sign-in/continue", "", { email });
    const setCookie = response.headers.get("set-cookie") ?? "";
    const state = /__Host-ah_sso=([^;]+)/.exec(setCookie)?.[1] ?? "";
    return { response, setCookie, state, cookie: `__Host-ah_sso=${state}` };
  }
  const callback = (query: string, cookie = "") => request(`/hub/sso/callback?${query}`, cookie);
  /** Native start as the desktop renderer (instance origin) or the mobile app would send it. */
  function startNative(app: "desktop" | "mobile" = "desktop", body: Record<string, unknown> = {}) {
    client.lookup.mockResolvedValue({ tenant: config.tenantId, idpType: "entra" });
    return request(
      "/hub/sso/native/start",
      "",
      {
        email: "entra@example.test",
        client: app,
        returnTo: NATIVE_RETURN_TO[app],
        appChallenge: APP_CHALLENGE,
        ...body,
      },
      app === "mobile" ? MOBILE_ORIGIN : web,
    );
  }
  const completeNative = (body: unknown, app: "desktop" | "mobile" = "desktop") =>
    request("/hub/sso/native/complete", "", body, app === "mobile" ? MOBILE_ORIGIN : web);
  const work = createUserWorkAuthorizer(prisma, options.hub ?? config, encryptionKey, { policy });
  return {
    auth,
    request,
    login,
    startSso,
    callback,
    startNative,
    completeNative,
    native: () => native,
    data,
    identities,
    grants,
    client,
    prisma,
    policy,
    hub: gate.hub,
    work,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("Hub authentication through real auth endpoints", () => {
  it("requires an active Hub grant for background work and never falls back to native users", async () => {
    const f = fixture();
    const authorize = createUserWorkAuthorizer(f.prisma, config, encryptionKey, {
      policy: f.policy,
    });
    expect(await authorize(userId)).toBe(false);
    expect(await authorize("local-user")).toBe(false);
    await f.login();
    expect(await authorize(userId)).toBe(true);
    [...f.grants.values()][0].accessUntil = new Date(0);
    f.client.refresh.mockRejectedValue(new Error("access removed"));
    expect(await authorize(userId)).toBe(false);
    const local = createUserWorkAuthorizer(f.prisma, undefined, encryptionKey);
    expect(await local("local-user")).toBe(true);
    expect(await local(userId)).toBe(false);
  });
  it("creates a separate identity and ordinary session without promoting a deployment owner or exposing grants", async () => {
    const f = fixture();
    const { headers } = await f.login();
    const session = await f.auth.api.getSession({ headers });
    expect(session?.user.id).toBe(userId);
    expect(JSON.stringify(session)).not.toContain("refresh-secret");
    expect(bootstrapUserSpace).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: userId }),
      expect.anything(),
    );
    expect(f.grants.size).toBe(1);
    const stored = [...f.grants.values()][0];
    expect(stored.refreshToken).not.toBe("refresh-secret-1");
    expect(await symmetricDecrypt({ key: encryptionKey, data: stored.refreshToken })).toBe(
      "refresh-secret-1",
    );
    await f.login();
    expect(f.data.user).toHaveLength(1);
  });

  it("requires credentials and rejects the old redirect flow", async () => {
    const f = fixture();
    expect((await f.request("/hub/sign-in")).status).not.toBe(302);
    expect((await f.request("/hub/sign-in", "", {})).status).toBe(400);
    expect(f.client.login).not.toHaveBeenCalled();
    const response = await f.auth.handler(
      new Request("http://web.example.test/api/auth/hub/sign-in", {
        method: "POST",
        headers: { origin: "https://untrusted.example.test", "content-type": "application/json" },
        body: JSON.stringify({ email: "user@example.test", password: "test-password" }),
      }),
    );
    expect(response.status).toBe(403);
    expect(f.client.login).not.toHaveBeenCalled();
  });
  it("routes Continue to the password step for native and Always Native users", async () => {
    const f = fixture();
    const response = await f.request("/hub/sign-in/continue", "", { email: "user@example.test" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ next: "password" });
    expect(f.client.lookup).toHaveBeenCalledExactlyOnceWith("user@example.test");
    expect(f.data.session).toHaveLength(0);
    await f.login();
  });

  it("routes Entra users who are not Always Native to sso_unavailable", async () => {
    const f = fixture();
    f.client.lookup.mockResolvedValue({ tenant: config.tenantId, idpType: "entra" });
    const response = await f.request("/hub/sign-in/continue", "", { email: "entra@example.test" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: "sso_unavailable" });
    expect(f.client.login).not.toHaveBeenCalled();
  });

  it("uses the domain IdP for an unprovisioned email when Hub resolves its domain", async () => {
    const f = fixture();
    f.client.lookup.mockResolvedValue({ tenant: config.tenantId, idpType: "entra" });
    const response = await f.request("/hub/sign-in/continue", "", {
      email: "unprovisioned@example.test",
    });
    expect(await response.json()).toEqual({ next: "sso_unavailable" });
  });

  it.each([
    ["native", "password", 200],
    ["entra", "sso_unavailable", 400],
    ["google", "other_sso_unavailable", 400],
  ])(
    "follows Hub's lookup for a tenant user whose idpType is %s",
    async (idpType, next, signInStatus) => {
      const { createHubClient: realHubClient } =
        await vi.importActual<typeof import("./hub-client.js")>("./hub-client.js");
      const user = { id: "subject-1", tenantId: config.tenantId, displayName: "Tenant User" };
      const products = [{ id: "cortexai-agent-hub", enabled: true }];
      const replies: Record<string, unknown> = {
        lookup: { tenantId: config.tenantId, tenantName: "Tenant", idpType, tenantSlug: "tenant" },
        login: {
          success: true,
          user,
          accessToken: "access-secret-1",
          accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
          refreshToken: "refresh-secret-1",
          refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          products,
        },
        session: { valid: true, userId: user.id, tenantId: user.tenantId },
        config: { product: "cortexai-agent-hub", products },
      };
      const fetcher = vi.fn(async (url: URL | string) =>
        Response.json(replies[new URL(String(url)).pathname.split("/").at(-1)!]),
      );
      const f = fixture(realHubClient(config, fetcher as typeof fetch));
      const email = "tenant-user@example.test";
      const routed = await f.request("/hub/sign-in/continue", "", { email });
      expect(await routed.json()).toEqual({ next });
      const signIn = await f.request("/hub/sign-in", "", { email, password: "test-password" });
      expect(signIn.status).toBe(signInStatus);
      const paths = fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname);
      if (idpType === "native") {
        expect(paths).toContain("/api/tenant-auth/login");
        expect(f.data.user!.map((row) => row.id)).toEqual([userId]);
        expect(f.data.session).toHaveLength(1);
      } else {
        expect(paths).not.toContain("/api/tenant-auth/login");
        expect(await signIn.json()).toMatchObject({ code: "HUB_IDP_UNSUPPORTED" });
        expect(f.data.session).toHaveLength(0);
      }
    },
  );

  it("uses the password step when Hub returns an invalid IdP type", async () => {
    const { createHubClient: realHubClient } =
      await vi.importActual<typeof import("./hub-client.js")>("./hub-client.js");
    const fetcher = vi.fn(async () => Response.json({ tenantId: config.tenantId }));
    const f = fixture(realHubClient(config, fetcher as typeof fetch));
    const response = await f.request("/hub/sign-in/continue", "", {
      email: "user@example.test",
    });
    expect(await response.json()).toEqual({ next: "password" });
  });

  it.each([
    ["email outside known Hub domains", new Error("Hub access denied")],
    ["other-tenant email", new Error("Hub access denied")],
    ["lookup timeout", new DOMException("The operation timed out.", "TimeoutError")],
    ["invalid Hub response", new Error("Invalid Hub response")],
  ])("answers a %s exactly like a native user", async (_case, failure) => {
    const f = fixture();
    const snapshot = async (response: Response) => ({
      status: response.status,
      contentType: response.headers.get("content-type"),
      cacheControl: response.headers.get("cache-control"),
      body: await response.text(),
    });
    const native = await snapshot(
      await f.request("/hub/sign-in/continue", "", { email: "user@example.test" }),
    );
    f.client.lookup.mockRejectedValue(failure);
    const hidden = await snapshot(
      await f.request("/hub/sign-in/continue", "", { email: "someone@example.test" }),
    );
    expect(hidden).toEqual(native);
    expect(native.body).toBe('{"next":"password"}');
  });

  it("rejects Continue from untrusted origins or without an email", async () => {
    const f = fixture();
    for (const origin of ["https://untrusted.example.test", undefined]) {
      const response = await f.auth.handler(
        new Request("http://web.example.test/api/auth/hub/sign-in/continue", {
          method: "POST",
          headers: {
            ...(origin ? { origin } : {}),
            "content-type": "application/json",
          },
          body: JSON.stringify({ email: "user@example.test" }),
        }),
      );
      expect(response.status).toBe(403);
    }
    for (const body of [{}, { email: " " }, { email: `${"a".repeat(320)}@x.test` }]) {
      expect((await f.request("/hub/sign-in/continue", "", body)).status).toBe(400);
    }
    expect(f.client.lookup).not.toHaveBeenCalled();
  });

  it("rate-limits Continue exactly like password sign-in", async () => {
    const f = fixture();
    const context = await f.auth.$context;
    context.rateLimit.enabled = true;
    const allowedBeforeLimit = async (path: string) => {
      for (let count = 0; count < 500; count++) {
        const response = await f.request(path, "", {});
        if (response.status === 429) return count;
      }
      throw new Error(`${path} was never rate-limited`);
    };
    try {
      const signIn = await allowedBeforeLimit("/hub/sign-in");
      expect(await allowedBeforeLimit("/hub/sign-in/continue")).toBe(signIn);
    } finally {
      context.rateLimit.enabled = false;
    }
  });

  it("never logs the submitted email", async () => {
    const f = fixture();
    const logged: unknown[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args) => void logged.push(...args)),
    );
    try {
      f.client.lookup.mockRejectedValueOnce(new Error("Hub access denied"));
      f.client.lookup.mockResolvedValueOnce({ tenant: config.tenantId, idpType: "entra" });
      for (let attempt = 0; attempt < 3; attempt++) {
        await f.request("/hub/sign-in/continue", "", { email: "private@example.test" });
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(JSON.stringify(logged.map(String))).not.toContain("private@example.test");
  });

  it("removes access before token expiry when Hub denies current entitlement", async () => {
    const f = fixture();
    const { headers } = await f.login();
    f.client.verify.mockRejectedValue(new Error("assignment removed"));
    expect(await f.auth.api.getSession({ headers })).toBeNull();
    expect(f.data.session).toHaveLength(0);
    expect(f.client.refresh).not.toHaveBeenCalled();
  });
  it("revokes the native refresh token on sign-out", async () => {
    const f = fixture();
    const { headers } = await f.login();
    await f.auth.api.signOut({ headers });
    expect(f.client.revoke).toHaveBeenCalledExactlyOnceWith("refresh-secret-1");
    expect(f.data.session).toHaveLength(0);
  });

  it("returns a safe unsupported-IdP error without creating a session", async () => {
    const f = fixture();
    f.client.login.mockRejectedValue(new HubUnsupportedIdpError());
    const response = await f.request("/hub/sign-in", "", {
      email: "user@example.test",
      password: "test-password",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "HUB_IDP_UNSUPPORTED" });
    expect(f.data.session).toHaveLength(0);
  });

  it("requires old OAuth sessions to sign in again", async () => {
    const f = fixture();
    const { headers } = await f.login();
    delete [...f.grants.values()][0].accessToken;
    expect(await f.auth.api.getSession({ headers })).toBeNull();
  });

  it("rotates encrypted refresh once for concurrent expired-session checks", async () => {
    const f = fixture();
    const { headers } = await f.login();
    [...f.grants.values()][0].accessUntil = new Date(0);
    const sessions = await Promise.all([
      f.auth.api.getSession({ headers }),
      f.auth.api.getSession({ headers }),
    ]);
    expect(sessions.every(Boolean)).toBe(true);
    expect(f.client.refresh).toHaveBeenCalledExactlyOnceWith("refresh-secret-1");
    expect(
      await symmetricDecrypt({ key: encryptionKey, data: [...f.grants.values()][0].refreshToken }),
    ).toBe("refresh-secret-2");
  });

  it.each(["denied", "identity changed"])(
    "revokes the local session when refresh is %s",
    async (failure) => {
      const f = fixture();
      const { headers } = await f.login();
      [...f.grants.values()][0].accessUntil = new Date(0);
      if (failure === "denied") f.client.refresh.mockRejectedValue(new Error("invalid_grant"));
      else
        f.client.refresh.mockResolvedValue({
          subject: "different-user",
          tenant: config.tenantId,
          accessToken: "other-access",
          refreshToken: "other",
          accessUntil: new Date(Date.now() + 900_000),
        });
      expect(await f.auth.api.getSession({ headers })).toBeNull();
      expect(f.data.session).toHaveLength(0);
      expect(f.grants.size).toBe(0);
    },
  );

  it("does not admit an existing local session or local credential mutations in Hub mode", async () => {
    const f = fixture();
    const { headers } = await f.login();
    f.data.user![0]!.id = "local-user";
    f.data.session![0]!.userId = "local-user";
    expect(await f.auth.api.getSession({ headers })).toBeNull();
    for (const path of [
      "/sign-up/email",
      "/sign-in/email",
      "/request-password-reset",
      "/change-password",
      "/change-email",
      "/delete-user",
    ]) {
      expect(
        (await f.request(path, "", { email: "user@example.test", password: "test-password" }))
          .status,
      ).toBe(403);
    }
  });
});

describe("Hub sign-in rate limits", () => {
  // The limiter's memory store is process-wide, so each case uses its own client addresses.
  async function limited() {
    const f = fixture(undefined, { sso: true });
    (await f.auth.$context).rateLimit.enabled = true;
    const post = (path: string, clientIp: string, body: unknown) =>
      f.auth.handler(
        new Request(`https://web.example.test/api/auth${path}`, {
          method: "POST",
          headers: {
            origin: "https://web.example.test",
            "content-type": "application/json",
            [CLIENT_IP_HEADER]: clientIp,
          },
          body: JSON.stringify(body),
        }),
      );
    return { f, post };
  }

  it.each([
    ["/hub/sign-in", { email: "user@example.test", password: "test-password" }, "203.0.113.1"],
    ["/hub/sign-in/continue", { email: "user@example.test" }, "203.0.113.3"],
    [
      "/hub/sso/native/start",
      {
        email: "user@example.test",
        client: "desktop",
        returnTo: NATIVE_RETURN_TO.desktop,
        appChallenge: APP_CHALLENGE,
      },
      "203.0.113.5",
    ],
    [
      "/hub/sso/native/complete",
      { code: "c".repeat(43), state: "s".repeat(43), appVerifier: APP_VERIFIER },
      "203.0.113.7",
    ],
  ] as const)("limits %s per forwarded client address", async (path, body, client) => {
    const { post } = await limited();
    const { max } = HUB_SIGN_IN_RATE_LIMITS[path];
    for (let attempt = 0; attempt < max; attempt++) {
      expect((await post(path, client, body)).status).not.toBe(429);
    }
    expect((await post(path, client, body)).status).toBe(429);
    // Another person behind the same proxy keeps their own budget.
    expect((await post(path, "203.0.113.200", body)).status).not.toBe(429);
  });

  it("buckets by the single client address the reverse proxy forwards", async () => {
    const { post } = await limited();
    const body = { email: "user@example.test" };
    const { max } = HUB_SIGN_IN_RATE_LIMITS["/hub/sign-in/continue"];
    for (let attempt = 0; attempt < max; attempt++) {
      await post("/hub/sign-in/continue", "100.101.102.103", body);
    }
    expect((await post("/hub/sign-in/continue", "100.101.102.103", body)).status).toBe(429);
    expect((await post("/hub/sign-in/continue", "100.64.0.7", body)).status).toBe(200);
  });
});

describe("Hub tenant Entra SSO", () => {
  const code = "c".repeat(43);
  const redirectUri = "https://web.example.test/api/auth/hub/sso/callback";

  it("keeps today's routing when SSO is off", async () => {
    const f = fixture();
    const { response } = await f.startSso();
    expect(await response.json()).toEqual({ next: "sso_unavailable" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(f.client.ssoStart).not.toHaveBeenCalled();
    expect((await f.callback(`code=${code}&state=${"s".repeat(43)}`)).status).toBe(404);
  });

  it("sends an Entra user to Hub with server-side state and an S256 challenge", async () => {
    const f = fixture(undefined, { sso: true });
    const { response, setCookie, state } = await f.startSso();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ next: "redirect", url: authorizeUrl });
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).toMatch(/Max-Age=600/);
    expect(setCookie).not.toMatch(/Domain=/i);
    const [email, sentState, challenge] = f.client.ssoStart.mock.calls[0]!;
    expect(email).toBe("entra@example.test");
    expect(sentState).toBe(state);
    const [row] = f.data.verification!;
    expect(row.id).toBe(`hub-sso:${createHash("sha256").update(state).digest("hex")}`);
    expect(row.value).not.toContain(state);
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    const verifier = await symmetricDecrypt({ key: encryptionKey, data: row.value });
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(body).not.toContain(state);
    expect(body).not.toContain(verifier);
    expect(setCookie).not.toContain(verifier);
    expect(f.data.session).toHaveLength(0);
  });

  it("shows the password step to native and Always Native users when SSO is on", async () => {
    const f = fixture(undefined, { sso: true });
    const native = await f.request("/hub/sign-in/continue", "", { email: "user@example.test" });
    expect(await native.json()).toEqual({ next: "password" });
    f.client.lookup.mockResolvedValue({ tenant: config.tenantId, idpType: "entra" });
    f.client.ssoStart.mockRejectedValue(new HubRequestError(400, "user_always_native"));
    const alwaysNative = await f.request("/hub/sign-in/continue", "", {
      email: "admin@example.test",
    });
    expect(await alwaysNative.json()).toEqual({ next: "password" });
    expect(alwaysNative.headers.get("set-cookie")).toBeNull();
    expect(f.data.verification).toHaveLength(0);
    f.client.lookup.mockResolvedValue({ tenant: config.tenantId, idpType: "native" });
    await f.login();
  });

  it.each([
    ["email outside known Hub domains", new Error("Hub access denied")],
    ["other-tenant email", new Error("Hub access denied")],
    ["lookup timeout", new DOMException("The operation timed out.", "TimeoutError")],
  ])("answers a %s exactly like a native user when SSO is on", async (_case, failure) => {
    const f = fixture(undefined, { sso: true });
    const snapshot = async (response: Response) => ({
      status: response.status,
      cookie: response.headers.get("set-cookie"),
      cacheControl: response.headers.get("cache-control"),
      body: await response.text(),
    });
    const native = await snapshot(
      await f.request("/hub/sign-in/continue", "", { email: "user@example.test" }),
    );
    f.client.lookup.mockRejectedValue(failure);
    const hidden = await snapshot(
      await f.request("/hub/sign-in/continue", "", { email: "someone@example.test" }),
    );
    expect(hidden).toEqual(native);
    expect(f.client.ssoStart).not.toHaveBeenCalled();
  });

  it("removes expired SSO rows, and only those, when a new sign-in starts", async () => {
    const f = fixture(undefined, { sso: true });
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 60_000);
    f.data.verification!.push(
      { id: "hub-sso:expired", identifier: "hub-sso:expired", value: "x", expiresAt: past },
      { id: "hub-sso:pending", identifier: "hub-sso:pending", value: "x", expiresAt: future },
      { id: "reset-expired", identifier: "reset-password:x", value: "x", expiresAt: past },
    );
    await f.startSso();
    expect(f.data.verification!.map((row) => row.id)).toEqual([
      "hub-sso:pending",
      "reset-expired",
      expect.stringMatching(/^hub-sso:[0-9a-f]{64}$/),
    ]);
  });

  it.each(["access_denied", "product_not_enabled", "tenant_mismatch"])(
    "refuses Continue with an admin hint when Hub's start says %s",
    async (hubCode) => {
      const reasons: string[] = [];
      const f = fixture(undefined, { sso: true, onHubSsoError: (reason) => reasons.push(reason) });
      f.client.ssoStart.mockRejectedValue(new HubRequestError(403, hubCode));
      const { response } = await f.startSso();
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: HUB_SSO_ACCESS_DENIED });
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(f.data.verification).toHaveLength(0);
      expect(reasons).toEqual([`start:${hubCode}`]);
    },
  );

  it("fails Continue without a cookie or pending row when Hub cannot start", async () => {
    const f = fixture(undefined, { sso: true });
    f.client.ssoStart.mockRejectedValue(new HubRequestError(404, "agent_hub_not_registered"));
    const { response } = await f.startSso();
    expect(response.status).toBe(502);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(f.data.verification).toHaveLength(0);
  });

  it("signs the Entra user into the same hub_ row as password sign-in", async () => {
    const f = fixture(undefined, { sso: true });
    await f.login();
    const passwordRow = { ...f.data.user![0] };
    const { state, cookie } = await f.startSso();
    const verifier = await symmetricDecrypt({
      key: encryptionKey,
      data: f.data.verification![0].value,
    });
    const response = await f.callback(`code=${code}&state=${state}`, cookie);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://web.example.test/app");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((value) => /^__Host-ah_sso=;.*Max-Age=0/i.test(value))).toBe(true);
    expect(cookies.some((value) => value.includes("better-auth.session_token="))).toBe(true);
    expect(f.client.ssoExchange).toHaveBeenCalledExactlyOnceWith(code, verifier, redirectUri);
    expect(f.data.user).toHaveLength(1);
    expect(f.data.user![0]).toEqual(passwordRow);
    expect(f.data.user![0]!.id).toBe(userId);
    expect(f.data.session).toHaveLength(2);
    expect(f.data.verification).toHaveLength(0);
    const token = f.data.session![1]!.token;
    const session = await f.auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${signedBearer(token)}` }),
    });
    expect(session?.user.id).toBe(userId);
    expect(f.grants.size).toBe(2);
  });

  it("creates a fresh session instead of reusing one the browser already holds", async () => {
    const f = fixture(undefined, { sso: true });
    const { headers } = await f.login();
    const existing = f.data.session![0]!.token;
    const { state, cookie } = await f.startSso();
    const response = await f.callback(
      `code=${code}&state=${state}`,
      `${cookie}; __Secure-better-auth.session_token=${existing}`,
    );
    expect(response.status).toBe(302);
    expect(f.data.session).toHaveLength(2);
    expect(f.data.session![1]!.token).not.toBe(existing);
    expect(await f.auth.api.getSession({ headers })).not.toBeNull();
  });

  async function expectRejected(
    f: ReturnType<typeof fixture>,
    response: Response,
    error: "sso_expired" | "sso_failed",
  ) {
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `https://web.example.test/sign-in?error=${error}`,
    );
    expect(response.headers.get("set-cookie")).toMatch(/__Host-ah_sso=;.*Max-Age=0/i);
    expect(f.data.session).toHaveLength(0);
    expect(f.data.user).toHaveLength(0);
  }

  it("rejects a callback without the browser's state cookie (login CSRF)", async () => {
    const f = fixture(undefined, { sso: true });
    const { state } = await f.startSso();
    await expectRejected(f, await f.callback(`code=${code}&state=${state}`), "sso_expired");
    expect(f.client.ssoExchange).not.toHaveBeenCalled();
    expect(f.data.verification).toHaveLength(1);
  });

  it.each([
    ["missing state", (_state: string) => `code=${code}`],
    ["missing code", (state: string) => `state=${state}`],
    ["mismatched state", (_state: string) => `code=${code}&state=${"x".repeat(43)}`],
    ["malformed state", (_state: string) => `code=${code}&state=${"x".repeat(10)}`],
  ])("rejects a callback with %s", async (_case, query) => {
    const f = fixture(undefined, { sso: true });
    const { state, cookie } = await f.startSso();
    await expectRejected(f, await f.callback(query(state), cookie), "sso_expired");
    expect(f.client.ssoExchange).not.toHaveBeenCalled();
  });

  it("rejects a state whose server row is unknown or expired", async () => {
    const f = fixture(undefined, { sso: true });
    const { state, cookie } = await f.startSso();
    f.data.verification![0].expiresAt = new Date(Date.now() - 1);
    await expectRejected(f, await f.callback(`code=${code}&state=${state}`, cookie), "sso_expired");
    expect(f.data.verification).toHaveLength(0);
    const forged = "f".repeat(43);
    await expectRejected(
      f,
      await f.callback(`code=${code}&state=${forged}`, `__Host-ah_sso=${forged}`),
      "sso_expired",
    );
    expect(f.client.ssoExchange).not.toHaveBeenCalled();
  });

  it("rejects a replayed callback URL without a second exchange", async () => {
    const f = fixture(undefined, { sso: true });
    const { state, cookie } = await f.startSso();
    const url = `code=${code}&state=${state}`;
    expect((await f.callback(url, cookie)).status).toBe(302);
    expect(f.data.session).toHaveLength(1);
    const replay = await f.callback(url, cookie);
    expect(replay.headers.get("location")).toBe(
      "https://web.example.test/sign-in?error=sso_expired",
    );
    expect(f.client.ssoExchange).toHaveBeenCalledOnce();
    expect(f.data.session).toHaveLength(1);
  });

  it.each([
    ["Hub exchange 400", new HubRequestError(400, "invalid_verifier")],
    ["Hub exchange 401", new HubRequestError(401, "invalid_code")],
    ["user without Agent Hub assigned", new HubRequestError(403, "access_denied")],
    ["tenant-B user on a tenant-A deployment", new HubRequestError(403, "tenant_mismatch")],
    ["entitlement removed before verification", new Error("Hub access denied")],
  ])("fails closed on %s without retrying the code", async (_case, failure) => {
    const f = fixture(undefined, { sso: true });
    f.client.ssoExchange.mockRejectedValue(failure);
    const { state, cookie } = await f.startSso();
    await expectRejected(f, await f.callback(`code=${code}&state=${state}`, cookie), "sso_failed");
    expect(f.client.ssoExchange).toHaveBeenCalledOnce();
    expect(f.data.verification).toHaveLength(0);
  });

  it("fails a callback that carries the IdP's error without exchanging", async () => {
    const reasons: string[] = [];
    const f = fixture(undefined, { sso: true, onHubSsoError: (reason) => reasons.push(reason) });
    const { state, cookie } = await f.startSso();
    await expectRejected(
      f,
      await f.callback(`error=access_denied&state=${state}`, cookie),
      "sso_failed",
    );
    expect(reasons).toEqual(["callback:idp_error"]);
    expect(f.client.ssoExchange).not.toHaveBeenCalled();
  });

  it.each(["access_denied", "login_cancelled", "server_error"])(
    "keeps a web callback with Hub's error=%s on the generic SSO failure",
    async (hubError) => {
      const reasons: string[] = [];
      const f = fixture(undefined, { sso: true, onHubSsoError: (reason) => reasons.push(reason) });
      const { state, cookie } = await f.startSso();
      await expectRejected(
        f,
        await f.callback(`error=${hubError}&state=${state}`, cookie),
        "sso_failed",
      );
      // Without the cookie too, and for a state nobody started.
      for (const query of [
        `error=${hubError}&state=${state}`,
        `error=${hubError}&state=${"f".repeat(43)}`,
      ])
        expect((await f.callback(query)).headers.get("location")).toBe(
          "https://web.example.test/sign-in?error=sso_failed",
        );
      expect(reasons).toEqual(Array(3).fill("callback:idp_error"));
      expect(f.client.ssoExchange).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["revoke succeeds", undefined],
    ["revoke fails", new Error("Hub unavailable")],
  ])("revokes Hub's grant when the session cannot be created (%s)", async (_case, failure) => {
    const f = fixture(undefined, { sso: true });
    if (failure) f.client.revoke.mockRejectedValue(failure);
    f.prisma.hubSession.create = async () => {
      throw new Error("database unavailable");
    };
    const { state, cookie } = await f.startSso();
    const response = await f.callback(`code=${code}&state=${state}`, cookie);
    expect(response.headers.get("location")).toBe(
      "https://web.example.test/sign-in?error=sso_failed",
    );
    expect(f.client.revoke).toHaveBeenCalledExactlyOnceWith("refresh-secret-1");
    expect(f.data.session).toHaveLength(0);
  });

  it("drops an SSO session within the verify TTL after Hub disables the user", async () => {
    const f = fixture(undefined, { sso: true });
    const { state, cookie } = await f.startSso();
    await f.callback(`code=${code}&state=${state}`, cookie);
    const headers = new Headers({
      authorization: `Bearer ${signedBearer(f.data.session![0]!.token)}`,
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      expect(await f.auth.api.getSession({ headers })).not.toBeNull();
      f.client.verify.mockRejectedValue(new Error("user disabled"));
      vi.setSystemTime(Date.now() + 29_000);
      expect(await f.auth.api.getSession({ headers })).not.toBeNull();
      vi.setSystemTime(Date.now() + 1_001);
      expect(await f.auth.api.getSession({ headers })).toBeNull();
      expect(f.data.session).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still refuses session creation outside the Hub sign-in paths", async () => {
    const f = fixture(undefined, { sso: true });
    await f.login();
    const context = await f.auth.$context;
    await expect(context.internalAdapter.createSession(userId)).rejects.toThrow(
      "Sign in through CortexAI Hub",
    );
    for (const path of ["/sign-in/email", "/sign-in/social", "/sign-up/email"]) {
      expect(
        (await f.request(path, "", { email: "user@example.test", password: "test-password" }))
          .status,
      ).toBe(403);
    }
    expect(f.data.session).toHaveLength(1);
  });

  it("reports no local account methods and refuses local deletion", async () => {
    const f = fixture(undefined, { sso: true });
    const { headers } = await f.login();
    const security = await f.auth.handler(
      new Request("https://web.example.test/api/auth/account-security", { headers }),
    );
    expect(security.status).toBe(200);
    expect(await security.json()).toMatchObject({
      hasPassword: false,
      passwordChangeEnabled: false,
      emailDeletion: false,
      sso: null,
    });
    for (const path of ["/request-account-deletion", "/delete-user", "/change-password"]) {
      const response = await f.auth.handler(
        new Request(`https://web.example.test/api/auth${path}`, {
          method: "POST",
          headers: {
            authorization: headers.get("authorization")!,
            origin: "https://web.example.test",
            "content-type": "application/json",
          },
          body: "{}",
        }),
      );
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("Sign in through CortexAI Hub");
    }
  });

  it("refuses OIDC reauthentication and deletion callbacks before any OIDC check runs", async () => {
    const f = fixture(undefined, { sso: true });
    const { headers } = await f.login();
    const context = await f.auth.$context;
    const findAccounts = vi.spyOn(context.internalAdapter, "findAccounts");
    const authorization = headers.get("authorization")!;
    const reauth = await f.auth.handler(
      new Request("https://web.example.test/api/auth/sign-in/social", {
        method: "POST",
        headers: {
          authorization,
          origin: "https://web.example.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider: "oidc", additionalData: { reauthenticate: true } }),
      }),
    );
    const deletion = await f.auth.handler(
      new Request("https://web.example.test/api/auth/delete-user/callback?token=fixture-token", {
        headers: { authorization },
      }),
    );

    for (const response of [reauth, deletion]) {
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("Sign in through CortexAI Hub");
    }
    expect(findAccounts).not.toHaveBeenCalled();
    expect(f.data.session).toHaveLength(1);
  });

  it("never logs the code, state, verifier, tokens, email or service secret", async () => {
    const reasons: string[] = [];
    const logged: unknown[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args) => void logged.push(...args)),
    );
    let secrets: string[] = [];
    try {
      const f = fixture(undefined, { sso: true, onHubSsoError: (reason) => reasons.push(reason) });
      const { state, cookie } = await f.startSso("private@example.test");
      const verifier = await symmetricDecrypt({
        key: encryptionKey,
        data: f.data.verification![0].value,
      });
      await f.callback(`code=${code}&state=${state}`, cookie);
      await f.callback(`code=${code}&state=${state}`, cookie);
      f.client.ssoExchange.mockRejectedValueOnce(new HubRequestError(400, "invalid_verifier"));
      const second = await f.startSso("private@example.test");
      await f.callback(`code=${code}&state=${second.state}`, second.cookie);
      f.client.ssoStart.mockRejectedValueOnce(new HubRequestError(401, "invalid_service_token"));
      await f.startSso("private@example.test");
      secrets = [
        code,
        state,
        second.state,
        verifier,
        "private@example.test",
        "access-secret-1",
        "refresh-secret-1",
        ssoConfig.sso.secret,
      ];
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(reasons).toEqual([
      "callback:state_unknown",
      "callback:exchange:invalid_verifier",
      "start:invalid_service_token",
    ]);
    const output = JSON.stringify([...logged.map(String), ...reasons]);
    for (const secret of secrets) expect(output).not.toContain(secret);
  });

  it("makes the next Microsoft sign-in after an Agent Hub sign-out ask for credentials", async () => {
    const { createHubClient: realClient } =
      await vi.importActual<typeof import("./hub-client.js")>("./hub-client.js");
    const email = "private@example.test";
    const direct =
      "https://login.example.test/tenant/oauth2/v2.0/authorize?client_id=synthetic-client&response_type=code&state=opaque";
    const products = [{ id: "cortexai-agent-hub", enabled: true }];
    const starts: unknown[] = [];
    const revoked: unknown[] = [];
    const hub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (path === "/api/tenant-auth/lookup")
        return Response.json({ tenantId: config.tenantId, idpType: "entra" });
      if (path === "/api/agent-hub/service-token")
        return Response.json({ token: "synthetic-token", tokenType: "Bearer", expiresIn: 300 });
      if (path === "/api/tenant-auth/sso-start") {
        starts.push(body);
        return Response.json({ authorizeUrl: direct });
      }
      if (path === "/api/agent-hub/sso-exchange")
        return Response.json({
          success: true,
          user: { id: "subject-1", tenantId: config.tenantId, displayName: "Fixture" },
          accessToken: "access-secret-1",
          accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
          refreshToken: "refresh-secret-1",
          refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          products,
          tenantId: config.tenantId,
          deploymentId: ssoConfig.deploymentId,
        });
      if (path === "/api/tenant-auth/session")
        return Response.json({ valid: true, userId: "subject-1", tenantId: config.tenantId });
      if (path === "/api/tenant-auth/config")
        return Response.json({ product: "cortexai-agent-hub", products });
      if (path === "/api/tenant-auth/revoke") {
        revoked.push(body);
        return Response.json({ success: true });
      }
      throw new Error(`Unexpected Hub request ${path}`);
    });
    const logged: unknown[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args) => void logged.push(...args)),
    );
    try {
      const f = fixture(realClient(ssoConfig, hub as typeof fetch), { sso: true });
      const signIn = async () => {
        const start = await f.request("/hub/sign-in/continue", "", { email });
        const { url } = (await start.json()) as { url: string };
        const state = /__Host-ah_sso=([^;]+)/.exec(start.headers.get("set-cookie") ?? "")![1]!;
        const callback = await f.callback(`code=${code}&state=${state}`, `__Host-ah_sso=${state}`);
        expect(callback.headers.get("location")).toBe("https://web.example.test/app");
        return new URL(url);
      };
      const first = await signIn();
      expect(first.searchParams.get("prompt")).toBe("login");
      expect(first.searchParams.get("login_hint")).toBe(email);
      const token = f.data.session![0]!.token;
      await f.auth.api.signOut({
        headers: new Headers({ authorization: `Bearer ${signedBearer(token)}` }),
      });
      expect(revoked).toEqual([{ refreshToken: "refresh-secret-1" }]);
      expect(f.data.session).toHaveLength(0);

      const again = await f.request("/hub/sign-in/continue", "", { email });
      const next = new URL(((await again.json()) as { url: string }).url);
      expect(next.searchParams.get("prompt")).toBe("login");
      expect(next.searchParams.get("login_hint")).toBe(email);
      expect(f.data.session).toHaveLength(0);
      for (const sent of starts)
        expect(Object.keys(sent as object).sort()).toEqual([
          "codeChallenge",
          "codeChallengeMethod",
          "deploymentId",
          "email",
          "product",
          "returnChannel",
          "state",
          "tenantId",
        ]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const output = JSON.stringify(logged.map(String));
    for (const secret of [email, "synthetic-token", "access-secret-1", "refresh-secret-1"])
      expect(output).not.toContain(secret);
  });

  it("never logs the service secret or tokens while the real client renews and is rejected", async () => {
    const { createHubClient: realClient } =
      await vi.importActual<typeof import("./hub-client.js")>("./hub-client.js");
    const email = "private@example.test";
    const tokens = ["synthetic.service-token.one", "synthetic.service-token.two"];
    let issued = 0;
    const hits: Record<string, number> = {};
    const hub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      hits[path] = (hits[path] ?? 0) + 1;
      const bearer = (init!.headers as Record<string, string>).authorization;
      if (path === "/api/tenant-auth/lookup")
        return Response.json({ tenantId: config.tenantId, idpType: "entra" });
      if (path === "/api/agent-hub/service-token")
        return Response.json({ token: tokens[issued++], tokenType: "Bearer", expiresIn: 300 });
      if (path === "/api/tenant-auth/sso-start")
        return bearer === `Bearer ${tokens[0]}`
          ? Response.json({ error: "invalid_service_token" }, { status: 401 })
          : Response.json({ authorizeUrl });
      if (path === "/api/agent-hub/sso-exchange")
        return Response.json({ error: "invalid_service_token" }, { status: 401 });
      throw new Error(`Unexpected Hub request ${path}`);
    });
    const reasons: string[] = [];
    const logged: unknown[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args) => void logged.push(...args)),
    );
    let state = "";
    let location: string | null = null;
    try {
      const f = fixture(realClient(ssoConfig, hub as typeof fetch), {
        sso: true,
        onHubSsoError: (reason) => reasons.push(reason),
      });
      const start = await f.request("/hub/sign-in/continue", "", { email });
      expect(await start.json()).toEqual({ next: "redirect", url: authorizeUrl });
      state = /__Host-ah_sso=([^;]+)/.exec(start.headers.get("set-cookie") ?? "")?.[1] ?? "";
      const callback = await f.callback(`code=${code}&state=${state}`, `__Host-ah_sso=${state}`);
      location = callback.headers.get("location");
      expect(f.data.session).toHaveLength(0);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(location).toBe("https://web.example.test/sign-in?error=sso_failed");
    expect(hits["/api/tenant-auth/sso-start"]).toBe(2);
    expect(hits["/api/agent-hub/sso-exchange"]).toBe(1);
    expect(reasons).toEqual(["callback:exchange:invalid_service_token"]);
    const output = JSON.stringify([...logged.map(String), ...reasons]);
    for (const secret of [ssoConfig.sso.secret, ...tokens, code, state, email])
      expect(output).not.toContain(secret);
  });
});

describe("Hub native SSO handoff for desktop and mobile (CAAH-136)", () => {
  const code = "c".repeat(43);
  const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
  const clients = ["desktop", "mobile"] as const;

  /** Starts natively and follows Hub back to the callback, as the system browser would. */
  async function signInNative(f: ReturnType<typeof fixture>, client: "desktop" | "mobile") {
    const start = await f.startNative(client);
    expect(start.status).toBe(200);
    const { state } = (await start.json()) as { state: string };
    const callback = await f.callback(`code=${code}&state=${state}`);
    const location = callback.headers.get("location") ?? "";
    const handoff = new URL(location).searchParams.get("code") ?? "";
    return { state, callback, location, handoff };
  }

  function expectNothingCreated(f: ReturnType<typeof fixture>) {
    expect(f.data.session).toHaveLength(0);
    expect(f.data.user).toHaveLength(0);
    expect(f.grants.size).toBe(0);
  }

  describe("start", () => {
    it.each(clients)("sends a %s Entra user to Hub without a cookie", async (client) => {
      const f = fixture(undefined, { sso: true });
      const response = await f.startNative(client);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
      const body = (await response.json()) as Record<string, string>;
      expect(body).toEqual({ next: "redirect", authorizeUrl, state: expect.any(String) });
      expect(body.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const [email, sentState, challenge] = f.client.ssoStart.mock.calls[0]!;
      expect(email).toBe("entra@example.test");
      expect(sentState).toBe(body.state);
      const [row] = f.data.verification!;
      expect(row.id).toBe(`hub-sso:${sha256Hex(body.state!)}`);
      const verifier = await symmetricDecrypt({ key: encryptionKey, data: row.value });
      // Hub's PKCE pair stays on the server; the app's challenge never reaches Hub.
      expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
      expect(challenge).not.toBe(APP_CHALLENGE);
      expect(JSON.stringify(body)).not.toContain(verifier);
      expect(f.native()).toEqual([
        expect.objectContaining({
          stateKey: row.id,
          client,
          returnTo: NATIVE_RETURN_TO[client],
          appChallenge: APP_CHALLENGE,
          handoffHash: null,
          grantCipher: null,
        }),
      ]);
      expect(f.native()[0].expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
      expect(f.data.session).toHaveLength(0);
    });

    it.each([
      ["desktop", "http://localhost:53682/hub-sso"],
      ["desktop", "http://127.0.0.2:53682/hub-sso"],
      ["desktop", "http://user@127.0.0.1:53682/hub-sso"],
      ["desktop", "http://127.0.0.1:53682/hub-sso?next=/app"],
      ["desktop", "http://127.0.0.1:53682/hub-sso#x"],
      ["desktop", "http://127.0.0.1:53682\\@evil.example/hub-sso"],
      ["desktop", "http://127.0.0.1:80/hub-sso"],
      ["desktop", "https://evil.example/hub-sso"],
      ["desktop", NATIVE_RETURN_TO.mobile],
      ["mobile", NATIVE_RETURN_TO.desktop],
      ["mobile", "cortexai-agent-hub://hub-sso/"],
      ["mobile", "https://web.example.test/app"],
    ] as const)("refuses a %s returnTo of %j before asking Hub", async (client, returnTo) => {
      const f = fixture(undefined, { sso: true });
      const response = await f.startNative(client, { returnTo });
      expect(response.status).toBe(400);
      expect(f.client.lookup).not.toHaveBeenCalled();
      expect(f.client.ssoStart).not.toHaveBeenCalled();
      expect(f.data.verification).toHaveLength(0);
      expect(f.native()).toHaveLength(0);
    });

    it.each([
      ["a short challenge", { appChallenge: APP_CHALLENGE.slice(1) }],
      ["a long challenge", { appChallenge: `${APP_CHALLENGE}A` }],
      ["a padded challenge", { appChallenge: `${APP_CHALLENGE.slice(1)}=` }],
      ["a plain challenge", { appChallenge: "+".repeat(43) }],
      ["no challenge", { appChallenge: undefined }],
      ["an unknown client", { client: "web" }],
      ["no email", { email: "" }],
    ])("refuses %s", async (_case, body) => {
      const f = fixture(undefined, { sso: true });
      const response = await f.startNative("desktop", body);
      expect(response.status).toBe(400);
      expect(f.client.ssoStart).not.toHaveBeenCalled();
      expect(f.native()).toHaveLength(0);
    });

    it("refuses an untrusted origin", async () => {
      const f = fixture(undefined, { sso: true });
      const response = await f.request(
        "/hub/sso/native/start",
        "",
        {
          email: "entra@example.test",
          client: "desktop",
          returnTo: NATIVE_RETURN_TO.desktop,
          appChallenge: APP_CHALLENGE,
        },
        "https://evil.example",
      );
      expect(response.status).toBe(403);
      expect(f.client.ssoStart).not.toHaveBeenCalled();
    });

    it("answers the password step for native, Always Native and unknown users", async () => {
      const f = fixture(undefined, { sso: true });
      const ask = async () => {
        const response = await f.request(
          "/hub/sso/native/start",
          "",
          {
            email: "user@example.test",
            client: "mobile",
            returnTo: NATIVE_RETURN_TO.mobile,
            appChallenge: APP_CHALLENGE,
          },
          MOBILE_ORIGIN,
        );
        expect(response.headers.get("set-cookie")).toBeNull();
        return response.json();
      };
      expect(await ask()).toEqual({ next: "password" });
      f.client.lookup.mockResolvedValue({ tenant: config.tenantId, idpType: "entra" });
      f.client.ssoStart.mockRejectedValueOnce(new HubRequestError(400, "user_always_native"));
      expect(await ask()).toEqual({ next: "password" });
      f.client.lookup.mockRejectedValueOnce(new Error("Hub access denied"));
      expect(await ask()).toEqual({ next: "password" });
      f.client.lookup.mockResolvedValue({ tenant: config.tenantId, idpType: "google" });
      expect(await ask()).toEqual({ next: "other_sso_unavailable" });
      expect(f.data.verification).toHaveLength(0);
      expect(f.native()).toHaveLength(0);
    });

    it.each(["access_denied", "product_not_enabled", "tenant_mismatch"])(
      "refuses with an admin hint when Hub's start says %s",
      async (hubCode) => {
        const f = fixture(undefined, { sso: true });
        f.client.ssoStart.mockRejectedValue(new HubRequestError(403, hubCode));
        const response = await f.startNative();
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: HUB_SSO_ACCESS_DENIED });
        expect(f.native()).toHaveLength(0);
      },
    );

    it("refuses before asking Hub about the email when Hub policy fails", async () => {
      const f = fixture(undefined, { sso: true });
      f.hub.reply = async () => Promise.reject(new HubRequestError(503, "unavailable"));
      const response = await f.startNative();
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "HUB_UNAVAILABLE" });
      expect(f.client.lookup).not.toHaveBeenCalled();
      expect(f.native()).toHaveLength(0);
    });

    it("is not served while Hub SSO is off", async () => {
      const f = fixture();
      expect((await f.startNative()).status).toBe(404);
      expect(
        (await f.completeNative({ code, state: "s".repeat(43), appVerifier: APP_VERIFIER })).status,
      ).toBe(404);
    });

    it("removes expired native rows and revokes grants nobody redeemed", async () => {
      const f = fixture(undefined, { sso: true });
      const past = new Date(Date.now() - 1000);
      const grant = await symmetricEncrypt({
        key: encryptionKey,
        data: JSON.stringify({ refreshToken: "abandoned-refresh" }),
      });
      f.native().push(
        { stateKey: "hub-sso:a", grantCipher: grant, handoffHash: "a", expiresAt: past },
        { stateKey: "hub-sso:b", grantCipher: null, handoffHash: null, expiresAt: past },
        {
          stateKey: "hub-sso:c",
          grantCipher: null,
          handoffHash: null,
          expiresAt: new Date(Date.now() + 60_000),
        },
      );
      await f.startNative();
      expect(f.client.revoke).toHaveBeenCalledExactlyOnceWith("abandoned-refresh");
      expect(f.native().map((row) => row.stateKey)).toEqual([
        "hub-sso:c",
        expect.stringMatching(/^hub-sso:[0-9a-f]{64}$/),
      ]);
    });
  });

  describe("callback", () => {
    it.each(clients)("hands a %s app a one-time code instead of a session", async (client) => {
      const f = fixture(undefined, { sso: true });
      const { state, callback, location, handoff } = await signInNative(f, client);
      expect(callback.status).toBe(302);
      expect(callback.headers.get("cache-control")).toBe("no-store");
      expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
      expect(location).toBe(`${NATIVE_RETURN_TO[client]}?code=${handoff}&state=${state}`);
      expect(handoff).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(callback.headers.get("set-cookie") ?? "").not.toContain("session_token");
      expect(f.client.ssoExchange).toHaveBeenCalledOnce();
      expectNothingCreated(f);
      expect(f.data.verification).toHaveLength(0);
      const [row] = f.native();
      expect(row.handoffHash).toBe(sha256Hex(handoff));
      expect(JSON.stringify(row)).not.toContain(handoff);
      expect(JSON.stringify(row)).not.toContain("secret-1");
      const grant = JSON.parse(
        await symmetricDecrypt({ key: encryptionKey, data: row.grantCipher }),
      );
      expect(grant).toMatchObject({ refreshToken: "refresh-secret-1", subject: "subject-1" });
      expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
      expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(55_000);
    });

    it("keeps the web flow's cookie check while a native sign-in is pending", async () => {
      const f = fixture(undefined, { sso: true });
      await f.startNative();
      const web = await f.startSso();
      const withoutCookie = await f.callback(`code=${code}&state=${web.state}`);
      expect(withoutCookie.headers.get("location")).toBe(
        "https://web.example.test/sign-in?error=sso_expired",
      );
      expect(f.client.ssoExchange).not.toHaveBeenCalled();
      const signedIn = await f.callback(`code=${code}&state=${web.state}`, web.cookie);
      expect(signedIn.headers.get("location")).toBe("https://web.example.test/app");
      expect(f.native()).toEqual([expect.objectContaining({ handoffHash: null })]);
    });

    it.each(
      clients.flatMap((client) =>
        [
          // Hub found no Agent Hub assignment for the user.
          ["access_denied", "hub_access_denied"],
          // The user cancelled Microsoft sign-in.
          ["login_cancelled", "sso_cancelled"],
          ["server_error", "sso_failed"],
          ["", "sso_failed"],
        ].map(([hubError, error]) => [client, hubError, error] as const),
      ),
    )(
      "burns the sign-in and returns Hub's %s error=%j to the app as %s",
      async (client, hubError, error) => {
        const reasons: string[] = [];
        const f = fixture(undefined, {
          sso: true,
          onHubSsoError: (reason) => reasons.push(reason),
        });
        const start = await f.startNative(client);
        const { state } = (await start.json()) as { state: string };
        const response = await f.callback(
          `error=${hubError}&error_description=private%40example.test&state=${state}`,
        );
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(
          `${NATIVE_RETURN_TO[client]}?error=${error}&state=${state}`,
        );
        expect(reasons).toEqual([`callback:idp_error:${error}`]);
        expect(f.client.ssoExchange).not.toHaveBeenCalled();
        expect(f.data.verification).toHaveLength(0);
        expect(f.native()).toHaveLength(0);
        expectNothingCreated(f);
        // The state is burned, so a later success for it can't be finished.
        const late = await f.callback(`code=${code}&state=${state}`);
        expect(late.headers.get("location")).toBe(
          "https://web.example.test/sign-in?error=sso_expired",
        );
        expect(f.client.ssoExchange).not.toHaveBeenCalled();
        expectNothingCreated(f);
      },
    );

    it.each([
      [
        "a rejected exchange",
        { exchange: new HubRequestError(403, "access_denied") },
        "sso_failed",
      ],
      [
        "an exchange that cannot reach Hub",
        { exchange: new HubRequestError(503, "unavailable") },
        "hub_unavailable",
      ],
      ["a user Hub has not assigned", { assigned: ["subject-2"] }, "hub_access_denied"],
    ] as const)("sends %s back to the app, creating nothing", async (_case, setup, error) => {
      const f = fixture(undefined, {
        sso: true,
        ...("assigned" in setup ? { assigned: setup.assigned } : {}),
      });
      if ("exchange" in setup) f.client.ssoExchange.mockRejectedValue(setup.exchange);
      const { state, location } = await signInNative(f, "desktop");
      expect(location).toBe(`${NATIVE_RETURN_TO.desktop}?error=${error}&state=${state}`);
      expectNothingCreated(f);
      expect(f.native()[0]?.handoffHash ?? null).toBeNull();
      if ("assigned" in setup)
        expect(f.client.revoke).toHaveBeenCalledExactlyOnceWith("refresh-secret-1");
    });

    it("sends a Hub policy refusal at the callback back to the app before exchanging", async () => {
      const f = fixture(undefined, { sso: true });
      const start = await f.startNative();
      const { state } = (await start.json()) as { state: string };
      f.hub.reply = async () => Promise.reject(new HubRequestError(403, "tenant_disabled"));
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 6_000 });
      const response = await f.callback(`code=${code}&state=${state}`);
      vi.useRealTimers();
      expect(response.headers.get("location")).toBe(
        `${NATIVE_RETURN_TO.desktop}?error=tenant_disabled&state=${state}`,
      );
      expect(f.client.ssoExchange).not.toHaveBeenCalled();
      expectNothingCreated(f);
    });

    it("answers a replayed callback without a second exchange or a second code", async () => {
      const f = fixture(undefined, { sso: true });
      const { state, location } = await signInNative(f, "desktop");
      const replay = await f.callback(`code=${code}&state=${state}`);
      expect(replay.headers.get("location")).toBe(
        `${NATIVE_RETURN_TO.desktop}?error=sso_expired&state=${state}`,
      );
      expect(f.client.ssoExchange).toHaveBeenCalledOnce();
      expect(f.native()[0].handoffHash).toBe(
        sha256Hex(new URL(location).searchParams.get("code")!),
      );
    });

    it("keeps unknown and expired native states on the web error page", async () => {
      const f = fixture(undefined, { sso: true });
      const start = await f.startNative();
      const { state } = (await start.json()) as { state: string };
      f.native()[0].expiresAt = new Date(Date.now() - 1);
      for (const value of [state, "f".repeat(43)]) {
        const response = await f.callback(`code=${code}&state=${value}`);
        expect(response.headers.get("location")).toBe(
          "https://web.example.test/sign-in?error=sso_expired",
        );
      }
      expect(f.client.ssoExchange).not.toHaveBeenCalled();
    });
  });

  describe("complete", () => {
    it("signs the desktop renderer in with the HTTP-only session cookie", async () => {
      const f = fixture(undefined, { sso: true });
      const { state, handoff } = await signInNative(f, "desktop");
      const response = await f.completeNative({ code: handoff, state, appVerifier: APP_VERIFIER });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.text();
      expect(Object.keys(JSON.parse(body))).toEqual(["user"]);
      expect(JSON.parse(body).user.id).toBe(userId);
      expect(body).not.toContain(f.data.session![0]!.token);
      expect(body).not.toContain("secret-1");
      const cookie = response.headers
        .getSetCookie()
        .find((value) => value.includes("better-auth.session_token="))!;
      expect(cookie).toMatch(/HttpOnly/i);
      const signed = decodeURIComponent(/session_token=([^;]+)/.exec(cookie)![1]!);
      const session = await f.auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${signed}` }),
      });
      expect(session?.user.id).toBe(userId);
      expect(f.data.session).toHaveLength(1);
      expect(f.grants.size).toBe(1);
      expect(f.native()).toHaveLength(0);
    });

    it("gives the mobile app the same signed bearer as password sign-in", async () => {
      const f = fixture(undefined, { sso: true });
      const { state, handoff } = await signInNative(f, "mobile");
      const response = await f.completeNative(
        { code: handoff, state, appVerifier: APP_VERIFIER },
        "mobile",
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { token: string; user: { id: string } };
      expect(body.user.id).toBe(userId);
      expect(body.token.startsWith(`${f.data.session![0]!.token}.`)).toBe(true);
      const session = await f.auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${body.token}` }),
      });
      expect(session?.user.id).toBe(userId);
      expect(JSON.stringify(body)).not.toContain("secret-1");
    });

    it("signs the Entra user into the same hub_ row as password sign-in", async () => {
      const f = fixture(undefined, { sso: true });
      await f.login();
      const passwordRow = { ...f.data.user![0] };
      const { state, handoff } = await signInNative(f, "mobile");
      await f.completeNative({ code: handoff, state, appVerifier: APP_VERIFIER }, "mobile");
      expect(f.data.user).toEqual([passwordRow]);
      expect(f.data.session).toHaveLength(2);
    });

    it("refuses a replayed handoff without a second session", async () => {
      const f = fixture(undefined, { sso: true });
      const { state, handoff } = await signInNative(f, "desktop");
      const body = { code: handoff, state, appVerifier: APP_VERIFIER };
      expect((await f.completeNative(body)).status).toBe(200);
      const replay = await f.completeNative(body);
      expect(replay.status).toBe(400);
      expect(replay.headers.get("set-cookie") ?? "").not.toContain("session_token");
      expect(f.data.session).toHaveLength(1);
    });

    it("lets two concurrent redemptions create at most one session", async () => {
      const f = fixture(undefined, { sso: true });
      const { state, handoff } = await signInNative(f, "desktop");
      const body = { code: handoff, state, appVerifier: APP_VERIFIER };
      const statuses = (await Promise.all([f.completeNative(body), f.completeNative(body)])).map(
        (response) => response.status,
      );
      expect(statuses.sort()).toEqual([200, 400]);
      expect(f.data.session).toHaveLength(1);
    });

    it.each([
      ["a wrong appVerifier", (state: string) => ({ state, appVerifier: "b".repeat(43) })],
      ["another sign-in's state", (_state: string) => ({ state: "s".repeat(43) })],
    ])("burns the handoff on %s and revokes the grant", async (_case, wrong) => {
      const reasons: string[] = [];
      const f = fixture(undefined, { sso: true, onHubSsoError: (reason) => reasons.push(reason) });
      const { state, handoff } = await signInNative(f, "desktop");
      const attempt = await f.completeNative({
        code: handoff,
        appVerifier: APP_VERIFIER,
        ...wrong(state),
      });
      expect(attempt.status).toBe(400);
      expect(f.client.revoke).toHaveBeenCalledExactlyOnceWith("refresh-secret-1");
      const retry = await f.completeNative({ code: handoff, state, appVerifier: APP_VERIFIER });
      expect(retry.status).toBe(400);
      expectNothingCreated(f);
      expect(f.native()).toHaveLength(0);
      expect(reasons).toEqual(["complete:mismatch", "complete:unknown"]);
    });

    it("expires the handoff 60 seconds after the callback", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const f = fixture(undefined, { sso: true });
        const early = await signInNative(f, "desktop");
        const late = await signInNative(f, "desktop");
        vi.setSystemTime(Date.now() + 59_999);
        const inTime = await f.completeNative({
          code: early.handoff,
          state: early.state,
          appVerifier: APP_VERIFIER,
        });
        expect(inTime.status).toBe(200);
        vi.setSystemTime(Date.now() + 1);
        const expired = await f.completeNative({
          code: late.handoff,
          state: late.state,
          appVerifier: APP_VERIFIER,
        });
        expect(expired.status).toBe(400);
        expect(f.data.session).toHaveLength(1);
        expect(f.client.revoke).toHaveBeenCalledExactlyOnceWith("refresh-secret-1");
      } finally {
        vi.useRealTimers();
      }
    });

    it.each<[string, Record<string, unknown> | undefined]>([
      ["an empty body", undefined],
      ["a short code", { code: "c".repeat(42) }],
      ["a non-base64url code", { code: `${"c".repeat(42)}+` }],
      ["a short state", { state: "s".repeat(15) }],
      ["a short verifier", { appVerifier: "v".repeat(42) }],
      ["a non-string verifier", { appVerifier: 1 }],
    ])("refuses %s without spending the handoff", async (_case, override) => {
      const f = fixture(undefined, { sso: true });
      const { state, handoff } = await signInNative(f, "desktop");
      const response = await f.completeNative(
        override ? { code: handoff, state, appVerifier: APP_VERIFIER, ...override } : {},
      );
      expect(response.status).toBe(400);
      expect(f.native()).toHaveLength(1);
      expect(f.data.session).toHaveLength(0);
    });

    it("refuses an untrusted origin without spending the handoff", async () => {
      const f = fixture(undefined, { sso: true });
      const { state, handoff } = await signInNative(f, "desktop");
      const response = await f.request(
        "/hub/sso/native/complete",
        "",
        { code: handoff, state, appVerifier: APP_VERIFIER },
        "https://evil.example",
      );
      expect(response.status).toBe(403);
      expect(f.native()).toHaveLength(1);
    });

    it("refuses with the policy code when Hub stops the user before the app redeems", async () => {
      const f = fixture(undefined, { sso: true });
      const { state, handoff } = await signInNative(f, "mobile");
      f.hub.reply = async () => Promise.reject(new HubRequestError(403, "tenant_disabled"));
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 6_000 });
      const response = await f.completeNative(
        { code: handoff, state, appVerifier: APP_VERIFIER },
        "mobile",
      );
      vi.useRealTimers();
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "TENANT_DISABLED" });
      expect(f.client.revoke).toHaveBeenCalledExactlyOnceWith("refresh-secret-1");
      expectNothingCreated(f);
    });

    it("revokes the grant when the session cannot be created", async () => {
      const f = fixture(undefined, { sso: true });
      f.prisma.hubSession.create = async () => {
        throw new Error("database unavailable");
      };
      const { state, handoff } = await signInNative(f, "desktop");
      const response = await f.completeNative({ code: handoff, state, appVerifier: APP_VERIFIER });
      expect(response.status).toBe(401);
      expect(f.client.revoke).toHaveBeenCalledExactlyOnceWith("refresh-secret-1");
      expect(f.data.session).toHaveLength(0);
    });
  });

  it("never logs or returns handoff codes, verifiers, state, tokens or email", async () => {
    const reasons: string[] = [];
    const logged: unknown[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args) => void logged.push(...args)),
    );
    const visible: string[] = [];
    let secrets: string[] = [];
    try {
      const f = fixture(undefined, { sso: true, onHubSsoError: (reason) => reasons.push(reason) });
      const keep = async (response: Response) => {
        visible.push(await response.clone().text());
        return response;
      };
      const start = await keep(await f.startNative("mobile", { email: "private@example.test" }));
      const { state } = (await start.json()) as { state: string };
      const verifier = await symmetricDecrypt({
        key: encryptionKey,
        data: f.data.verification![0].value,
      });
      const callback = await f.callback(`code=${code}&state=${state}`);
      const location = callback.headers.get("location")!;
      const handoff = new URL(location).searchParams.get("code")!;
      await keep(await f.completeNative({ code: handoff, state, appVerifier: "w".repeat(43) }));
      await keep(await f.completeNative({ code: handoff, state, appVerifier: APP_VERIFIER }));
      const second = await signInNative(f, "mobile");
      await keep(
        await f.completeNative(
          { code: second.handoff, state: second.state, appVerifier: APP_VERIFIER },
          "mobile",
        ),
      );
      f.client.ssoExchange.mockRejectedValueOnce(new HubRequestError(400, "invalid_verifier"));
      const third = await signInNative(f, "mobile");
      visible.push(third.location.replace(third.state, ""));
      secrets = [
        handoff,
        second.handoff,
        verifier,
        APP_VERIFIER,
        "private@example.test",
        "access-secret-1",
        "refresh-secret-1",
        ssoConfig.sso.secret,
      ];
      expect(location).not.toContain("secret-1");
      expect(second.location).not.toContain("secret-1");
      // State only travels in the redirects; logs and bodies other than start's never carry it.
      expect(
        JSON.stringify([...logged.map(String), ...reasons, ...visible.slice(1)]),
      ).not.toContain(state);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(reasons).toEqual([
      "complete:mismatch",
      "complete:unknown",
      "callback:exchange:invalid_verifier",
    ]);
    const output = JSON.stringify([...logged.map(String), ...reasons]);
    for (const secret of secrets) expect(output).not.toContain(secret);
    for (const secret of secrets.slice(2)) expect(JSON.stringify(visible)).not.toContain(secret);
  });

  describe.each(clients)("contract fixture agent-hub-native-sso.v1 (%s)", (client) => {
    const contract = nativeContract.clients[client];
    it("accepts the documented start and complete requests and answers their shapes", async () => {
      const f = fixture(undefined, { sso: true });
      f.client.lookup.mockResolvedValue({ tenant: config.tenantId, idpType: "entra" });
      const origin = client === "mobile" ? contract.origin : "https://web.example.test";
      const start = await f.request(
        nativeContract.startPath.replace("/api/auth", ""),
        "",
        contract.startRequest,
        origin,
      );
      expect(start.status).toBe(200);
      const started = (await start.json()) as Record<string, string>;
      expect(Object.keys(started).sort()).toEqual(Object.keys(nativeContract.startResponse).sort());
      expect(started.next).toBe(nativeContract.startResponse.next);
      expect(nativeContract.appChallenge).toBe(
        createHash("sha256").update(nativeContract.appVerifier).digest("base64url"),
      );
      expect(nativeContract.callbackPath).toBe("/api/auth/hub/sso/callback");
      const callback = await f.callback(`code=${code}&state=${started.state}`);
      const location = new URL(callback.headers.get("location")!);
      expect(`${location.protocol}//${location.host}${location.pathname}`).toBe(
        contract.startRequest.returnTo,
      );
      expect([...location.searchParams.keys()]).toEqual(["code", "state"]);
      expect(f.native()[0].expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
        nativeContract.handoffTtlSeconds * 1000,
      );
      const complete = await f.request(
        nativeContract.completePath.replace("/api/auth", ""),
        "",
        {
          code: location.searchParams.get("code"),
          state: location.searchParams.get("state"),
          appVerifier: nativeContract.completeRequest.appVerifier,
        },
        origin,
      );
      expect(complete.status).toBe(200);
      expect(Object.keys((await complete.json()) as object).sort()).toEqual(
        [...contract.completeResponseKeys].sort(),
      );
      expect(complete.headers.get("set-cookie") ?? "").toContain("session_token=");
    });

    it.each(Object.entries(nativeContract.hubCallbackErrors))(
      "returns Hub's callback error=%s to the app as %s",
      async (hubError, error) => {
        const f = fixture(undefined, { sso: true });
        f.client.lookup.mockResolvedValue({ tenant: config.tenantId, idpType: "entra" });
        const origin = client === "mobile" ? contract.origin : "https://web.example.test";
        const start = await f.request(
          nativeContract.startPath.replace("/api/auth", ""),
          "",
          contract.startRequest,
          origin,
        );
        const { state } = (await start.json()) as { state: string };
        const callback = await f.callback(`error=${hubError}&state=${state}`);
        expect(callback.headers.get("location")).toBe(
          `${contract.startRequest.returnTo}?error=${error}&state=${state}`,
        );
      },
    );
  });
});

describe("Hub policy gate on every sign-in path (CAAH-36)", () => {
  const branded = "Sign-in is temporarily unavailable, CortexAI Hub can't be reached";
  const code = "c".repeat(43);
  const dnsFailure = () =>
    Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  const timeout = () =>
    new DOMException("The operation was aborted due to timeout", "TimeoutError");
  type Reply = Awaited<ReturnType<ReturnType<typeof hubPolicyForTests>["hub"]["reply"]>>;
  const failures: Array<[string, () => Promise<Reply>, string, number]> = [
    ["Hub DNS failure", async () => Promise.reject(dnsFailure()), "HUB_UNAVAILABLE", 503],
    ["Hub timeout", async () => Promise.reject(timeout()), "HUB_UNAVAILABLE", 503],
    [
      "Hub 5xx",
      async () => Promise.reject(new HubRequestError(503, "unavailable")),
      "HUB_UNAVAILABLE",
      503,
    ],
    [
      "malformed config",
      async () => ({ status: 200, body: { schemaVersion: "agent-hub-settings-v1" } }),
      "HUB_CONFIG_INVALID",
      503,
    ],
    [
      "cross-tenant config",
      async () => ({ status: 200, body: hubPolicyBodyForTests("tenant-2", ["subject-1"]) }),
      "HUB_CONFIG_INVALID",
      503,
    ],
    [
      "disabled tenant",
      async () => Promise.reject(new HubRequestError(403, "tenant_disabled")),
      "TENANT_DISABLED",
      403,
    ],
    [
      "rejected service credential",
      async () => Promise.reject(new HubRequestError(401, "invalid_credentials")),
      "HUB_CREDENTIAL_INVALID",
      503,
    ],
  ];

  async function expectRefused(response: Response, expected: string, status: number) {
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie") ?? "").not.toContain("session_token");
    expect(await response.json()).toMatchObject({ code: expected, message: branded });
  }

  describe.each(failures)("when Hub policy fails with %s", (_case, reply, expected, status) => {
    it("refuses email-first Continue before asking Hub about the email", async () => {
      const f = fixture();
      f.hub.reply = reply;
      const response = await f.request("/hub/sign-in/continue", "", { email: "user@example.test" });
      await expectRefused(response, expected, status);
      expect(f.client.lookup).not.toHaveBeenCalled();
    });

    it("refuses Microsoft SSO start without a state cookie or pending row", async () => {
      const f = fixture(undefined, { sso: true });
      f.hub.reply = reply;
      const { response } = await f.startSso();
      await expectRefused(response, expected, status);
      expect(f.client.ssoStart).not.toHaveBeenCalled();
      expect(f.data.verification).toHaveLength(0);
    });

    it.each([
      ["web", undefined],
      ["mobile", MOBILE_ORIGIN],
    ])("refuses password sign-in from %s without creating a session", async (_client, origin) => {
      const f = fixture();
      f.hub.reply = reply;
      const response = await f.request(
        "/hub/sign-in",
        "",
        { email: "user@example.test", password: "test-password" },
        origin,
      );
      await expectRefused(response, expected, status);
      expect(f.client.login).not.toHaveBeenCalled();
      expect(f.data.session).toHaveLength(0);
      expect(f.data.user).toHaveLength(0);
    });

    it("refuses the SSO callback before exchanging the code", async () => {
      const f = fixture(undefined, { sso: true });
      const { state, cookie } = await f.startSso();
      f.hub.reply = reply;
      // The user spends longer at Microsoft than sign-in reuses Hub's last answer.
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 6_000 });
      const response = await f.callback(`code=${code}&state=${state}`, cookie);
      vi.useRealTimers();
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        `https://web.example.test/sign-in?error=${expected.toLowerCase()}`,
      );
      expect(f.client.ssoExchange).not.toHaveBeenCalled();
      expect(f.data.session).toHaveLength(0);
      expect(f.data.user).toHaveLength(0);
    });
  });

  it("admits sign-in again as soon as Hub returns", async () => {
    const f = fixture();
    const healthy = f.hub.reply;
    f.hub.reply = async () => Promise.reject(dnsFailure());
    await expectRefused(
      await f.request("/hub/sign-in", "", { email: "user@example.test", password: "x" }),
      "HUB_UNAVAILABLE",
      503,
    );
    f.hub.reply = healthy;
    await f.login();
    expect(f.data.session).toHaveLength(1);
  });

  it.each([
    ["a connection failure", dnsFailure()],
    ["a timeout", timeout()],
    ["a Hub 502", new HubRequestError(502, "bad_gateway")],
  ])("answers HUB_UNAVAILABLE when the password exchange itself hits %s", async (_case, error) => {
    const f = fixture();
    f.client.login.mockRejectedValue(error);
    await expectRefused(
      await f.request("/hub/sign-in", "", { email: "user@example.test", password: "x" }),
      "HUB_UNAVAILABLE",
      503,
    );
  });

  it("keeps the ordinary refusal for a wrong password", async () => {
    const f = fixture();
    f.client.login.mockRejectedValue(new HubRequestError(401, "invalid_credentials"));
    const response = await f.request("/hub/sign-in", "", {
      email: "user@example.test",
      password: "wrong",
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      message: "Could not sign in through CortexAI Hub",
    });
  });

  it("sends an SSO callback whose exchange cannot reach Hub to hub_unavailable", async () => {
    const f = fixture(undefined, { sso: true });
    f.client.ssoExchange.mockRejectedValue(dnsFailure());
    const { state, cookie } = await f.startSso();
    const response = await f.callback(`code=${code}&state=${state}`, cookie);
    expect(response.headers.get("location")).toBe(
      "https://web.example.test/sign-in?error=hub_unavailable",
    );
    expect(f.data.session).toHaveLength(0);
  });

  it("refuses a password user Hub has not assigned to Agent Hub, creating nothing", async () => {
    const f = fixture(undefined, { assigned: ["subject-2"] });
    const response = await f.request("/hub/sign-in", "", {
      email: "user@example.test",
      password: "test-password",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "HUB_ACCESS_DENIED",
      message: "Ask your admin for access",
    });
    // F6: the grant Hub just issued is revoked, as on the SSO path.
    expect(f.client.revoke).toHaveBeenCalledExactlyOnceWith("refresh-secret-1");
    expect(f.data.session).toHaveLength(0);
    expect(f.data.user).toHaveLength(0);
  });

  it("refuses an unassigned SSO user and revokes the grant Hub issued", async () => {
    const f = fixture(undefined, { sso: true, assigned: ["subject-2"] });
    const { state, cookie } = await f.startSso();
    const response = await f.callback(`code=${code}&state=${state}`, cookie);
    expect(response.headers.get("location")).toBe(
      "https://web.example.test/sign-in?error=hub_access_denied",
    );
    expect(f.client.revoke).toHaveBeenCalledExactlyOnceWith("refresh-secret-1");
    expect(f.data.session).toHaveLength(0);
    expect(f.data.user).toHaveLength(0);
  });

  it("refuses a grant for another tenant even when its subject is assigned", async () => {
    const f = fixture();
    f.client.login.mockResolvedValue({
      subject: "subject-1",
      tenant: "tenant-2",
      accessToken: "access-secret-1",
      refreshToken: "refresh-secret-1",
      accessUntil: new Date(Date.now() + 900_000),
    });
    const response = await f.request("/hub/sign-in", "", {
      email: "user@example.test",
      password: "test-password",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "HUB_ACCESS_DENIED" });
    expect(f.data.session).toHaveLength(0);
  });

  it("lets a user in while assignments are pending (CAH-204) but grants no work", async () => {
    const f = fixture(undefined, { assigned: [] });
    await f.login();
    expect(await f.work(userId)).toBe(false);
    expect(await f.policy.status()).toMatchObject({ state: "ok", assignments: "pending" });
  });

  it("refuses password sign-in when Hub's assignment contract lists nobody", async () => {
    const f = fixture(undefined, { assigned: [], contract: true });
    const response = await f.request("/hub/sign-in", "", {
      email: "user@example.test",
      password: "test-password",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "HUB_ACCESS_DENIED",
      message: "Ask your admin for access",
    });
    expect(f.data.session).toHaveLength(0);
    expect(f.data.user).toHaveLength(0);
  });

  it("refuses SSO sign-in when Hub's assignment contract lists nobody", async () => {
    const f = fixture(undefined, { sso: true, assigned: [], contract: true });
    const { state, cookie } = await f.startSso();
    const response = await f.callback(`code=${code}&state=${state}`, cookie);
    expect(response.headers.get("location")).toBe(
      "https://web.example.test/sign-in?error=hub_access_denied",
    );
    expect(f.client.revoke).toHaveBeenCalledExactlyOnceWith("refresh-secret-1");
    expect(f.data.session).toHaveLength(0);
    expect(f.data.user).toHaveLength(0);
  });

  it("admits only the users Hub's assignment contract lists", async () => {
    const listed = fixture(undefined, { assigned: ["subject-1"], contract: true });
    await listed.login();
    expect(await listed.work(userId)).toBe(true);
    const unlisted = fixture(undefined, { assigned: ["subject-2"], contract: true });
    const response = await unlisted.request("/hub/sign-in", "", {
      email: "user@example.test",
      password: "test-password",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "HUB_ACCESS_DENIED" });
    expect(unlisted.data.session).toHaveLength(0);
  });

  it("refuses sign-in until both processes restart onto a changed startup setting", async () => {
    const store = memoryHubPolicyStore();
    let body = hubPolicyBodyForTests(config.tenantId, ["subject-1"], 1);
    const fetchConfig = async () => ({ status: 200 as const, body });
    const applied = await applyHubPolicyAtStartup({
      store,
      tenantId: config.tenantId,
      env: {},
      fetchConfig,
      log: () => undefined,
    });
    const policy = createHubPolicy({
      store,
      tenantId: config.tenantId,
      fetchConfig,
      applied,
      log: () => undefined,
    });
    const f = fixture(undefined, { policy });
    await f.login();
    body = {
      ...hubPolicyBodyForTests(config.tenantId, ["subject-1"], 2),
      overrides: { autoReview: { defaultEnabled: true } },
    };
    await policy.refresh();
    const response = await f.request("/hub/sign-in", "", {
      email: "user@example.test",
      password: "test-password",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "HUB_CONFIG_RESTART_REQUIRED",
      message: branded,
    });
    expect(await f.work(userId)).toBe(false);
  });

  it("never sends Hub-delivered secrets to the browser", async () => {
    const store = memoryHubPolicyStore();
    const body = {
      ...hubPolicyBodyForTests(config.tenantId, ["subject-1"], 3),
      overrides: { model: { credentials: { anthropic: "hub-model-secret-not-real" } } },
    };
    const fetchConfig = async () => ({ status: 200 as const, body });
    const env: NodeJS.ProcessEnv = {};
    const applied = await applyHubPolicyAtStartup({
      store,
      tenantId: config.tenantId,
      env,
      fetchConfig,
      log: () => undefined,
    });
    const policy = createHubPolicy({
      store,
      tenantId: config.tenantId,
      fetchConfig,
      applied,
      log: () => undefined,
    });
    const f = fixture(undefined, { policy });
    const continued = await f.request("/hub/sign-in/continue", "", { email: "user@example.test" });
    const { response, headers } = await f.login();
    const session = await f.auth.api.getSession({ headers });
    for (const text of [await continued.text(), await response.text(), JSON.stringify(session)])
      expect(text).not.toContain("hub-model-secret-not-real");
    expect(JSON.stringify(await policy.status())).not.toContain("hub-model-secret-not-real");
  });
});

describe("Hub mode started without its tenant or service credential (F1)", () => {
  const branded = "Sign-in is temporarily unavailable, CortexAI Hub can't be reached";
  const notConfigured: HubAuthConfig = {
    origin: config.origin,
    notConfigured: {
      missing: [
        { name: "HUB_AUTH_TENANT_ID", problem: "unset" },
        { name: "HUB_SERVICE_SECRET_FILE", problem: "unset" },
      ],
    },
  };
  async function expectNotConfigured(response: Response) {
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie") ?? "").not.toContain("session_token");
    const body = await response.json();
    expect(body).toMatchObject({ code: "HUB_NOT_CONFIGURED", message: branded });
    expect(JSON.stringify(body)).not.toContain("HUB_AUTH_TENANT_ID");
  }

  it("refuses email-first Continue without asking Hub", async () => {
    const f = fixture(undefined, { hub: notConfigured });
    await expectNotConfigured(
      await f.request("/hub/sign-in/continue", "", { email: "user@example.test" }),
    );
    expect(f.client.lookup).not.toHaveBeenCalled();
  });

  it.each([
    ["web", undefined],
    ["mobile", MOBILE_ORIGIN],
  ])("refuses password sign-in from %s and creates nothing", async (_client, origin) => {
    const f = fixture(undefined, { hub: notConfigured });
    const response = await f.request(
      "/hub/sign-in",
      "",
      { email: "user@example.test", password: "test-password" },
      origin,
    );
    await expectNotConfigured(response);
    expect(f.client.login).not.toHaveBeenCalled();
    expect(f.data.session).toHaveLength(0);
    expect(f.data.user).toHaveLength(0);
  });

  it("refuses even when a working policy is passed, because the config wins", async () => {
    const f = fixture(undefined, {
      hub: notConfigured,
      policy: hubPolicyForTests("tenant-1").policy,
    });
    await expectNotConfigured(
      await f.request("/hub/sign-in", "", {
        email: "user@example.test",
        password: "test-password",
      }),
    );
    expect(f.client.login).not.toHaveBeenCalled();
  });

  it("keeps local email sign-up and sign-in closed", async () => {
    const f = fixture(undefined, { hub: notConfigured });
    for (const path of ["/sign-in/email", "/sign-up/email"]) {
      const response = await f.request(path, "", {
        email: "local@example.test",
        password: "local-password-1",
        name: "Local",
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(f.data.user).toHaveLength(0);
    expect(f.data.session).toHaveLength(0);
  });

  it("admits no existing session and no work", async () => {
    const f = fixture();
    await f.login();
    const sessionId = f.data.session![0]!.id;
    const authorize = createHubSessionAuthorizer(f.prisma, notConfigured, encryptionKey, f.client, {
      policy: f.policy,
    });
    expect(await authorize(sessionId, userId)).toBe(false);
    expect(f.client.verify).not.toHaveBeenCalled();
    const work = createUserWorkAuthorizer(f.prisma, notConfigured, encryptionKey, {
      policy: f.policy,
    });
    expect(await work(userId)).toBe(false);
    expect(f.data.session).toHaveLength(1);
  });
});

describe("Hub mode with policy enforcement off (CAAH-83)", () => {
  const disabled: HubAuthConfig = { origin: config.origin, policyDisabled: true };
  // A policy that refuses everything: the config wins, as it does when not configured.
  const refusing = () =>
    notConfiguredHubPolicy({ missing: ["HUB_AUTH_TENANT_ID", "HUB_SERVICE_SECRET_FILE"] });

  it("signs a Hub user in with no Hub registration, without reading Hub policy", async () => {
    const f = fixture(undefined, { hub: disabled, policy: refusing() });
    const continued = await f.request("/hub/sign-in/continue", "", { email: "user@example.test" });
    expect(await continued.json()).toEqual({ next: "password" });
    const { headers } = await f.login();
    expect((await f.auth.api.getSession({ headers }))?.user.id).toBe(userId);
    expect(f.client.verify).toHaveBeenCalled();
    expect(f.client.serviceConfig).not.toHaveBeenCalled();
  });

  it("runs work for a signed-in Hub user and still never for local users", async () => {
    const f = fixture(undefined, { hub: disabled, policy: refusing() });
    expect(await f.work(userId)).toBe(false);
    await f.login();
    expect(await f.work(userId)).toBe(true);
    expect(await f.work("local-user")).toBe(false);
  });

  it("still requires Hub login and current entitlement", async () => {
    const f = fixture(undefined, { hub: disabled });
    f.client.login.mockRejectedValueOnce(new HubRequestError(403, "access_denied"));
    const refused = await f.request("/hub/sign-in", "", {
      email: "user@example.test",
      password: "test-password",
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(f.data.session).toHaveLength(0);
    const { headers } = await f.login();
    f.client.verify.mockRejectedValue(new Error("entitlement removed"));
    expect(await f.auth.api.getSession({ headers })).toBeNull();
    expect(await f.work(userId)).toBe(false);
  });

  it("refuses another tenant with HUB_ACCESS_DENIED when a tenant is pinned, creating nothing", async () => {
    const f = fixture(undefined, { hub: { ...disabled, tenantId: "tenant-2" } });
    const response = await f.request("/hub/sign-in", "", {
      email: "user@example.test",
      password: "test-password",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "HUB_ACCESS_DENIED" });
    expect(f.data.session).toHaveLength(0);
    expect(f.data.user).toHaveLength(0);
  });
});

describe("Active sessions while Hub policy is degraded (CAAH-36)", () => {
  async function signedIn() {
    const f = fixture();
    const { headers } = await f.login();
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(await f.auth.api.getSession({ headers })).not.toBeNull();
    return { f, headers };
  }
  afterEach(() => vi.useRealTimers());

  it("keeps last-known-good within the CAAH-40 window, then fails closed until Hub returns", async () => {
    const { f, headers } = await signedIn();
    expect(await f.work(userId)).toBe(true);
    const healthy = f.hub.reply;
    f.hub.reply = async () => Promise.reject(new HubRequestError(503, "unavailable"));
    await f.policy.refresh();
    vi.setSystemTime(Date.now() + 29_000);
    expect(await f.auth.api.getSession({ headers })).not.toBeNull();
    expect(await f.work(userId)).toBe(true);
    vi.setSystemTime(Date.now() + 1_001);
    expect(await f.auth.api.getSession({ headers })).toBeNull();
    expect(await f.work(userId)).toBe(false);
    // Policy refusal is not a Hub revocation: the session comes back with Hub.
    expect(f.data.session).toHaveLength(1);
    f.hub.reply = healthy;
    await f.policy.refresh();
    expect(await f.auth.api.getSession({ headers })).not.toBeNull();
  });

  it("stops new work at once when Hub disables the tenant, and the session after the window", async () => {
    const { f, headers } = await signedIn();
    f.hub.reply = async () => Promise.reject(new HubRequestError(403, "tenant_disabled"));
    await f.policy.refresh();
    expect(await f.work(userId)).toBe(false);
    vi.setSystemTime(Date.now() + 30_001);
    expect(await f.auth.api.getSession({ headers })).toBeNull();
  });

  it("drops the session after the window when Hub removes the user's assignment", async () => {
    const { f, headers } = await signedIn();
    f.hub.reply = async () => ({
      status: 200,
      body: hubPolicyBodyForTests(config.tenantId, ["subject-2"], 2),
    });
    await f.policy.refresh();
    expect(await f.work(userId)).toBe(false);
    vi.setSystemTime(Date.now() + 30_001);
    expect(await f.auth.api.getSession({ headers })).toBeNull();
  });

  it("removes work at once and the session after the window when Hub's marked list empties", async () => {
    const { f, headers } = await signedIn();
    expect(await f.work(userId)).toBe(true);
    f.hub.reply = async () => ({
      status: 200,
      body: hubPolicyBodyForTests(config.tenantId, [], 2, { contract: true }),
    });
    await f.policy.refresh();
    expect(await f.work(userId)).toBe(false);
    vi.setSystemTime(Date.now() + 29_000);
    expect(await f.auth.api.getSession({ headers })).not.toBeNull();
    vi.setSystemTime(Date.now() + 1_001);
    expect(await f.auth.api.getSession({ headers })).toBeNull();
  });

  it("drops a pending session after the window when Hub's first marked list is empty", async () => {
    const f = fixture(undefined, { assigned: [] });
    const { headers } = await f.login();
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(await f.auth.api.getSession({ headers })).not.toBeNull();
    expect(await f.policy.status()).toMatchObject({ assignments: "pending" });
    f.hub.reply = async () => ({
      status: 200,
      body: hubPolicyBodyForTests(config.tenantId, [], 2, { contract: true }),
    });
    await f.policy.refresh();
    expect(await f.policy.status()).toMatchObject({ state: "ok", assignments: "configured" });
    expect(await f.work(userId)).toBe(false);
    vi.setSystemTime(Date.now() + 30_001);
    expect(await f.auth.api.getSession({ headers })).toBeNull();
  });

  it("checks policy again when an expired access token is refreshed", async () => {
    const { f, headers } = await signedIn();
    f.hub.reply = async () => Promise.reject(new HubRequestError(403, "tenant_disabled"));
    await f.policy.refresh();
    [...f.grants.values()][0].accessUntil = new Date(0);
    expect(await f.auth.api.getSession({ headers })).toBeNull();
    expect(f.client.refresh).toHaveBeenCalledOnce();
  });

  it("refuses work for a user with no Hub session or no stored policy", async () => {
    const f = fixture();
    expect(await f.work(userId)).toBe(false);
    expect(await f.work("local-user")).toBe(false);
  });
});
