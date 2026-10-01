import { createHash } from "node:crypto";
import { bootstrapUserSpace } from "@cortexai-agent-hub/db";
import { symmetricDecrypt } from "better-auth/crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HUB_SIGN_IN_RATE_LIMITS } from "./hub.js";
import {
  createHubClient,
  HubRequestError,
  HubUnsupportedIdpError,
  hubUserId,
} from "./hub-client.js";
import { createUserWorkAuthorizer } from "./hub-sessions.js";
import { createAuth } from "./index.js";

vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return {
    prismaAdapter: (prisma: { authData: Record<string, unknown[]> }) =>
      memoryAdapter(prisma.authData),
  };
});
vi.mock("@cortexai-agent-hub/db", () => ({
  bootstrapUserSpace: vi.fn(async () => ({ spaceId: "space-1" })),
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
const authorizeUrl = "https://login.microsoftonline.com/synthetic-tenant/oauth2/v2.0/authorize";
function fixture(
  hubClient?: ReturnType<typeof createHubClient>,
  options: { sso?: boolean; onHubSsoError?: (reason: string) => void } = {},
) {
  const data: Record<string, any[]> = { user: [], account: [], session: [], verification: [] };
  const identities = new Map<string, any>();
  const grants = new Map<string, any>();
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
  };
  const web = options.sso ? "https://web.example.test" : "http://web.example.test";
  const auth = createAuth(prisma, {
    secret: "offline-auth-secret-at-least-32-characters",
    tokenEncryptionKey: encryptionKey,
    baseURL: web,
    webOrigin: web,
    hub: options.sso ? ssoConfig : config,
    signupsEnabled: "true",
    signupAllowlist: "",
    onHubSsoError: options.onHubSsoError,
  });
  const request = (path: string, cookie = "", body?: unknown) =>
    auth.handler(
      new Request(`${web}/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers: { cookie, origin: web, "content-type": "application/json" },
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
    const token = data.session![0]!.token;
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
  return { auth, request, login, startSso, callback, data, identities, grants, client, prisma };
}

beforeEach(() => vi.clearAllMocks());

describe("Hub authentication through real auth endpoints", () => {
  it("requires an active Hub grant for background work and never falls back to native users", async () => {
    const f = fixture();
    const authorize = createUserWorkAuthorizer(f.prisma, config, encryptionKey);
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
      { claimDeploymentOwner: false },
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
    const post = (path: string, forwardedFor: string, body: unknown) =>
      f.auth.handler(
        new Request(`https://web.example.test/api/auth${path}`, {
          method: "POST",
          headers: {
            origin: "https://web.example.test",
            "content-type": "application/json",
            "x-forwarded-for": forwardedFor,
          },
          body: JSON.stringify(body),
        }),
      );
    return { f, post };
  }

  it.each([
    ["/hub/sign-in", { email: "user@example.test", password: "test-password" }, "203.0.113.1"],
    ["/hub/sign-in/continue", { email: "user@example.test" }, "203.0.113.3"],
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
      headers: new Headers({ authorization: `Bearer ${token}` }),
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

  it("drops an SSO session within the verify TTL after Hub disables the user", async () => {
    const f = fixture(undefined, { sso: true });
    const { state, cookie } = await f.startSso();
    await f.callback(`code=${code}&state=${state}`, cookie);
    const headers = new Headers({ authorization: `Bearer ${f.data.session![0]!.token}` });
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
      await f.auth.api.signOut({ headers: new Headers({ authorization: `Bearer ${token}` }) });
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
