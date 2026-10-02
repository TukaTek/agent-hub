import { createHash, randomUUID } from "node:crypto";
import { bootstrapUserSpace, createDb } from "@cortexai-agent-hub/db";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { describe, expect, it, vi } from "vitest";
import contract from "./fixtures/agent-hub-auth.v2.json" with { type: "json" };
import web from "./fixtures/agent-hub-web-sso.v1.json" with { type: "json" };
import { hubUserId } from "./hub-client.js";
import { createHubSessionAuthorizer } from "./hub-sessions.js";
import { createAuth } from "./index.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("Hub session persistence (PostgreSQL)", () => {
  it("completes a native Hub login with the real auth adapter and workspace bootstrap", async () => {
    const db = createDb(process.env.DATABASE_URL!);
    const config = {
      origin: "https://hub.example.test",
      tenantId: "fixture-tenant",
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
      audience: "cortexai:caia",
    };
    const subject = randomUUID();
    const id = hubUserId(config.origin, config.tenantId, subject);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/lookup"))
          return Response.json({ tenantId: config.tenantId, idpType: "native" });
        if (path.endsWith("/session"))
          return Response.json({ valid: true, userId: subject, tenantId: config.tenantId });
        if (path.endsWith("/config"))
          return Response.json({
            product: "cortexai-agent-hub",
            products: contract.sessionResponse.products,
          });
        return Response.json({
          ...contract.sessionResponse,
          user: { ...contract.sessionResponse.user, id: subject },
        });
      }),
    );
    try {
      const ownerBefore = await db.prisma.deploymentSettings.findUnique({
        where: { id: "default" },
      });
      const auth = createAuth(db.prisma, {
        secret: "offline-auth-secret-at-least-32-characters",
        tokenEncryptionKey: "offline-test-encryption-key",
        baseURL: "http://web.example.test",
        webOrigin: "http://web.example.test",
        hub: config,
        signupsEnabled: "false",
        signupAllowlist: "",
      });
      const login = await auth.handler(
        new Request("http://web.example.test/api/auth/hub/sign-in", {
          method: "POST",
          headers: { origin: "http://web.example.test", "content-type": "application/json" },
          body: JSON.stringify({ email: "user@example.test", password: "test-password" }),
        }),
      );
      expect(login.status).toBe(200);
      const session = await db.prisma.session.findFirstOrThrow({ where: { userId: id } });
      expect(
        await auth.api.getSession({
          headers: new Headers({ authorization: `Bearer ${session.token}` }),
        }),
      ).toMatchObject({ user: { id } });
      expect(await db.prisma.spaceMember.count({ where: { userId: id } })).toBe(1);
      expect(
        (await db.prisma.deploymentSettings.findUnique({ where: { id: "default" } }))
          ?.ownerUserId ?? null,
      ).toBe(ownerBefore?.ownerUserId ?? null);
    } finally {
      vi.unstubAllGlobals();
      await db.prisma.organization.deleteMany({ where: { slug: `user-${id}` } });
      await db.prisma.user.deleteMany({ where: { id } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("gives an Entra SSO user the same hub_ row as Always Native password sign-in", async () => {
    const db = createDb(process.env.DATABASE_URL!);
    const config = {
      origin: "https://hub.example.test",
      tenantId: web.exchangeResponse.tenantId,
      deploymentId: web.exchangeResponse.deploymentId,
      sso: { apiId: "fixture-api-id", secret: "synthetic-service-secret" },
    };
    const subject = randomUUID();
    const deniedSubject = randomUUID();
    const id = hubUserId(config.origin, config.tenantId, subject);
    const deniedId = hubUserId(config.origin, config.tenantId, deniedSubject);
    const hub = {
      idpType: "native",
      subject,
      exchange: undefined as Response | undefined,
      starts: [] as Record<string, string>[],
      exchanges: [] as Record<string, string>[],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const path = new URL(String(url)).pathname;
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const grant = {
          ...web.exchangeResponse,
          user: { ...web.exchangeResponse.user, id: hub.subject },
        };
        if (path.endsWith("/lookup"))
          return Response.json({ tenantId: config.tenantId, idpType: hub.idpType });
        if (path.endsWith("/service-token"))
          return Response.json({
            token: "synthetic-service-token",
            tokenType: "Bearer",
            expiresIn: 300,
          });
        if (path.endsWith("/sso-start")) {
          hub.starts.push(body);
          return Response.json(web.ssoStartResponse);
        }
        if (path.endsWith("/sso-exchange")) {
          hub.exchanges.push(body);
          return hub.exchange?.clone() ?? Response.json(grant);
        }
        if (path.endsWith("/session"))
          return Response.json({ valid: true, userId: hub.subject, tenantId: config.tenantId });
        if (path.endsWith("/config"))
          return Response.json({ product: "cortexai-agent-hub", products: grant.products });
        return Response.json(grant);
      }),
    );
    const origin = "https://web.example.test";
    const auth = createAuth(db.prisma, {
      secret: "offline-auth-secret-at-least-32-characters",
      tokenEncryptionKey: "offline-test-encryption-key",
      baseURL: origin,
      webOrigin: origin,
      hub: config,
      signupsEnabled: "false",
      signupAllowlist: "",
    });
    const post = (path: string, body: unknown) =>
      auth.handler(
        new Request(`${origin}/api/auth${path}`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const startSso = async () => {
      hub.idpType = "entra";
      const response = await post("/hub/sign-in/continue", { email: "user@example.test" });
      expect(await response.json()).toEqual({
        next: "redirect",
        url: web.ssoStartResponse.authorizeUrl,
      });
      const state = /__Host-ah_sso=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")![1]!;
      return { state, cookie: `__Host-ah_sso=${state}` };
    };
    const callback = (state: string, cookie: string) =>
      auth.handler(
        new Request(`${origin}/api/auth/hub/sso/callback?code=${"c".repeat(43)}&state=${state}`, {
          headers: { cookie },
        }),
      );
    try {
      expect(
        (await post("/hub/sign-in", { email: "user@example.test", password: "test-password" }))
          .status,
      ).toBe(200);
      const passwordUser = await db.prisma.user.findUniqueOrThrow({ where: { id } });

      const abandoned = `hub-sso:abandoned-${randomUUID()}`;
      await db.prisma.verification.create({
        data: {
          id: abandoned,
          identifier: abandoned,
          value: "synthetic",
          expiresAt: new Date(Date.now() - 1000),
        },
      });
      const { state, cookie } = await startSso();
      expect(await db.prisma.verification.count({ where: { id: abandoned } })).toBe(0);
      const pending = await db.prisma.verification.findMany({
        where: { id: { startsWith: "hub-sso:" } },
      });
      expect(pending.map((row) => row.id)).toContain(
        `hub-sso:${createHash("sha256").update(state).digest("hex")}`,
      );
      expect(JSON.stringify(pending)).not.toContain(state);
      const signedIn = await callback(state, cookie);
      expect(signedIn.status).toBe(302);
      expect(signedIn.headers.get("location")).toBe(`${origin}/app`);
      const [exchange] = hub.exchanges;
      expect(exchange).toMatchObject({
        code: "c".repeat(43),
        returnChannel: "agent-hub-web",
        redirectUri: `${origin}/api/auth/hub/sso/callback`,
      });
      expect(createHash("sha256").update(exchange!.codeVerifier!).digest("base64url")).toBe(
        hub.starts[0]!.codeChallenge,
      );
      expect(hub.starts[0]).toMatchObject({ state, deploymentId: config.deploymentId });
      expect(await db.prisma.user.findUniqueOrThrow({ where: { id } })).toEqual(passwordUser);
      expect(
        await db.prisma.hubIdentity.count({ where: { tenant: config.tenantId, subject } }),
      ).toBe(1);
      expect(await db.prisma.session.count({ where: { userId: id } })).toBe(2);
      expect(await db.prisma.hubSession.count({ where: { session: { userId: id } } })).toBe(2);
      expect(await db.prisma.verification.count({ where: { id: pending[0]!.id } })).toBe(0);

      const replay = await callback(state, cookie);
      expect(replay.headers.get("location")).toBe(`${origin}/sign-in?error=sso_expired`);
      expect(hub.exchanges).toHaveLength(1);
      expect(await db.prisma.session.count({ where: { userId: id } })).toBe(2);

      hub.subject = deniedSubject;
      for (const denial of [
        Response.json({ error: "access_denied" }, { status: 403 }),
        Response.json({ ...web.exchangeResponse, tenantId: "tenant-b" }),
      ]) {
        hub.exchange = denial;
        const attempt = await startSso();
        const denied = await callback(attempt.state, attempt.cookie);
        expect(denied.headers.get("location")).toBe(`${origin}/sign-in?error=sso_failed`);
      }
      expect(await db.prisma.user.count({ where: { id: deniedId } })).toBe(0);
      expect(await db.prisma.session.count({ where: { userId: deniedId } })).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      await db.prisma.verification.deleteMany({ where: { id: { startsWith: "hub-sso:" } } });
      await db.prisma.organization.deleteMany({ where: { slug: { in: [`user-${id}`] } } });
      await db.prisma.user.deleteMany({ where: { id: { in: [id, deniedId] } } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("keeps Hub identities with the same short prefix in separate workspaces", async () => {
    const db = createDb(process.env.DATABASE_URL!);
    const ids = [`hub_00000000${randomUUID()}`, `hub_00000000${randomUUID()}`];
    try {
      for (const id of ids) {
        await db.prisma.user.create({ data: { id, name: "Hub test", email: `${id}@hub.invalid` } });
      }
      const spaces = await Promise.all(
        ids.map((id) =>
          bootstrapUserSpace(db.prisma, { id }, { signupsEnabled: "false", signupAllowlist: "" }),
        ),
      );
      expect(spaces[0]!.spaceId).not.toBe(spaces[1]!.spaceId);
      expect(
        await db.prisma.spaceMember.count({
          where: { spaceId: spaces[0]!.spaceId, userId: ids[1] },
        }),
      ).toBe(0);
    } finally {
      await db.prisma.organization.deleteMany({
        where: { slug: { in: ids.map((id) => `user-${id}`) } },
      });
      await db.prisma.user.deleteMany({ where: { id: { in: ids } } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("serializes refresh across separate authorizers and cascades session deletion", async () => {
    const db = createDb(process.env.DATABASE_URL!);
    const id = `hub-test-${randomUUID()}`;
    const key = "offline-encryption-key-not-a-real-secret";
    const config = {
      origin: "https://hub.example.test",
      tenantId: "fixture-tenant",
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
      audience: "cortexai:caia",
    };
    const refresh = vi.fn(async () => ({
      subject: id,
      tenant: config.tenantId,
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
      accessUntil: new Date(Date.now() + 900_000),
    }));
    const client = {
      refresh,
      login: refresh,
      lookup: vi.fn(async () => ({ tenant: config.tenantId, idpType: "native" as const })),
      verify: vi.fn(async () => undefined),
      revoke: vi.fn(async () => undefined),
      ssoStart: vi.fn(async () => "https://login.example.test/authorize"),
      ssoExchange: refresh,
    };
    try {
      await db.prisma.user.create({
        data: {
          id,
          name: "Hub test",
          email: `${id}@hub.invalid`,
          hubIdentity: { create: { origin: config.origin, tenant: config.tenantId, subject: id } },
          sessions: {
            create: {
              id,
              token: randomUUID(),
              expiresAt: new Date(Date.now() + 86_400_000),
              hubSession: {
                create: {
                  refreshToken: await symmetricEncrypt({ key, data: "original-refresh" }),
                  accessUntil: new Date(0),
                  accessToken: await symmetricEncrypt({ key, data: "original-access" }),
                },
              },
            },
          },
        },
      });
      const api = createHubSessionAuthorizer(db.prisma, config, key, client);
      const worker = createHubSessionAuthorizer(db.prisma, config, key, client);
      expect(await Promise.all([api(id, id), worker(id, id)])).toEqual([true, true]);
      expect(refresh).toHaveBeenCalledExactlyOnceWith("original-refresh");
      const stored = await db.prisma.hubSession.findUniqueOrThrow({ where: { sessionId: id } });
      expect(await symmetricDecrypt({ key, data: stored.refreshToken })).toBe("rotated-refresh");
      await db.prisma.hubSession.update({
        where: { sessionId: id },
        data: { accessUntil: new Date(0) },
      });
      refresh.mockRejectedValue(new Error("invalid_grant"));
      expect(await api(id, id)).toBe(false);
      expect(await db.prisma.session.findUnique({ where: { id } })).toBeNull();
      expect(await db.prisma.hubSession.findUnique({ where: { sessionId: id } })).toBeNull();
    } finally {
      await db.prisma.user.deleteMany({ where: { id } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
});
