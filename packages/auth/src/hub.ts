import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  HUB_SSO_ACCESS_DENIED,
  type SignInContinueResponse,
  type SsoCallbackError,
} from "@cortexai-agent-hub/core";
import { bootstrapUserSpace, type PrismaClient } from "@cortexai-agent-hub/db";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import {
  createHubClient,
  type HubAuthConfig,
  type HubGrant,
  HubRequestError,
  HubUnsupportedIdpError,
  hubUserId,
} from "./hub-client.js";
import { createHubSessionAuthorizer } from "./hub-sessions.js";

type HubClient = ReturnType<typeof createHubClient>;
type EndpointContext = Parameters<typeof setSessionCookie>[0];

export const HUB_SSO_CALLBACK_PATH = "/hub/sso/callback";
const SSO_COOKIE = "__Host-ah_sso";
const SSO_TTL_MS = 10 * 60_000;
const SSO_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
} as const;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SSO_STATE_PREFIX = "hub-sso:";
/** Hub sso-start codes that mean this user may not use Agent Hub, not that Hub is down. */
const HUB_START_DENIALS = new Set(["access_denied", "product_not_enabled", "tenant_mismatch"]);

/**
 * Per client address, as resolved from the reverse proxy's single X-Forwarded-For value.
 * Loose enough that a proxy hop which collapses every user into one address slows
 * sign-in instead of locking a team out; Hub enforces its own login lockout.
 */
const HUB_SIGN_IN_RATE_LIMIT = { window: 60, max: 30 } as const;
export const HUB_SIGN_IN_RATE_LIMITS = {
  "/hub/sign-in": HUB_SIGN_IN_RATE_LIMIT,
  "/hub/sign-in/continue": HUB_SIGN_IN_RATE_LIMIT,
} as const;

