import type {
  TransactionalEmail,
  TransactionalEmailProvider,
} from "@cortexai-agent-hub/adapter-kit";
import { isMessagingEmail } from "@cortexai-agent-hub/core";
import type { PrismaClient } from "@cortexai-agent-hub/db";

import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { bearer, organization } from "better-auth/plugins";
import {
  createHubAuth,
  HUB_SESSION_PATHS,
  HUB_SIGN_IN_RATE_LIMITS,
  localSignInPlugin,
  rejectHubAccountMutation,
} from "./hub.js";
import { createHubClient, type HubAuthConfig } from "./hub-client.js";
import type { HubConfigFetch, HubPolicy } from "./hub-policy.js";

export {
  HUB_CONFIG_DOC,
  type HubAuthConfig,
  type HubConfigProblem,
  hubAuthFromEnv,
} from "./hub-client.js";
export {
  type AppliedHubPolicy,
  applyHubPolicyAtStartup,
  createHubPolicy,
  type HubConfigFetch,
  type HubPolicy,
  type HubPolicySignal,
  type HubPolicyStatus,
  notConfiguredHubPolicy,
} from "./hub-policy.js";
export { HUB_MANAGED_SETTINGS, HubPolicyError } from "./hub-policy-contract.js";
export {
  type HubPolicyRestart,
  type HubPolicyRuntime,
  hubNotConfiguredLogEntry,
  hubPolicyAutoRestart,
  hubPolicyLogEntry,
  startHubPolicyRuntime,
} from "./hub-policy-runtime.js";
export {
  type HubPolicyStore,
  memoryHubPolicyStore,
  prismaHubPolicyStore,
} from "./hub-policy-store.js";
export {
  createUserWorkAuthorizer,
  type HubSessionAuthorizerConfig,
  type HubSessionPolicy,
} from "./hub-sessions.js";

/** Hub's service-config read for one deployment, through the service token. */
export function hubConfigFetch(config: HubAuthConfig): HubConfigFetch {
  const client = createHubClient(config);
  return (etag) => client.serviceConfig(etag);
}
export { createHubVerifyCache, type HubVerifyCache } from "./hub-verify-cache.js";

export interface AuthEnv {
  secret: string;
  baseURL: string;
  webOrigin: string;
  /**
   * @deprecated Ignored since CAAH-43. Self-service signup is closed and no
   * environment or stored value reopens it.
   */
  signupsEnabled?: string | undefined;
  /** @deprecated Ignored since CAAH-43; see `signupsEnabled`. */
  signupAllowlist?: string | undefined;
  extraOrigins?: string[];
  email?: TransactionalEmailProvider;
  onEmailError?: (error: unknown) => void;
  beforeDeleteUser?: (userId: string) => Promise<void>;
  hub?: HubAuthConfig;
  tokenEncryptionKey?: string;
  /** Fixed Hub SSO failure reasons for operator logs; never carries secrets or email. */
  onHubSsoError?: (reason: string) => void;
  /** Required with `hub`: Hub policy gates every sign-in path (CAAH-36). */
  hubPolicy?: HubPolicy;
}

