import type { PrismaClient } from "@cortexai-agent-hub/db";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { createHubClient, type HubAuthConfig } from "./hub-client.js";
import type { HubPolicy } from "./hub-policy.js";
import { createHubVerifyCache, logCacheMetrics } from "./hub-verify-cache.js";

export interface HubSessionAuthorizerConfig {
  /** Cache TTL in milliseconds. Default: 30000 (30s) */
  verifyCacheTtlMs?: number;
  /** Whether to enable verification caching. Default: true */
  verifyCacheEnabled?: boolean;
}

/** The parts of the shared Hub policy that continuing sessions and work consult. */
export type HubSessionPolicy = Pick<HubPolicy, "sessionAllowed" | "workAllowed">;

export function createHubSessionAuthorizer(
  prisma: PrismaClient,
  config: HubAuthConfig,
  encryptionKey: string,
  client: ReturnType<typeof createHubClient> = createHubClient(config),
  options: HubSessionAuthorizerConfig & { policy: HubSessionPolicy },
) {
  const { policy } = options;
  const verifyCache = createHubVerifyCache({
    ttlMs: options.verifyCacheTtlMs ?? 30_000,
    enabled: options.verifyCacheEnabled ?? true,
  });

  // Log cache metrics every 5 minutes for observability
  const metricsTimer = setInterval(() => logCacheMetrics(verifyCache), 5 * 60_000);
  metricsTimer.unref();

  const authorize = async (sessionId: string, userId: string): Promise<boolean> => {
    // Hub mode without its tenant or service credential admits no session (F1).
    if (config.notConfigured) return false;
    try {
      return await prisma.$transaction(
        async (tx) => {
          // Serialize rotated-token refresh across API and worker processes.
          await tx.$queryRaw`SELECT "sessionId" FROM "hub_session" WHERE "sessionId" = ${sessionId} FOR UPDATE`;
          const grantSession = await tx.hubSession.findUnique({ where: { sessionId } });
          const session = await tx.session.findUnique({ where: { id: sessionId } });
          const identity = await tx.hubIdentity.findUnique({ where: { userId } });
          if (
            !grantSession ||
            !session ||
            session.userId !== userId ||
            session.expiresAt.getTime() <= Date.now() ||
            !identity ||
            identity.origin !== config.origin ||
            (config.tenantId && identity.tenant !== config.tenantId) ||
            !grantSession.accessToken
          )
            return false;
          try {
            if (grantSession.accessUntil.getTime() > Date.now()) {
              const accessToken = await symmetricDecrypt({
                key: encryptionKey,
                data: grantSession.accessToken,
              });
              const tokenHash = verifyCache.hashToken(accessToken);
              const tokenExpiresAt = grantSession.accessUntil.getTime();

              // Within the CAAH-40 window the session runs on last-known-good.
              if (verifyCache.get(tokenHash, tokenExpiresAt)) {
                return true;
              }

              // Cache miss: verify with Hub and measure latency
              const verifyStart = Date.now();
              await client.verify(accessToken, identity);
              verifyCache.recordVerifyLatency(Date.now() - verifyStart);

              // Once the window lapses, Hub policy must admit the session like a new
              // sign-in. A refusal is not a revocation, so the session is kept for
              // when Hub recovers.
              if (!(await policy.sessionAllowed(identity))) return false;
              verifyCache.set(tokenHash, tokenExpiresAt);
              return true;
            }
            const refresh = await symmetricDecrypt({
              key: encryptionKey,
              data: grantSession.refreshToken,
            });
            const grant = await client.refresh(refresh);
            if (grant.subject !== identity.subject || grant.tenant !== identity.tenant)
              throw new Error("Hub identity changed");

            // Invalidate old access token cache entry before updating to new token
            const oldAccessToken = await symmetricDecrypt({
              key: encryptionKey,
              data: grantSession.accessToken,
            });
            verifyCache.invalidate(verifyCache.hashToken(oldAccessToken));

            await tx.hubSession.update({
              where: { sessionId },
              data: {
                refreshToken: await symmetricEncrypt({
                  key: encryptionKey,
                  data: grant.refreshToken,
                }),
                accessToken: await symmetricEncrypt({
                  key: encryptionKey,
                  data: grant.accessToken,
                }),
                accessUntil: grant.accessUntil,
              },
            });
            return await policy.sessionAllowed(identity);
          } catch {
            // Refresh may already have rotated on a lost response. Require a fresh login.
            await tx.session.deleteMany({ where: { id: sessionId } });
            return false;
          }
        },
        { timeout: 30_000 },
      );
    } catch {
      return false;
    }
  };

  return Object.assign(authorize, {
    /** Access to the verify cache for testing and observability */
    _cache: verifyCache,
  });
}

/**
 * Background work uses the same expiring Hub grant as interactive requests, and
 * starts only while the shared Hub policy assigns Agent Hub to the user.
 */
export function createUserWorkAuthorizer(
  prisma: PrismaClient,
  config: HubAuthConfig | undefined,
  encryptionKey: string,
  options: HubSessionAuthorizerConfig & { policy?: HubSessionPolicy } = {},
  client?: ReturnType<typeof createHubClient>,
) {
  const { policy } = options;
  // Hub mode without its tenant or service credential admits no work (F1).
  if (config?.notConfigured) return async (_userId: string): Promise<boolean> => false;
  if (config && !policy) throw new Error("Hub mode requires the Hub policy gate");
  const authorize =
    config && policy
      ? createHubSessionAuthorizer(prisma, config, encryptionKey, client, { ...options, policy })
      : undefined;
  return async (userId: string): Promise<boolean> => {
    if (!authorize || !policy) return !userId.startsWith("hub_");
    if (!userId.startsWith("hub_")) return false;
    const identity = await prisma.hubIdentity.findUnique({ where: { userId } });
    if (!identity || !(await policy.workAllowed(identity))) return false;
    const sessions = await prisma.session.findMany({
      where: { userId, expiresAt: { gt: new Date() }, hubSession: { isNot: null } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    for (const session of sessions) if (await authorize(session.id, userId)) return true;
    return false;
  };
}
