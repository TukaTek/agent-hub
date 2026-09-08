import type { PrismaClient } from "@cortexai-agent-hub/db";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { createHubClient, type HubAuthConfig } from "./hub-client.js";

export function createHubSessionAuthorizer(
  prisma: PrismaClient,
  config: HubAuthConfig,
  encryptionKey: string,
  client = createHubClient(config),
) {
  return async (sessionId: string, userId: string): Promise<boolean> => {
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
              await client.verify(
                await symmetricDecrypt({ key: encryptionKey, data: grantSession.accessToken }),
                identity,
              );
              return true;
            }
            const refresh = await symmetricDecrypt({
              key: encryptionKey,
              data: grantSession.refreshToken,
            });
            const grant = await client.refresh(refresh);
            if (grant.subject !== identity.subject || grant.tenant !== identity.tenant)
              throw new Error("Hub identity changed");
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
            return true;
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
}

/** Background work uses the same expiring Hub grant as interactive requests. */
export function createUserWorkAuthorizer(
  prisma: PrismaClient,
  config: HubAuthConfig | undefined,
  encryptionKey: string,
) {
  const authorize = config ? createHubSessionAuthorizer(prisma, config, encryptionKey) : undefined;
  return async (userId: string): Promise<boolean> => {
    if (!authorize) return !userId.startsWith("hub_");
    if (!userId.startsWith("hub_")) return false;
    const sessions = await prisma.session.findMany({
      where: { userId, expiresAt: { gt: new Date() }, hubSession: { isNot: null } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    for (const session of sessions) if (await authorize(session.id, userId)) return true;
    return false;
  };
}
