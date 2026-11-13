import type { PrismaClient } from "@cortexai-agent-hub/db";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import type { HubAuthConfig } from "./hub-client.js";
import { createHubClient, HubRequestError, isHubRejection } from "./hub-client.js";
import type { HubPolicy } from "./hub-policy.js";
import { disabledHubPolicy } from "./hub-policy.js";
import { createHubVerifyCache, logCacheMetrics } from "./hub-verify-cache.js";

/** Hub could not confirm the session right now. The session is kept; callers answer 503. */
export class HubSessionUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("CortexAI Hub can't be reached", options);
    this.name = "HubSessionUnavailableError";
  }
}

/** Says why a request answered 503, never with tokens, identities or Hub bodies. */
function logUnavailable(cause: unknown) {
  console.warn(
    "[hub-sessions]",
    JSON.stringify({
      event: "hub_session_unavailable",
      ...(cause instanceof HubRequestError
        ? { error: "HubRequestError", status: cause.status, code: cause.code }
        : {
            error:
              cause instanceof Error ? cause.name : cause === undefined ? "none" : typeof cause,
          }),
    }),
  );
}

/** `false` ends access; "stale" means the stored grant changed under this request. */
type Outcome = boolean | "stale";

export interface HubSessionAuthorizerConfig {
  /** Cache TTL in milliseconds. Default: 30000 (30s) */
  verifyCacheTtlMs?: number;
  /** Whether to enable verification caching. Default: true */
  verifyCacheEnabled?: boolean;
}

/** The parts of the shared Hub policy that continuing sessions and work consult. */
export type HubSessionPolicy = Pick<HubPolicy, "sessionAllowed" | "workAllowed" | "status">;

/** One refresh per grant across processes; the new grant is stored before it is verified. */
const REFRESH_LEASE_MS = 30_000;
/** How long a request waits for another request's refresh before answering unavailable. */
const REFRESH_WAIT_MS = 10_000;
const REFRESH_POLL_MS = 100;

