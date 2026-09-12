import { randomUUID } from "node:crypto";
import { createDb } from "@cortexai-agent-hub/db";
import { symmetricEncrypt } from "better-auth/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHubClient } from "./hub-client.js";
import { createHubSessionAuthorizer } from "./hub-sessions.js";

describe("Hub session authorizer with verify cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const describePostgres =
    process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

  describePostgres("PostgreSQL integration", () => {
    it("cache hit skips Hub verify calls", async () => {
      const db = createDb(process.env.DATABASE_URL!);
      const userId = `hub-test-${randomUUID()}`;
      const sessionId = randomUUID();
      const key = "test-encryption-key-at-least-32-characters";
      const config = { origin: "https://hub.example.test", tenantId: "test-tenant" };

      const verify = vi.fn(async () => undefined);
      const client = createHubClient(config, vi.fn());
      client.verify = verify;

      try {
        await db.prisma.user.create({
          data: {
            id: userId,
            name: "Test User",
            email: `${userId}@hub.invalid`,
            hubIdentity: {
              create: { origin: config.origin, tenant: config.tenantId, subject: userId },
            },
            sessions: {
              create: {
                id: sessionId,
                token: "test-token",
                expiresAt: new Date(Date.now() + 3_600_000),
                hubSession: {
                  create: {
                    accessToken: await symmetricEncrypt({ key, data: "test-access-token" }),
                    refreshToken: await symmetricEncrypt({ key, data: "test-refresh-token" }),
                    accessUntil: new Date(Date.now() + 300_000),
                  },
                },
              },
            },
          },
        });

        const authorizer = createHubSessionAuthorizer(
          db.prisma,
          config,
          key,
          { verifyCacheTtlMs: 30_000, verifyCacheEnabled: true },
          client,
        );

        // First call: cache miss, should verify
        expect(await authorizer(sessionId, userId)).toBe(true);
        expect(verify).toHaveBeenCalledTimes(1);
        expect(authorizer._cache.getMetrics().misses).toBe(1);
        expect(authorizer._cache.getMetrics().hits).toBe(0);

        // Second call within TTL: cache hit, should NOT verify
        expect(await authorizer(sessionId, userId)).toBe(true);
        expect(verify).toHaveBeenCalledTimes(1); // Still 1, no new call
        expect(authorizer._cache.getMetrics().hits).toBe(1);
        expect(authorizer._cache.getMetrics().misses).toBe(1);

        // Third call within TTL: another cache hit
        expect(await authorizer(sessionId, userId)).toBe(true);
        expect(verify).toHaveBeenCalledTimes(1); // Still 1
        expect(authorizer._cache.getMetrics().hits).toBe(2);
      } finally {
        await db.prisma.session.deleteMany({ where: { id: sessionId } });
        await db.prisma.user.deleteMany({ where: { id: userId } });
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    });

    it("TTL expiry triggers re-verification", async () => {
      const db = createDb(process.env.DATABASE_URL!);
      const userId = `hub-test-${randomUUID()}`;
      const sessionId = randomUUID();
      const key = "test-encryption-key-at-least-32-characters";
      const config = { origin: "https://hub.example.test", tenantId: "test-tenant" };

      const verify = vi.fn(async () => undefined);
      const client = createHubClient(config, vi.fn());
      client.verify = verify;

      try {
        await db.prisma.user.create({
          data: {
            id: userId,
            name: "Test User",
            email: `${userId}@hub.invalid`,
            hubIdentity: {
              create: { origin: config.origin, tenant: config.tenantId, subject: userId },
            },
            sessions: {
              create: {
                id: sessionId,
                token: "test-token",
                expiresAt: new Date(Date.now() + 3_600_000),
                hubSession: {
                  create: {
                    accessToken: await symmetricEncrypt({ key, data: "test-access-token" }),
                    refreshToken: await symmetricEncrypt({ key, data: "test-refresh-token" }),
                    accessUntil: new Date(Date.now() + 300_000),
                  },
                },
              },
            },
          },
        });

        const authorizer = createHubSessionAuthorizer(
          db.prisma,
          config,
          key,
          { verifyCacheTtlMs: 10_000, verifyCacheEnabled: true },
          client,
        );

        // First call: verify
        expect(await authorizer(sessionId, userId)).toBe(true);
        expect(verify).toHaveBeenCalledTimes(1);

        // Advance time past TTL
        vi.advanceTimersByTime(11_000);

        // Second call after TTL: should re-verify
        expect(await authorizer(sessionId, userId)).toBe(true);
        expect(verify).toHaveBeenCalledTimes(2);
        expect(authorizer._cache.getMetrics().evictions).toBeGreaterThan(0);
      } finally {
        await db.prisma.session.deleteMany({ where: { id: sessionId } });
        await db.prisma.user.deleteMany({ where: { id: userId } });
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    });

    it("Hub deny after allow is honored after cache invalidation", async () => {
      const db = createDb(process.env.DATABASE_URL!);
      const userId = `hub-test-${randomUUID()}`;
      const sessionId = randomUUID();
      const key = "test-encryption-key-at-least-32-characters";
      const config = { origin: "https://hub.example.test", tenantId: "test-tenant" };

      let verifyCount = 0;
      const verify = vi.fn(async () => {
        verifyCount++;
        if (verifyCount > 1) {
          throw new Error("Hub access denied"); // Revoked after first verify
        }
      });
      const client = createHubClient(config, vi.fn());
      client.verify = verify;

      try {
        await db.prisma.user.create({
          data: {
            id: userId,
            name: "Test User",
            email: `${userId}@hub.invalid`,
            hubIdentity: {
              create: { origin: config.origin, tenant: config.tenantId, subject: userId },
            },
            sessions: {
              create: {
                id: sessionId,
                token: "test-token",
                expiresAt: new Date(Date.now() + 3_600_000),
                hubSession: {
                  create: {
                    accessToken: await symmetricEncrypt({ key, data: "test-access-token" }),
                    refreshToken: await symmetricEncrypt({ key, data: "test-refresh-token" }),
                    accessUntil: new Date(Date.now() + 300_000),
                  },
                },
              },
            },
          },
        });

        const authorizer = createHubSessionAuthorizer(
          db.prisma,
          config,
          key,
          { verifyCacheTtlMs: 30_000, verifyCacheEnabled: true },
          client,
        );

        // First call: succeeds and caches
        expect(await authorizer(sessionId, userId)).toBe(true);
        expect(verify).toHaveBeenCalledTimes(1);

        // Second call within TTL: cache hit, still succeeds
        expect(await authorizer(sessionId, userId)).toBe(true);
        expect(verify).toHaveBeenCalledTimes(1); // Still cached

        // Advance past TTL to force re-verification
        vi.advanceTimersByTime(31_000);

        // Third call: re-verifies and gets denied
        expect(await authorizer(sessionId, userId)).toBe(false);
        expect(verify).toHaveBeenCalledTimes(2);
      } finally {
        await db.prisma.session.deleteMany({ where: { id: sessionId } });
        await db.prisma.user.deleteMany({ where: { id: userId } });
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    });

    it("token change invalidates cache", async () => {
      const db = createDb(process.env.DATABASE_URL!);
      const userId = `hub-test-${randomUUID()}`;
      const sessionId = randomUUID();
      const key = "test-encryption-key-at-least-32-characters";
      const config = { origin: "https://hub.example.test", tenantId: "test-tenant" };

      const verify = vi.fn(async () => undefined);
      const refresh = vi.fn(async () => ({
        subject: userId,
        tenant: config.tenantId,
        accessToken: "new-access-token", // Different token
        refreshToken: "new-refresh-token",
        accessUntil: new Date(Date.now() + 300_000),
      }));
      const client = createHubClient(config, vi.fn());
      client.verify = verify;
      client.refresh = refresh;

      try {
        await db.prisma.user.create({
          data: {
            id: userId,
            name: "Test User",
            email: `${userId}@hub.invalid`,
            hubIdentity: {
              create: { origin: config.origin, tenant: config.tenantId, subject: userId },
            },
            sessions: {
              create: {
                id: sessionId,
                token: "test-token",
                expiresAt: new Date(Date.now() + 3_600_000),
                hubSession: {
                  create: {
                    accessToken: await symmetricEncrypt({ key, data: "old-access-token" }),
                    refreshToken: await symmetricEncrypt({ key, data: "old-refresh-token" }),
                    // Set access to expire soon to trigger refresh
                    accessUntil: new Date(Date.now() + 1_000),
                  },
                },
              },
            },
          },
        });

        const authorizer = createHubSessionAuthorizer(
          db.prisma,
          config,
          key,
          { verifyCacheTtlMs: 30_000, verifyCacheEnabled: true },
          client,
        );

        // First call: verify and cache
        expect(await authorizer(sessionId, userId)).toBe(true);
        expect(verify).toHaveBeenCalledTimes(1);
        const oldCacheSize = authorizer._cache.getMetrics().cacheSize;

        // Advance time to trigger token refresh
        vi.advanceTimersByTime(2_000);

        // Second call: should refresh and invalidate old token cache
        expect(await authorizer(sessionId, userId)).toBe(true);
        expect(refresh).toHaveBeenCalledTimes(1);
        // Old cache entry should be invalidated
        expect(authorizer._cache.getMetrics().evictions).toBeGreaterThanOrEqual(1);
      } finally {
        await db.prisma.session.deleteMany({ where: { id: sessionId } });
        await db.prisma.user.deleteMany({ where: { id: userId } });
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    });

    it("expired tokens never serve cached allow", async () => {
      const db = createDb(process.env.DATABASE_URL!);
      const userId = `hub-test-${randomUUID()}`;
      const sessionId = randomUUID();
      const key = "test-encryption-key-at-least-32-characters";
      const config = { origin: "https://hub.example.test", tenantId: "test-tenant" };

      const verify = vi.fn(async () => undefined);
      const client = createHubClient(config, vi.fn());
      client.verify = verify;

      try {
        await db.prisma.user.create({
          data: {
            id: userId,
            name: "Test User",
            email: `${userId}@hub.invalid`,
            hubIdentity: {
              create: { origin: config.origin, tenant: config.tenantId, subject: userId },
            },
            sessions: {
              create: {
                id: sessionId,
                token: "test-token",
                expiresAt: new Date(Date.now() + 3_600_000),
                hubSession: {
                  create: {
                    accessToken: await symmetricEncrypt({ key, data: "test-access-token" }),
                    refreshToken: await symmetricEncrypt({ key, data: "test-refresh-token" }),
                    accessUntil: new Date(Date.now() + 5_000), // Expires in 5 seconds
                  },
                },
              },
            },
          },
        });

        const authorizer = createHubSessionAuthorizer(
          db.prisma,
          config,
          key,
          { verifyCacheTtlMs: 60_000, verifyCacheEnabled: true }, // Long TTL
          client,
        );

        // First call: verify and cache
        expect(await authorizer(sessionId, userId)).toBe(true);
        expect(verify).toHaveBeenCalledTimes(1);

        // Advance past token expiry (but before cache TTL)
        vi.advanceTimersByTime(6_000);

        // Cache should not serve expired token even though TTL hasn't passed
        // The authorizer should detect token expiry and attempt refresh
        const result = await authorizer(sessionId, userId);
        // Should fail because refresh will fail (no mock provided)
        expect(result).toBe(false);
      } finally {
        await db.prisma.session.deleteMany({ where: { id: sessionId } });
        await db.prisma.user.deleteMany({ where: { id: userId } });
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    });

    it("cache can be disabled via config", async () => {
      const db = createDb(process.env.DATABASE_URL!);
      const userId = `hub-test-${randomUUID()}`;
      const sessionId = randomUUID();
      const key = "test-encryption-key-at-least-32-characters";
      const config = { origin: "https://hub.example.test", tenantId: "test-tenant" };

      const verify = vi.fn(async () => undefined);
      const client = createHubClient(config, vi.fn());
      client.verify = verify;

      try {
        await db.prisma.user.create({
          data: {
            id: userId,
            name: "Test User",
            email: `${userId}@hub.invalid`,
            hubIdentity: {
              create: { origin: config.origin, tenant: config.tenantId, subject: userId },
            },
            sessions: {
              create: {
                id: sessionId,
                token: "test-token",
                expiresAt: new Date(Date.now() + 3_600_000),
                hubSession: {
                  create: {
                    accessToken: await symmetricEncrypt({ key, data: "test-access-token" }),
                    refreshToken: await symmetricEncrypt({ key, data: "test-refresh-token" }),
                    accessUntil: new Date(Date.now() + 300_000),
                  },
                },
              },
            },
          },
        });

        const authorizer = createHubSessionAuthorizer(
          db.prisma,
          config,
          key,
          { verifyCacheTtlMs: 30_000, verifyCacheEnabled: false }, // Disabled
          client,
        );

        // First call: verify
        expect(await authorizer(sessionId, userId)).toBe(true);
        expect(verify).toHaveBeenCalledTimes(1);

        // Second call: should verify again (no caching)
        expect(await authorizer(sessionId, userId)).toBe(true);
        expect(verify).toHaveBeenCalledTimes(2);

        // Third call: still verifies every time
        expect(await authorizer(sessionId, userId)).toBe(true);
        expect(verify).toHaveBeenCalledTimes(3);

        expect(authorizer._cache.getMetrics().cacheSize).toBe(0);
      } finally {
        await db.prisma.session.deleteMany({ where: { id: sessionId } });
        await db.prisma.user.deleteMany({ where: { id: userId } });
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    });

    it("records verify latency metrics", async () => {
      const db = createDb(process.env.DATABASE_URL!);
      const userId = `hub-test-${randomUUID()}`;
      const sessionId = randomUUID();
      const key = "test-encryption-key-at-least-32-characters";
      const config = { origin: "https://hub.example.test", tenantId: "test-tenant" };

      // Simulate slow Hub verify
      const verify = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      const client = createHubClient(config, vi.fn());
      client.verify = verify;

      try {
        await db.prisma.user.create({
          data: {
            id: userId,
            name: "Test User",
            email: `${userId}@hub.invalid`,
            hubIdentity: {
              create: { origin: config.origin, tenant: config.tenantId, subject: userId },
            },
            sessions: {
              create: {
                id: sessionId,
                token: "test-token",
                expiresAt: new Date(Date.now() + 3_600_000),
                hubSession: {
                  create: {
                    accessToken: await symmetricEncrypt({ key, data: "test-access-token" }),
                    refreshToken: await symmetricEncrypt({ key, data: "test-refresh-token" }),
                    accessUntil: new Date(Date.now() + 300_000),
                  },
                },
              },
            },
          },
        });

        const authorizer = createHubSessionAuthorizer(
          db.prisma,
          config,
          key,
          { verifyCacheTtlMs: 30_000, verifyCacheEnabled: true },
          client,
        );

        // First call: should record latency
        await authorizer(sessionId, userId);

        const metrics = authorizer._cache.getMetrics();
        expect(metrics.verifyLatencyMs).toHaveLength(1);
        expect(metrics.verifyLatencyMs[0]).toBeGreaterThan(0);
      } finally {
        await db.prisma.session.deleteMany({ where: { id: sessionId } });
        await db.prisma.user.deleteMany({ where: { id: userId } });
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    });
  });
});