export function createAuth(prisma: PrismaClient, env: AuthEnv) {
  if (env.hub && !env.tokenEncryptionKey) throw new Error("Hub token encryption key is required");
  const hub = env.hub
    ? createHubAuth(prisma, env.hub, { ...env, tokenEncryptionKey: env.tokenEncryptionKey! })
    : undefined;
  return betterAuth({
    appName: "CortexAI Agent Hub",
    secret: env.secret,
    baseURL: env.baseURL,
    trustedOrigins: buildTrustedOrigins(env),
    // Better Auth's strict /sign-in* rule does not match the Hub endpoints.
    rateLimit: { customRules: HUB_SIGN_IN_RATE_LIMITS },
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailAndPassword: {
      enabled: !hub,
      // Self-service signup is permanently disabled. Operator provisioning creates accounts.
      disableSignUp: true,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: env.email
        ? async ({ user, url }) => {
            // Keep the response timing generic. Production providers track and retry the promise,
            // while the composition root drains accepted delivery during graceful shutdown.
            void env.email
              ?.send(passwordResetEmail(user, url))
              .catch((error) => env.onEmailError?.(error));
          }
        : undefined,
    },
    emailVerification: {
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: env.email
        ? async ({ user, url }) => {
            const verificationUrl = new URL(url);
            verificationUrl.searchParams.set(
              "callbackURL",
              new URL("/sign-in", env.webOrigin).href,
            );
            await env.email!.send(verificationEmail(user.email, verificationUrl.href));
          }
        : undefined,
    },
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          await env.beforeDeleteUser?.(user.id);
          const memberships = await prisma.member.findMany({
            where: { userId: user.id },
            select: {
              organizationId: true,
              organization: { select: { members: { select: { userId: true } } } },
            },
          });
          const personalOrganizationIds = memberships
            .filter(({ organization }) =>
              organization.members.every((member) => member.userId === user.id),
            )
            .map(({ organizationId }) => organizationId);

          await prisma.$transaction([
            prisma.deploymentSettings.updateMany({
              where: { ownerUserId: user.id },
              data: { ownerUserId: null },
            }),
            // Messaging identities are deliberately FK-free, so clear them
            // here or the unique address would point at a deleted bot forever.
            prisma.messagingIdentity.deleteMany({
              where: { userId: user.id },
            }),
            prisma.organization.deleteMany({
              where: { id: { in: personalOrganizationIds } },
            }),
          ]);
        },
      },
    },
    plugins: [
      hub ? hub.plugin : localSignInPlugin,
      bearer(),
      organization({
        allowUserToCreateOrganization: false,
        disableOrganizationDeletion: true,
        creatorRole: "owner",
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (hub) rejectHubAccountMutation(ctx.path);
        // CAAH-43: self-service signup is gone. `disableSignUp` already refuses
        // the email route; this closes every signup path, including future
        // plugin ones, before any body is processed.
        if (isSignupPath(ctx.path)) {
          throw new APIError("BAD_REQUEST", { message: "Registration is closed" });
        }
        for (const value of [ctx.body?.email, ctx.body?.newEmail]) {
          if (
            typeof value === "string" &&
            (isMessagingEmail(value) || value.toLowerCase().endsWith("@hub.invalid"))
          ) {
            throw new APIError("BAD_REQUEST", { message: "Email is not available" });
          }
        }
        // Better Auth skips the password for a session under a day old, so a
        // borrowed session alone could delete the account.
        if (ctx.path === "/delete-user" && !ctx.body?.password) {
          throw new APIError("BAD_REQUEST", {
            message: "Invalid password",
            code: "INVALID_PASSWORD",
          });
        }
        // Return a request-local override so session lookups are authorized
        // per request without mutating the shared auth options.
        return {
          context: {
            context: {
              internalAdapter: {
                ...ctx.context.internalAdapter,
                // Authorize at lookup: bearer conversion happens after before
                // hooks, and auth mutations also read sessions through here.
                findSession: async (token: string) => {
                  const session = await ctx.context.internalAdapter.findSession(token);
                  if (!session || isMessagingEmail(session.user.email)) return null;
                  if (session.user.id.startsWith("hub_")) {
                    return hub && (await hub.authorizeSession(session.session.id, session.user.id))
                      ? session
                      : null;
                  }
                  if (hub) return null;
                  // Sessions are only issued to admitted accounts (see
                  // session.create.before); no stored allowlist is consulted.
                  return session;
                },
              },
            },
          },
        };
      }),
      after: createAuthMiddleware(async (ctx) => {
        const redacted = withoutSessionTokens(ctx.path, ctx.context.returned);
        if (redacted) return ctx.json(redacted);
      }),
    },
    databaseHooks: {
      session: {
        delete: {
          before: async (session) => {
            if (hub) await hub.revokeSession(session.id);
          },
        },
        create: {
          before: async (session, ctx) => {
            // Read through the auth adapter so this request's writes are visible.
            const user = await ctx?.context.internalAdapter.findUserById(session.userId);
            if (hub) {
              if (!HUB_SESSION_PATHS.includes(ctx?.path ?? "") || !user?.id.startsWith("hub_")) {
                throw new APIError("FORBIDDEN", { message: "Sign in through CortexAI Hub" });
              }
              return;
            }
            if (!user || isMessagingEmail(user.email)) {
              throw new APIError("FORBIDDEN", { message: "Email verification required" });
            }
            // CAAH-43: an account is admitted when it has a space. Operator
            // provisioning creates it; accounts admitted before the upgrade
            // already have one. A legacy signup that never got that far stays
            // locked out, whatever the stored signup flag or allowlist says.
            // Nothing here bootstraps a space or claims the deployment owner.
            const membership = await prisma.spaceMember.findFirst({
              where: { userId: user.id },
              select: { id: true },
            });
            if (!membership) {
              throw new APIError("FORBIDDEN", { message: "Registration is closed" });
            }
          },
        },
      },
      user: {
        create: {
          before: async (user) => {
            if (isMessagingEmail(user.email)) {
              throw new APIError("BAD_REQUEST", { message: "Email is not available" });
            }
          },
        },
        update: {
          before: async (user) => {
            if (user.email && isMessagingEmail(user.email)) {
              throw new APIError("BAD_REQUEST", { message: "Email is not available" });
            }
          },
        },
      },
    },
  });
}