/** Without a recent Hub policy answer, a refusal is an outage rather than a denial. */
async function policyOutage(policy: HubSessionPolicy): Promise<boolean> {
  const { state } = await policy.status();
  return state === "unavailable" || state === "stale" || state === "missing";
}

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

  const decrypt = (data: string) => symmetricDecrypt({ key: encryptionKey, data });
  const encrypt = (data: string) => symmetricEncrypt({ key: encryptionKey, data });

  /**
   * Ends the session only while it still holds the grant this request used. The guard is
   * on the grant's own row, so PostgreSQL re-checks it against a concurrent refresh.
   */
  async function end(sessionId: string, used: string): Promise<Outcome> {
    const { count } = await prisma.hubSession.deleteMany({
      where: { sessionId, refreshToken: used },
    });
    if (!count) return "stale";
    await prisma.session.deleteMany({ where: { id: sessionId } });
    return false;
  }

  /** A definitive Hub answer ends the session; anything else keeps it for when Hub returns. */
  async function failed(error: unknown, sessionId: string, used: string): Promise<Outcome> {
    if (isHubRejection(error)) return end(sessionId, used);
    throw new HubSessionUnavailableError({ cause: error });
  }

  /** A policy refusal is not a revocation, so the session is kept for when Hub recovers. */
  async function admitted(identity: { subject: string; tenant: string }): Promise<boolean> {
    if (await policy.sessionAllowed(identity)) return true;
    if (await policyOutage(policy)) throw new HubSessionUnavailableError();
    return false;
  }

  async function authorizeOnce(sessionId: string, userId: string): Promise<Outcome> {
    const grantSession = await prisma.hubSession.findUnique({ where: { sessionId } });
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    const identity = await prisma.hubIdentity.findUnique({ where: { userId } });
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
    const used = grantSession.refreshToken;
    if (grantSession.accessUntil.getTime() > Date.now()) {
      let accessToken: string;
      try {
        accessToken = await decrypt(grantSession.accessToken);
      } catch {
        return end(sessionId, used);
      }
      const tokenHash = verifyCache.hashToken(accessToken);
      const tokenExpiresAt = grantSession.accessUntil.getTime();
      // Within the CAAH-40 window the session runs on last-known-good.
      if (verifyCache.get(tokenHash, tokenExpiresAt)) return true;
      const verifyStart = Date.now();
      try {
        await client.verify(accessToken, identity);
      } catch (error) {
        return failed(error, sessionId, used);
      }
      verifyCache.recordVerifyLatency(Date.now() - verifyStart);
      // Once the window lapses, Hub policy must admit the session like a new sign-in.
      if (!(await admitted(identity))) return false;
      verifyCache.set(tokenHash, tokenExpiresAt);
      return true;
    }
    let pending = refreshing.get(sessionId);
    if (!pending) {
      pending = refresh(sessionId, grantSession, identity).finally(() =>
        refreshing.delete(sessionId),
      );
      refreshing.set(sessionId, pending);
    }
    return pending;
  }

  /** Requests in this process share one refresh per session. */
  const refreshing = new Map<string, Promise<Outcome>>();

  /** Lets the next request refresh at once after a failed attempt. */
  const release = (sessionId: string, used: string) =>
    prisma.hubSession
      .updateMany({ where: { sessionId, refreshToken: used }, data: { refreshLeaseUntil: null } })
      .catch(() => undefined);

  /** Another process holds the lease: wait for its grant instead of spending the same token. */
  async function awaitRefresh(sessionId: string, used: string): Promise<Outcome> {
    const deadline = Date.now() + REFRESH_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, REFRESH_POLL_MS));
      const row = await prisma.hubSession.findUnique({ where: { sessionId } });
      if (
        !row ||
        row.refreshToken !== used ||
        !row.refreshLeaseUntil ||
        row.refreshLeaseUntil.getTime() <= Date.now()
      )
        return "stale";
    }
    throw new HubSessionUnavailableError();
  }

  async function refresh(
    sessionId: string,
    grantSession: { refreshToken: string; accessToken: string | null },
    identity: { subject: string; tenant: string },
  ): Promise<Outcome> {
    const used = grantSession.refreshToken;
    const now = new Date();
    const claimed = await prisma.hubSession.updateMany({
      where: {
        sessionId,
        refreshToken: used,
        OR: [{ refreshLeaseUntil: null }, { refreshLeaseUntil: { lt: now } }],
      },
      data: { refreshLeaseUntil: new Date(now.getTime() + REFRESH_LEASE_MS) },
    });
    if (!claimed.count) return awaitRefresh(sessionId, used);
    let next: string | undefined;
    try {
      let refreshToken: string;
      try {
        refreshToken = await decrypt(used);
      } catch {
        return await end(sessionId, used);
      }
      let grant: Awaited<ReturnType<typeof client.refresh>>;
      try {
        grant = await client.refresh(refreshToken);
      } catch (error) {
        return await failed(error, sessionId, used);
      }
      if (grant.subject !== identity.subject || grant.tenant !== identity.tenant) {
        await client.revoke(grant.refreshToken).catch(() => undefined);
        return await end(sessionId, used);
      }
      // Hub has spent the old token: keep the new grant before anything else can fail.
      try {
        const refreshCipher = await encrypt(grant.refreshToken);
        const stored = await prisma.hubSession.updateMany({
          where: { sessionId, refreshToken: used },
          data: {
            refreshToken: refreshCipher,
            accessToken: await encrypt(grant.accessToken),
            accessUntil: grant.accessUntil,
            refreshLeaseUntil: null,
          },
        });
        if (stored.count) next = refreshCipher;
      } catch (error) {
        await client.revoke(grant.refreshToken).catch(() => undefined);
        throw new HubSessionUnavailableError({ cause: error });
      }
      if (!next) {
        // The session ended or changed meanwhile; nothing local holds this grant.
        await client.revoke(grant.refreshToken).catch(() => undefined);
        return "stale";
      }
      if (grantSession.accessToken) {
        const old = await decrypt(grantSession.accessToken).catch(() => undefined);
        if (old) verifyCache.invalidate(verifyCache.hashToken(old));
      }
      try {
        await client.verify(grant.accessToken, identity);
      } catch (error) {
        const outcome = await failed(error, sessionId, next);
        // Refused: nothing local holds the grant Hub just issued.
        await client.revoke(grant.refreshToken).catch(() => undefined);
        return outcome;
      }
      return await admitted(identity);
    } finally {
      // Lets the next request refresh at once when no new grant was stored.
      if (!next) await release(sessionId, used);
    }
  }

  const authorize = async (sessionId: string, userId: string): Promise<boolean> => {
    // Hub mode without its tenant or service credential admits no session (F1).
    if (config.notConfigured) return false;
    try {
      // A stale outcome means another request changed the grant: decide again on the new one.
      for (let attempt = 0; attempt < 2; attempt++) {
        const outcome = await authorizeOnce(sessionId, userId);
        if (outcome !== "stale") return outcome;
      }
      throw new HubSessionUnavailableError();
    } catch (error) {
      // A database failure is not a sign-out either.
      const unavailable =
        error instanceof HubSessionUnavailableError
          ? error
          : new HubSessionUnavailableError({ cause: error });
      logUnavailable(unavailable.cause);
      throw unavailable;
    }
  };

  return Object.assign(authorize, {
    /** Access to the verify cache for testing and observability */
    _cache: verifyCache,
  });
}

