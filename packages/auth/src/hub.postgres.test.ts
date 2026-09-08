import { randomUUID } from "node:crypto";
import { bootstrapUserSpace, createDb } from "@cortexai-agent-hub/db";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { describe, expect, it, vi } from "vitest";
import contract from "./fixtures/agent-hub-auth.v2.json" with { type: "json" };
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

  it("keeps Hub identities with the same short prefix in separate workspaces", async () => {
    const db = createDb(process.env.DATABASE_URL!);
    const ids = [`hub_00000000${randomUUID()}`, `hub_00000000${randomUUID()}`];
    try {
      for (const id of ids) {
        await db.prisma.user.create({ data: { id, name: "Hub test", email: `${id}@hub.invalid` } });
      }
      const spaces = await Promise.all(
        ids.map((id) =>
          bootstrapUserSpace(
            db.prisma,
            { id },
            { signupsEnabled: "false", signupAllowlist: "" },
            { claimDeploymentOwner: false },
          ),
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
      verify: vi.fn(async () => undefined),
      revoke: vi.fn(async () => undefined),
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