export function verificationEmail(email: string, url: string): TransactionalEmail {
  return {
    to: email,
    subject: "Verify your CortexAI Agent Hub email",
    text: `Verify your email, then return to CortexAI Agent Hub to sign in:\n\n${url}\n\nThis link expires in one hour. If you did not register, ignore this email.`,
    html: `<p><a href="${escapeHtml(url)}">Verify email</a>, then return to CortexAI Agent Hub to sign in.</p><p>This link expires in one hour. If you did not register, ignore this email.</p>`,
  };
}

export function passwordResetEmail(
  user: { id: string; email: string; name: string },
  resetUrl: string,
): TransactionalEmail {
  const name = user.name.trim() || "there";
  const safeName = escapeHtml(name);
  const safeUrl = escapeHtml(resetUrl);
  return {
    to: user.email,
    subject: "Reset your CortexAI Agent Hub password",
    text: [
      `Hi ${name},`,
      "",
      "Reset your CortexAI Agent Hub password using this link:",
      resetUrl,
      "",
      "This link expires in one hour. If you did not request this, you can ignore this email.",
    ].join("\n"),
    html: `<p>Hi ${safeName},</p><p>Reset your CortexAI Agent Hub password:</p><p><a href="${safeUrl}">Reset password</a></p><p>This link expires in one hour. If you did not request this, you can ignore this email.</p>`,
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * A session token is a bearer credential. Session reads describe sessions
 * without handing any of them out; sign-in and sign-up still return the token
 * they just issued. Returns the redacted body, or undefined to keep it.
 */
function withoutSessionTokens(
  path: string,
  returned: unknown,
): Record<string, unknown> | unknown[] | undefined {
  if (path === "/list-sessions" && Array.isArray(returned)) {
    return returned.map(withoutToken);
  }
  if (
    (path === "/get-session" || path === "/update-session") &&
    isRecord(returned) &&
    isRecord(returned.session)
  ) {
    return { ...returned, session: withoutToken(returned.session) };
  }
  return undefined;
}

function withoutToken(session: unknown): unknown {
  if (!isRecord(session)) return session;
  const { token: _token, ...rest } = session;
  return rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Assemble Better Auth trustedOrigins, adding localhost↔127.0.0.1 twins for loopback. */
export function buildTrustedOrigins(env: Pick<AuthEnv, "webOrigin" | "baseURL" | "extraOrigins">) {
  const configured = [env.webOrigin, env.baseURL, ...(env.extraOrigins ?? [])];
  const twins = [env.webOrigin, env.baseURL].flatMap(loopbackTwinOrigins);
  return [...new Set([...configured, ...twins])];
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/** Same-scheme/port localhost and 127.0.0.1 variants when `origin` is loopback. */
function loopbackTwinOrigins(origin: string): string[] {
  try {
    const url = new URL(origin);
    if (!isLoopbackHost(url.hostname)) return [];
    const twins: string[] = [];
    for (const host of ["localhost", "127.0.0.1"] as const) {
      if (host === url.hostname) continue;
      const twin = new URL(origin);
      twin.hostname = host;
      twins.push(twin.origin);
    }
    return twins;
  } catch {
    return [];
  }
}

/**
 * Spaces are Better Auth organizations, but their lifecycle belongs to the
 * product RPCs. No client calls the organization plugin over HTTP, so every
 * route under it stays closed, including ones a future plugin version adds.
 */
export function isBlockedAuthPath(path: string): boolean {
  return path.startsWith("/organization") || isSignupPath(path);
}

/** Every Better Auth signup route; self-service signup is closed (CAAH-43). */
export function isSignupPath(path: string): boolean {
  return path === "/sign-up" || path.startsWith("/sign-up/");
}

/** Stable local id for a Hub identity: origin + tenant + tenant_users.id. */
export { hubUserId } from "./hub-client.js";
export {
  HUB_TENANT_MISSING,
  type HubOwnerMappingInput,
  mapHubOwner,
  normalizeProvisionEmail,
  PROVISION_PASSWORD_MAX_LENGTH,
  PROVISION_PASSWORD_MIN_LENGTH,
  ProvisioningError,
  type ProvisioningErrorCode,
  provisionLocalAccount,
  transferLocalOwner,
} from "./provisioning.js";