/**
 * Background work uses the same expiring Hub grant as interactive requests, and
 * starts only while the shared Hub policy assigns Agent Hub to the user. Throws
 * HubSessionUnavailableError when Hub could not confirm any kept session.
 */
export function createUserWorkAuthorizer(
  prisma: PrismaClient,
  config: HubAuthConfig | undefined,
  encryptionKey: string,
  options: HubSessionAuthorizerConfig & { policy?: HubSessionPolicy } = {},
  client?: ReturnType<typeof createHubClient>,
) {
  // Hub mode without its tenant or service credential admits no work (F1).
  if (config?.notConfigured) return async (_userId: string): Promise<boolean> => false;
  const policy = config?.policyDisabled
    ? disabledHubPolicy({ tenantId: config.tenantId })
    : options.policy;
  if (config && !policy) throw new Error("Hub mode requires the Hub policy gate");
  const authorize =
    config && policy
      ? createHubSessionAuthorizer(prisma, config, encryptionKey, client, { ...options, policy })
      : undefined;
  return async (userId: string): Promise<boolean> => {
    if (!authorize || !policy) return !userId.startsWith("hub_");
    if (!userId.startsWith("hub_")) return false;
    const identity = await prisma.hubIdentity.findUnique({ where: { userId } });
    if (!identity) return false;
    const sessions = await prisma.session.findMany({
      where: { userId, expiresAt: { gt: new Date() }, hubSession: { isNot: null } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!(await policy.workAllowed(identity))) {
      // Without a recent Hub answer the refusal is an outage, not a sign-out.
      if (sessions.length && (await policyOutage(policy))) throw new HubSessionUnavailableError();
      return false;
    }
    let unavailable: HubSessionUnavailableError | undefined;
    for (const session of sessions) {
      try {
        if (await authorize(session.id, userId)) return true;
      } catch (error) {
        if (!(error instanceof HubSessionUnavailableError)) throw error;
        unavailable = error;
      }
    }
    // Hub could not answer: no new work now, but the session is kept, so this is no sign-out.
    if (unavailable) throw unavailable;
    if (sessions.length && (await policyOutage(policy))) throw new HubSessionUnavailableError();
    return false;
  };
}
