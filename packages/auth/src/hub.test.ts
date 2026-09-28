import { bootstrapUserSpace } from "@cortexai-agent-hub/db";
import { symmetricDecrypt } from "better-auth/crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHubClient, HubUnsupportedIdpError, hubUserId } from "./hub-client.js";
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
function fixture(hubClient?: ReturnType<typeof createHubClient>) {
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
  };
  const auth = createAuth(prisma, {
    secret: "offline-auth-secret-at-least-32-characters",
    tokenEncryptionKey: encryptionKey,
    baseURL: "http://web.example.test",
    webOrigin: "http://web.example.test",
    hub: config,
    signupsEnabled: "true",
    signupAllowlist: "",
  });
  const request = (path: string, cookie = "", body?: unknown) =>
    auth.handler(
      new Request(`http://web.example.test/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers: { cookie, origin: "http://web.example.test", "content-type": "application/json" },
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
  return { auth, request, login, data, identities, grants, client, prisma };
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