function assertTrustedOrigin(ctx: {
  headers?: Headers;
  context: { isTrustedOrigin(url: string, settings: { allowRelativePaths: boolean }): boolean };
}) {
  const origin = ctx.headers?.get("origin");
  if (!origin || !ctx.context.isTrustedOrigin(origin, { allowRelativePaths: false })) {
    throw new APIError("FORBIDDEN", { message: "Invalid sign-in origin" });
  }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();
/** Rows are keyed by a hash so the database never holds a usable state value. */
const ssoStateKey = (state: string) => `${SSO_STATE_PREFIX}${sha256(state).toString("hex")}`;

/** Without a Hub client (local auth) every email continues to the password step. */
function signInContinueEndpoint(
  client?: Pick<HubClient, "lookup" | "ssoStart">,
  sso?: {
    prisma: PrismaClient;
    encrypt: (data: string) => Promise<string>;
    onError?: (reason: string) => void;
  },
) {
  return createAuthEndpoint(
    "/hub/sign-in/continue",
    { method: "POST", requireHeaders: true },
    async (ctx) => {
      ctx.setHeader("cache-control", "no-store");
      assertTrustedOrigin(ctx);
      const body = ctx.body as Record<string, unknown> | undefined;
      if (typeof body?.email !== "string" || !body.email.trim() || body.email.length > 320) {
        throw new APIError("BAD_REQUEST", { message: "Email is required" });
      }
      let idpType: Awaited<ReturnType<HubClient["lookup"]>>["idpType"] | undefined;
      if (client) {
        try {
          ({ idpType } = await client.lookup(body.email));
        } catch {
          // Other-tenant, invalid, and failed lookups use the password step. Hub
          // can resolve unknown emails by domain, so they follow that tenant's IdP.
        }
      }
      if (idpType === "entra" && client && sso) {
        const state = randomBytes(32).toString("base64url");
        const verifier = randomBytes(32).toString("base64url");
        let url: string;
        try {
          url = await client.ssoStart(body.email, state, sha256(verifier).toString("base64url"));
        } catch (error) {
          const code = error instanceof HubRequestError ? error.code : undefined;
          if (code === "user_always_native") return ctx.json({ next: "password" });
          sso.onError?.(`start:${code ?? "unavailable"}`);
          if (code && HUB_START_DENIALS.has(code)) {
            throw new APIError("FORBIDDEN", {
              code: HUB_SSO_ACCESS_DENIED,
              message: "Ask your admin for access",
            });
          }
          throw new APIError("BAD_GATEWAY", { message: "Could not continue" });
        }
        // Abandoned sign-ins are never consumed, so expire them here.
        await sso.prisma.verification.deleteMany({
          where: { identifier: { startsWith: SSO_STATE_PREFIX }, expiresAt: { lt: new Date() } },
        });
        const key = ssoStateKey(state);
        await sso.prisma.verification.create({
          data: {
            id: key,
            identifier: key,
            value: await sso.encrypt(verifier),
            expiresAt: new Date(Date.now() + SSO_TTL_MS),
          },
        });
        ctx.setCookie(SSO_COOKIE, state, { ...SSO_COOKIE_OPTIONS, maxAge: SSO_TTL_MS / 1000 });
        return ctx.json({ next: "redirect", url } satisfies SignInContinueResponse);
      }
      const next: SignInContinueResponse["next"] =
        idpType === "entra"
          ? "sso_unavailable"
          : idpType === "google"
            ? "other_sso_unavailable"
            : "password";
      return ctx.json({ next } as SignInContinueResponse);
    },
  );
}

export const localSignInPlugin = {
  id: "cortexai-sign-in",
  endpoints: { signInContinue: signInContinueEndpoint() },
};

export function createHubAuth(
  prisma: PrismaClient,
  config: HubAuthConfig,
  env: {
    tokenEncryptionKey: string;
    baseURL: string;
    webOrigin: string;
    /** Receives fixed reason strings only; never codes, state, tokens or email. */
    onHubSsoError?: (reason: string) => void;
  },
  client = createHubClient(config),
) {
  const encrypt = (data: string) => symmetricEncrypt({ key: env.tokenEncryptionKey, data });
  const redirectUri = new URL(`/api/auth${HUB_SSO_CALLBACK_PATH}`, env.baseURL).href;
  if (config.sso && !redirectUri.startsWith("https://")) {
    throw new Error("Hub SSO requires an HTTPS BETTER_AUTH_URL");
  }
  const authorizeSession = createHubSessionAuthorizer(
    prisma,
    config,
    env.tokenEncryptionKey,
    client,
    {
      verifyCacheTtlMs: config.verifyCacheTtlMs,
      verifyCacheEnabled: config.verifyCacheEnabled,
    },
  );

  /** Shared by password and SSO sign-in: one Hub identity maps to one local user. */
  async function completeHubGrant(ctx: EndpointContext, grant: HubGrant) {
    let sessionId: string | undefined;
    try {
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
        return tx.user.upsert({
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
          sessionId: session.id,
          refreshToken: await encrypt(grant.refreshToken),
          accessUntil: grant.accessUntil,
          accessToken: await encrypt(grant.accessToken),
        },
      });
      await setSessionCookie(ctx, { session, user });
      return { session, user };
    } catch (error) {
      if (sessionId) await prisma.session.deleteMany({ where: { id: sessionId } });
      throw error;
    }
  }

  /** Atomically claims the pending row so a state value works at most once. */
  async function consumeSsoState(state: string) {
    const id = ssoStateKey(state);
    const row = await prisma.verification.findUnique({ where: { id } });
    if (!row) return undefined;
    const claimed = await prisma.verification.deleteMany({ where: { id } });
    if (claimed.count !== 1 || row.expiresAt.getTime() <= Date.now()) return undefined;
    return symmetricDecrypt({ key: env.tokenEncryptionKey, data: row.value });
  }

  const plugin = {
    id: "cortexai-hub",
    endpoints: {
      signInContinue: signInContinueEndpoint(
        client,
        config.sso ? { prisma, encrypt, onError: env.onHubSsoError } : undefined,
      ),
      hubSignIn: createAuthEndpoint(
        "/hub/sign-in",
        { method: "POST", requireHeaders: true },
        async (ctx) => {
          ctx.setHeader("cache-control", "no-store");
          assertTrustedOrigin(ctx);
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
          try {
            const { session, user } = await completeHubGrant(
              ctx,
              await client.login(body.email, body.password),
            );
            return ctx.json({ token: session.token, user });
          } catch (error) {
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
      ...(config.sso
        ? {
            hubSsoCallback: createAuthEndpoint(
              HUB_SSO_CALLBACK_PATH,
              { method: "GET", requireHeaders: true },
              async (ctx) => {
                ctx.setHeader("cache-control", "no-store");
                ctx.setHeader("referrer-policy", "no-referrer");
                // The cookie is single use whatever the outcome.
                const cookieState = ctx.getCookie(SSO_COOKIE);
                ctx.setCookie(SSO_COOKIE, "", { ...SSO_COOKIE_OPTIONS, maxAge: 0 });
                const fail = (error: SsoCallbackError, reason: string) => {
                  env.onHubSsoError?.(`callback:${reason}`);
                  return ctx.redirect(new URL(`/sign-in?error=${error}`, env.webOrigin).href);
                };
                const query = new URL(ctx.request?.url ?? "http://invalid").searchParams;
                if (query.has("error")) throw fail("sso_failed", "idp_error");
                const code = query.get("code");
                const state = query.get("state");
                if (
                  !code ||
                  !state ||
                  code.length > 256 ||
                  state.length < 16 ||
                  state.length > 256 ||
                  !BASE64URL.test(code) ||
                  !BASE64URL.test(state)
                )
                  throw fail("sso_expired", "invalid_request");
                // Login CSRF: the state must be the one this browser started with.
                if (!cookieState || !timingSafeEqual(sha256(cookieState), sha256(state)))
                  throw fail("sso_expired", "state_mismatch");
                const verifier = await consumeSsoState(state);
                if (!verifier) throw fail("sso_expired", "state_unknown");
                let grant: HubGrant;
                try {
                  grant = await client.ssoExchange(code, verifier, redirectUri);
                } catch (error) {
                  throw fail(
                    "sso_failed",
                    `exchange:${(error instanceof HubRequestError && error.code) || "rejected"}`,
                  );
                }
                try {
                  await completeHubGrant(ctx, grant);
                } catch {
                  await client.revoke(grant.refreshToken).catch(() => undefined);
                  throw fail("sso_failed", "session");
                }
                throw ctx.redirect(new URL("/app", env.webOrigin).href);
              },
            ),
          }
        : {}),
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

/** The only auth paths that may create a session in Hub mode. */
export const HUB_SESSION_PATHS = ["/hub/sign-in", HUB_SSO_CALLBACK_PATH];

export function rejectHubAccountMutation(path: string) {
  if (
    ![
      ...HUB_SESSION_PATHS,
      "/hub/sign-in/continue",
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
