import type { TransactionalEmail } from "@cortexai-agent-hub/adapter-kit";
import { bootstrapUserSpace } from "@cortexai-agent-hub/db";
import { hashPassword } from "better-auth/crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "./index.js";

// Exercise Better Auth's real routing, password hashing, verification and
// session hooks with its official offline adapter. Only persistence is faked.
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

const PASSWORD = "offline-password12";

/**
 * CAAH-43: there is no signup. Accounts exist because an operator provisioned
 * them (verified, with a space) or because they were admitted before the
 * upgrade. `policy` is a legacy deployment_settings row; nothing may read it
 * to reopen signup.
 */
function fixture({
  allowlist = "",
  signupsEnabled = true,
  delivery = true,
  baseURL = "http://auth.example.test",
  webOrigin = "http://web.example.test",
  requestOrigin,
}: {
  allowlist?: string;
  signupsEnabled?: boolean;
  delivery?: boolean;
  baseURL?: string;
  webOrigin?: string;
  requestOrigin?: string;
} = {}) {
  const data: Record<string, Record<string, unknown>[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
  };
  const policy = {
    signupsEnabled,
    signupAllowlist: allowlist,
    signupPolicyInitialized: true,
    ownerUserId: null as string | null,
  };
  const messages: TransactionalEmail[] = [];
  const members = new Set<string>();
  const prisma = {
    authData: data,
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (run: ((tx: unknown) => Promise<unknown>) | Promise<unknown>[]) =>
      Array.isArray(run) ? Promise.all(run) : run(prisma),
    ),
    deploymentSettings: {
      findUnique: vi.fn(async () => policy),
      updateMany: vi.fn(async ({ data: patch }: { data: { ownerUserId: string | null } }) => {
        policy.ownerUserId = patch.ownerUserId;
        return { count: 1 };
      }),
    },
    member: { findMany: vi.fn(async () => []) },
    messagingIdentity: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    organization: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    spaceMember: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string } }) =>
        members.has(where.userId) ? { id: `member-${where.userId}` } : null,
      ),
    },
  };
  const auth = createAuth(prisma as never, {
    secret: "offline-auth-secret-at-least-32-characters",
    baseURL,
    webOrigin,
    // Legacy env inputs are ignored; pass an open one to prove it.
    signupsEnabled: "true",
    signupAllowlist: allowlist,
    email: delivery
      ? {
          describe: () => ({
            id: "offline-email",
            contractVersion: "1",
            adapterVersion: "1",
            capabilities: { transactional: true },
          }),
          send: async (message) => {
            messages.push(message);
          },
        }
      : undefined,
  });
  const request = (path: string, body?: unknown, token?: string) =>
    auth.handler(
      new Request(`${baseURL}/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          origin: requestOrigin ?? webOrigin,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  /** A user row with a real Better Auth credential, as provisioning or a legacy signup left it. */
  const seed = async (
    email = "member@example.test",
    { verified = true, member = true }: { verified?: boolean; member?: boolean } = {},
  ) => {
    const id = `user-${data.user!.length + 1}`;
    const now = new Date();
    data.user!.push({
      id,
      name: "Test User",
      email,
      emailVerified: verified,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    data.account!.push({
      id: `account-${id}`,
      accountId: id,
      providerId: "credential",
      userId: id,
      password: await hashPassword(PASSWORD),
      createdAt: now,
      updatedAt: now,
    });
    if (member) members.add(id);
    return id;
  };
  const signup = (email = "visitor@example.test") =>
    request("/sign-up/email", { email, password: PASSWORD, name: "Visitor" });
  const signin = (email = "member@example.test", password = PASSWORD) =>
    request("/sign-in/email", { email, password });
  const ownerWrites = () => prisma.deploymentSettings.updateMany.mock.calls;
  return { auth, request, seed, signup, signin, data, policy, messages, members, ownerWrites };
}

beforeEach(() => vi.clearAllMocks());

describe("loopback trusted origins", () => {
  it("accepts Origin localhost when webOrigin is 127.0.0.1", async () => {
    const f = fixture({
      delivery: false,
      baseURL: "http://127.0.0.1:5173",
      webOrigin: "http://127.0.0.1:5173",
      requestOrigin: "http://localhost:5173",
    });
    await f.seed();
    expect((await f.signin()).status).toBe(200);
  });

  it("accepts Origin 127.0.0.1 when webOrigin is localhost", async () => {
    const f = fixture({
      delivery: false,
      baseURL: "http://localhost:5173",
      webOrigin: "http://localhost:5173",
      requestOrigin: "http://127.0.0.1:5173",
    });
    await f.seed();
    expect((await f.signin()).status).toBe(200);
  });
});

describe("signup lockdown through auth endpoints (CAAH-43)", () => {
  for (const shape of [
    { name: "fresh install", allowlist: "", signupsEnabled: false, delivery: false },
    { name: "legacy open policy", allowlist: "", signupsEnabled: true, delivery: false },
    {
      name: "legacy allowlist naming the visitor",
      allowlist: "visitor@example.test",
      signupsEnabled: true,
      delivery: true,
    },
    {
      name: "legacy domain allowlist",
      allowlist: "@example.test",
      signupsEnabled: true,
      delivery: false,
    },
  ]) {
    it(`refuses direct email signup and creates nothing: ${shape.name}`, async () => {
      const f = fixture(shape);
      for (const email of ["visitor@example.test", "VISITOR@example.test"]) {
        const response = await f.signup(email);
        expect(response.status).toBe(400);
        expect(await response.text()).toContain("Registration is closed");
      }
      expect(f.data.user).toHaveLength(0);
      expect(f.data.session).toHaveLength(0);
      expect(f.messages).toHaveLength(0);
      expect(bootstrapUserSpace).not.toHaveBeenCalled();
      expect(f.policy.ownerUserId).toBeNull();
    });
  }

  it("lets existing admitted accounts sign in, verified or not, without claiming the owner", async () => {
    const f = fixture({ allowlist: "@example.test" });
    await f.seed("verified@example.test");
    // Admitted under an open policy before the upgrade; the legacy allowlist is inert.
    await f.seed("unverified@example.test", { verified: false });
    for (const email of ["verified@example.test", "unverified@example.test"]) {
      const response = await f.signin(email);
      expect(response.status, email).toBe(200);
      expect(await response.json()).toMatchObject({ token: expect.any(String) });
    }
    expect(f.data.session).toHaveLength(2);
    expect(f.messages).toHaveLength(0);
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
    // Owner removed or never set: a sign-in never takes the empty seat.
    expect(f.policy.ownerUserId).toBeNull();
    expect(f.ownerWrites()).toHaveLength(0);
  });

  it("keeps a legacy signup that was never admitted out, even when the stored policy is open and lists it", async () => {
    const f = fixture({ allowlist: "pending@example.test", signupsEnabled: true });
    await f.seed("pending@example.test", { verified: false, member: false });
    await f.seed("verified-pending@example.test", { verified: true, member: false });
    for (const email of ["pending@example.test", "verified-pending@example.test"]) {
      const response = await f.signin(email);
      expect(response.status, email).toBe(403);
      expect(await response.text()).toContain("Registration is closed");
    }
    expect(f.data.session).toHaveLength(0);
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
    expect(f.policy.ownerUserId).toBeNull();
  });

  it("rejects a wrong password for an existing account", async () => {
    const f = fixture();
    await f.seed();
    expect((await f.signin("member@example.test", "wrong-password12")).status).toBe(401);
    expect(f.data.session).toHaveLength(0);
  });

  it("recovers a password for an existing account and signs in with the new one", async () => {
    const f = fixture();
    await f.seed();
    const requested = await f.request("/request-password-reset", {
      email: "member@example.test",
      redirectTo: "http://web.example.test/reset-password",
    });
    expect(requested.status).toBe(200);
    await vi.waitFor(() => expect(f.messages).toHaveLength(1));
    const link = new URL(f.messages[0]!.text.match(/https?:\/\/\S+/)![0]);
    const token = link.pathname.split("/").at(-1) ?? link.searchParams.get("token");
    const reset = await f.request("/reset-password", {
      newPassword: "new-offline-password12",
      token,
    });
    expect(reset.status).toBe(200);
    expect((await f.signin()).status).toBe(401);
    expect((await f.signin("member@example.test", "new-offline-password12")).status).toBe(200);
  });

  it("routes every local email to the password step without revealing accounts", async () => {
    const f = fixture({ delivery: false });
    await f.seed();
    const bodies = new Set<string>();
    for (const email of ["member@example.test", "missing@example.test"]) {
      const response = await f.request("/hub/sign-in/continue", { email });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      bodies.add(await response.text());
    }
    expect([...bodies]).toEqual(['{"next":"password"}']);
    expect((await f.signin()).status).toBe(200);
    const untrusted = fixture({ delivery: false, requestOrigin: "https://untrusted.example.test" });
    expect(
      (await untrusted.request("/hub/sign-in/continue", { email: "member@example.test" })).status,
    ).toBe(403);
  });

  it("reserves internal messaging emails across sign-in, recovery and email changes", async () => {
    const f = fixture();
    for (const email of [
      "msg-sendblue15550001111@messaging.invalid",
      "MSG-Test@MESSAGING.INVALID",
    ]) {
      expect((await f.signup(email)).status).toBe(400);
      expect((await f.signin(email)).status).toBe(400);
      expect((await f.request("/request-password-reset", { email })).status).toBe(400);
      expect((await f.request("/send-verification-email", { email })).status).toBe(400);
    }
    expect(f.data.user).toHaveLength(0);
    await f.seed();
    const { token } = (await (await f.signin()).json()) as { token: string };
    expect(
      (await f.request("/change-email", { newEmail: "msg-taken@messaging.invalid" }, token)).status,
    ).toBe(400);
    // An account preclaimed before this upgrade must not keep its session.
    f.data.user![0]!.email = "msg-taken@messaging.invalid";
    expect(await (await f.request("/get-session", undefined, token)).json()).toBeNull();
    expect((await f.request("/update-user", { name: "Changed" }, token)).status).toBe(401);
    expect(f.messages).toHaveLength(0);
  });
});

describe("session credentials", () => {
  it("lists and reads sessions without handing out their tokens", async () => {
    const f = fixture({ delivery: false });
    await f.seed();
    const tokens: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      tokens.push(((await (await f.signin()).json()) as { token: string }).token);
    }
    const listed = await f.request("/list-sessions", undefined, tokens[0]);
    expect(listed.status).toBe(200);
    const text = await listed.text();
    const sessions = JSON.parse(text) as Array<Record<string, unknown>>;
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    for (const session of sessions) {
      expect(session).toMatchObject({ id: expect.any(String), userId: expect.any(String) });
      expect(session).not.toHaveProperty("token");
    }
    for (const token of tokens) expect(text).not.toContain(token);

    const current = await f.request("/get-session", undefined, tokens[0]);
    const body = (await current.json()) as { session: Record<string, unknown>; user: unknown };
    expect(body.user).toMatchObject({ email: "member@example.test" });
    expect(body.session).not.toHaveProperty("token");
    const server = await f.auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${tokens[1]}` }),
    });
    expect(server?.session).not.toHaveProperty("token");
  });

  it("requires the password to delete an account, even from a fresh session", async () => {
    const f = fixture({ delivery: false });
    await f.seed();
    const { token } = (await (await f.signin()).json()) as { token: string };
    for (const body of [{}, { password: "" }, { password: "wrong-password12" }]) {
      const response = await f.request("/delete-user", body, token);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(f.data.user).toHaveLength(1);
    }
    const deleted = await f.request("/delete-user", { password: PASSWORD }, token);
    expect(deleted.status).toBe(200);
    expect(f.data.user).toHaveLength(0);
  });
});
