import { bootstrapUserSpace, type PrismaClient } from "@cortexai-agent-hub/db";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import {
  createHubClient,
  type HubAuthConfig,
  HubUnsupportedIdpError,
  hubUserId,
} from "./hub-client.js";
import { createHubSessionAuthorizer } from "./hub-sessions.js";

export function createHubAuth(
  prisma: PrismaClient,
  config: HubAuthConfig,
  env: { tokenEncryptionKey: string; baseURL: string; webOrigin: string },
  client = createHubClient(config),
) {
  const encrypt = (data: string) => symmetricEncrypt({ key: env.tokenEncryptionKey, data });
  const authorizeSession = createHubSessionAuthorizer(
    prisma,
    config,
    env.tokenEncryptionKey,
    {
      verifyCacheTtlMs: config.verifyCacheTtlMs,
      verifyCacheEnabled: config.verifyCacheEnabled,
    },
    client,
  );
  const plugin = {
    id: "cortexai-hub",
    endpoints: {
      hubSignIn: createAuthEndpoint(
        "/hub/sign-in",
        { method: "POST", requireHeaders: true },
        async (ctx) => {
          ctx.setHeader("cache-control", "no-store");
          const origin = ctx.headers?.get("origin");
          if (!origin || !ctx.context.isTrustedOrigin(origin, { allowRelativePaths: false })) {
            throw new APIError("FORBIDDEN", { message: "Invalid sign-in origin" });
          }
          const body = ctx.body as Record<string, unknown> | undefined;
          if (
            typeof body?.email !== "string" ||
            !body.email.trim() ||
            body.email.length > 320 ||
            typeof body.password !== "string" ||
            !body.password ||
            body.password.length > 1024
          ) {
            throw new APIError("BAD_REQUEST", { message: "Email and password are required" });
          }
          let sessionId: string | undefined;
          try {
            const grant = await client.login(body.email, body.password);
            const id = hubUserId(config.origin, grant.tenant, grant.subject);
            // Use stable Hub identity for ownership; never link local accounts by email.
            const user = await prisma.$transaction(async (tx) => {
              const existing = await tx.hubIdentity.findUnique({ where: { userId: id } });
              if (
                existing &&
                (existing.origin !== config.origin ||
                  existing.tenant !== grant.tenant ||
                  existing.subject !== grant.subject)
              ) {
                throw new Error("Hub identity collision");
              }
              if (!existing && (await tx.user.findUnique({ where: { id } })))
                throw new Error("Hub account collision");
              const user = await tx.user.upsert({
                where: { id },
                update: {},
                create: {
                  id,
                  name: grant.displayName || "User",
                  email: `${id}@hub.invalid`,
                  emailVerified: true,
                  hubIdentity: {
                    create: { origin: config.origin, tenant: grant.tenant, subject: grant.subject },
                  },
                },
              });
              return user;
            });
            await bootstrapUserSpace(
              prisma,
              user,
              { signupsEnabled: "false", signupAllowlist: undefined },
              { claimDeploymentOwner: false },
            );
            const session = await ctx.context.internalAdapter.createSession(user.id);
            if (!session) throw new Error("Session creation failed");
            sessionId = session.id;
            await prisma.hubSession.create({
              data: {
                sessionId,
                refreshToken: await encrypt(grant.refreshToken),
                accessUntil: grant.accessUntil,
                accessToken: await encrypt(grant.accessToken),
              },
            });
            await setSessionCookie(ctx, { session, user });
            return ctx.json({ token: session.token, user });
          } catch (error) {
            if (sessionId) await prisma.session.deleteMany({ where: { id: sessionId } });
            if (error instanceof HubUnsupportedIdpError) {
              throw new APIError("BAD_REQUEST", {
                code: "HUB_IDP_UNSUPPORTED",
                message: error.message,
              });
            }
            throw new APIError("UNAUTHORIZED", {
              message: "Could not sign in through CortexAI Hub",
            });
          }
        },
      ),
    },
  };
  async function revokeSession(sessionId: string) {
    try {
      const session = await prisma.hubSession.findUnique({ where: { sessionId } });
      if (session?.accessToken)
        await client.revoke(
          await symmetricDecrypt({ key: env.tokenEncryptionKey, data: session.refreshToken }),
        );
    } catch {
      // Local session deletion must complete even when Hub is unavailable.
    }
  }
  return { plugin, authorizeSession, revokeSession };
}

export function rejectHubAccountMutation(path: string) {
  if (
    ![
      "/hub/sign-in",
      "/get-session",
      "/sign-out",
      "/list-sessions",
      "/revoke-session",
      "/revoke-sessions",
      "/revoke-other-sessions",
      "/update-user",
    ].includes(path)
  ) {
    throw new APIError("FORBIDDEN", { message: "Sign in through CortexAI Hub" });
  }
}
