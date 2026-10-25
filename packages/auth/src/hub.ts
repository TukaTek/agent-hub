import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  HUB_ACCESS_DENIED,
  HUB_SIGN_IN_UNAVAILABLE_MESSAGE,
  HUB_SSO_ACCESS_DENIED,
  HUB_UNAVAILABLE,
  hubRefusalCallbackError,
  type NativeSsoCallbackError,
  type NativeSsoClient,
  type NativeSsoStartResponse,
  type SignInContinueResponse,
  TENANT_DISABLED,
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
import { isAppChallenge, isAppVerifier, nativeReturnTo } from "./hub-native-sso.js";
import { disabledHubPolicy, type HubPolicy, notConfiguredHubPolicy } from "./hub-policy.js";
import { HubPolicyError } from "./hub-policy-contract.js";
import { createHubSessionAuthorizer } from "./hub-sessions.js";

type HubClient = ReturnType<typeof createHubClient>;
type EndpointContext = Parameters<typeof setSessionCookie>[0];

export const HUB_SSO_CALLBACK_PATH = "/hub/sso/callback";
const HUB_SSO_NATIVE_START_PATH = "/hub/sso/native/start";
const HUB_SSO_NATIVE_COMPLETE_PATH = "/hub/sso/native/complete";
const SSO_COOKIE = "__Host-ah_sso";
const SSO_TTL_MS = 10 * 60_000;
/** How long a native app has to redeem the handoff code the callback sent it. */
const HANDOFF_TTL_MS = 60_000;
const HANDOFF_CODE = /^[A-Za-z0-9_-]{43}$/;
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
/** Hub callback `?error=` reasons a native app tells apart; any other is `sso_failed`. */
const HUB_CALLBACK_ERRORS = new Map<string, NativeSsoCallbackError>([
  // The user has no Agent Hub assignment.
  ["access_denied", hubRefusalCallbackError(HUB_ACCESS_DENIED)],
  ["login_cancelled", "sso_cancelled"],
]);

/**
 * Per client address, as resolved from the reverse proxy's single X-Forwarded-For value.
 * Loose enough that a proxy hop which collapses every user into one address slows
 * sign-in instead of locking a team out; Hub enforces its own login lockout.
 */
const HUB_SIGN_IN_RATE_LIMIT = { window: 60, max: 30 } as const;
export const HUB_SIGN_IN_RATE_LIMITS = {
  "/hub/sign-in": HUB_SIGN_IN_RATE_LIMIT,
  "/hub/sign-in/continue": HUB_SIGN_IN_RATE_LIMIT,
  [HUB_SSO_NATIVE_START_PATH]: HUB_SIGN_IN_RATE_LIMIT,
  [HUB_SSO_NATIVE_COMPLETE_PATH]: HUB_SIGN_IN_RATE_LIMIT,
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

/** Hub could not be reached: a connection failure, a timeout, or a Hub-side 5xx. */
function hubUnreachable(error: unknown) {
  if (error instanceof HubRequestError)
    return error.status === 408 || error.status === 429 || error.status >= 500;
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || error.name === "AbortError" || error instanceof TypeError;
}

/** The refusal a client sees when Hub policy stops a sign-in. Never carries a value. */
function hubRefusal(error: HubPolicyError) {
  if (error.code === HUB_ACCESS_DENIED)
    return new APIError("FORBIDDEN", { code: error.code, message: "Ask your admin for access" });
  return new APIError(error.code === TENANT_DISABLED ? "FORBIDDEN" : "SERVICE_UNAVAILABLE", {
    code: error.code,
    message: HUB_SIGN_IN_UNAVAILABLE_MESSAGE,
  });
}

/** Policy refusals, and a Hub that dropped mid-sign-in, as the stable refusal error. */
function asHubPolicyError(error: unknown): HubPolicyError | undefined {
  if (error instanceof HubPolicyError) return error;
  if (hubUnreachable(error)) return new HubPolicyError(HUB_UNAVAILABLE, "unreachable");
  return undefined;
}

/** Runs the gate; a refusal becomes the client-facing error. */
async function gate(policy: Pick<HubPolicy, "check">) {
  try {
    await policy.check();
  } catch (error) {
    throw hubRefusal(asHubPolicyError(error) ?? new HubPolicyError(HUB_UNAVAILABLE, "gate"));
  }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();
/** Rows are keyed by a hash so the database never holds a usable state value. */
const ssoStateKey = (state: string) => `${SSO_STATE_PREFIX}${sha256(state).toString("hex")}`;

const isEmail = (value: unknown): value is string =>
  typeof value === "string" && Boolean(value.trim()) && value.length <= 320;
const isState = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 16 && value.length <= 256 && BASE64URL.test(value);
/** Constant time for equal-length inputs, and the lengths themselves are hashed away. */
const safeEqual = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

type SsoStore = {
  prisma: PrismaClient;
  encrypt: (data: string) => Promise<string>;
  onError?: (reason: string) => void;
};

/** Hub's IdP for this email; undefined when the lookup fails. */
async function lookupIdp(client: Pick<HubClient, "lookup">, email: string) {
  try {
    return (await client.lookup(email)).idpType;
  } catch {
    // Other-tenant, invalid, and failed lookups use the password step. Hub
    // can resolve unknown emails by domain, so they follow that tenant's IdP.
    return undefined;
  }
}

/**
 * Starts Hub SSO with a fresh state and a PKCE verifier that stays server-side, in a
 * `verification` row keyed by the state's hash. Undefined when Hub answers that this
 * user is Always Native and signs in with a password.
 */
async function startHubSso(
  client: Pick<HubClient, "ssoStart">,
  sso: SsoStore,
  email: string,
  reason: string,
): Promise<{ state: string; url: string } | undefined> {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  let url: string;
  try {
    url = await client.ssoStart(email, state, sha256(verifier).toString("base64url"));
  } catch (error) {
    const code = error instanceof HubRequestError ? error.code : undefined;
    if (code === "user_always_native") return undefined;
    sso.onError?.(`${reason}:${code ?? "unavailable"}`);
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
  return { state, url };
}

/**
 * Without a Hub client (local auth) every email continues to the password step.
 * With one, Hub policy must admit sign-in before Hub is asked about the email.
 */
function signInContinueEndpoint(
  client?: Pick<HubClient, "lookup" | "ssoStart">,
  policy?: Pick<HubPolicy, "check">,
  sso?: SsoStore,
) {
  return createAuthEndpoint(
    "/hub/sign-in/continue",
    { method: "POST", requireHeaders: true },
    async (ctx) => {
      ctx.setHeader("cache-control", "no-store");
      assertTrustedOrigin(ctx);
      const body = ctx.body as Record<string, unknown> | undefined;
      if (!isEmail(body?.email)) {
        throw new APIError("BAD_REQUEST", { message: "Email is required" });
      }
      if (client && !policy) throw new Error("Hub sign-in requires the Hub policy gate");
      if (policy) await gate(policy);
      const idpType = client ? await lookupIdp(client, body.email) : undefined;
      if (idpType === "entra" && client && sso) {
        const started = await startHubSso(client, sso, body.email, "start");
        if (!started) return ctx.json({ next: "password" });
        ctx.setCookie(SSO_COOKIE, started.state, {
          ...SSO_COOKIE_OPTIONS,
          maxAge: SSO_TTL_MS / 1000,
        });
        return ctx.json({ next: "redirect", url: started.url } satisfies SignInContinueResponse);
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
    /** CAAH-36: Hub policy gates every sign-in and every continuing session. */
    hubPolicy?: HubPolicy;
  },
  client = createHubClient(config),
) {
  // The config is the authority on whether Hub policy applies, whatever policy the
  // caller passed: not configured admits nothing (F1), disabled skips it (CAAH-83).
  const policy = config.notConfigured
    ? notConfiguredHubPolicy({ missing: config.notConfigured.missing.map((item) => item.name) })
    : config.policyDisabled
      ? disabledHubPolicy({ tenantId: config.tenantId })
      : env.hubPolicy;
  if (!policy) throw new Error("Hub mode requires the Hub policy gate");
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
      policy,
    },
  );

  /**
   * Shared by password and SSO sign-in: one Hub identity maps to one local user.
   * Hub policy must admit this identity before anything local is created.
   */
  async function completeHubGrant(ctx: EndpointContext, grant: HubGrant) {
    await policy!.admit({ tenant: grant.tenant, subject: grant.subject });
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
      await bootstrapUserSpace(prisma, user, {
        signupsEnabled: "false",
        signupAllowlist: undefined,
      });
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

  const decrypt = (data: string) => symmetricDecrypt({ key: env.tokenEncryptionKey, data });
  const sealGrant = (grant: HubGrant) => encrypt(JSON.stringify(grant));
  async function openGrant(cipher: string): Promise<HubGrant> {
    const grant = JSON.parse(await decrypt(cipher)) as HubGrant & { accessUntil: string };
    return { ...grant, accessUntil: new Date(grant.accessUntil) };
  }
  /** Nothing local will hold this grant, so revoke it at Hub; best effort. */
  async function revokeSealedGrant(cipher: string | null) {
    if (!cipher) return;
    try {
      await client.revoke((await openGrant(cipher)).refreshToken);
    } catch {
      // Hub expires the grant itself if it can't be reached.
    }
  }

  /** A desktop or mobile sign-in still waiting for, or holding, its handoff. */
  async function pendingNativeSignIn(state: string) {
    const row = await prisma.hubSsoNative.findUnique({ where: { stateKey: ssoStateKey(state) } });
    return row && row.expiresAt.getTime() > Date.now() ? row : undefined;
  }

  /** Atomically claims a native row, so only one caller acts on it. */
  async function claimNativeSignIn(row: { stateKey: string; handoffHash: string | null }) {
    const claimed = await prisma.hubSsoNative.deleteMany({
      where: { stateKey: row.stateKey, handoffHash: row.handoffHash },
    });
    return claimed.count === 1;
  }

  /** Abandoned native sign-ins are never redeemed, so expire them and revoke their grants. */
  async function removeExpiredNativeSignIns() {
    const now = new Date();
    const unredeemed = await prisma.hubSsoNative.findMany({
      where: { expiresAt: { lt: now }, grantCipher: { not: null } },
    });
    for (const row of unredeemed) {
      if (await claimNativeSignIn(row)) await revokeSealedGrant(row.grantCipher);
    }
    await prisma.hubSsoNative.deleteMany({ where: { expiresAt: { lt: now } } });
  }

  /** Admits the grant, then stores it sealed against the hash of a new one-time code. */
  async function issueHandoff(stateKey: string, grant: HubGrant) {
    await policy!.admit({ tenant: grant.tenant, subject: grant.subject });
    const handoff = randomBytes(32).toString("base64url");
    const issued = await prisma.hubSsoNative.updateMany({
      where: { stateKey, handoffHash: null },
      data: {
        handoffHash: sha256(handoff).toString("hex"),
        grantCipher: await sealGrant(grant),
        expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
      },
    });
    if (issued.count !== 1) throw new Error("Handoff already issued");
    return handoff;
  }

  /** Spends the handoff whatever happens next, so every code gets exactly one try. */
  async function redeemHandoff(code: string) {
    const row = await prisma.hubSsoNative.findUnique({
      where: { handoffHash: sha256(code).toString("hex") },
    });
    return row && (await claimNativeSignIn(row)) ? row : undefined;
  }

  const plugin = {
    id: "cortexai-hub",
    endpoints: {
      signInContinue: signInContinueEndpoint(
        client,
        policy,
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
          await gate(policy);
          let grant: HubGrant;
          try {
            grant = await client.login(body.email, body.password);
          } catch (error) {
            if (hubUnreachable(error))
              throw hubRefusal(new HubPolicyError(HUB_UNAVAILABLE, "unreachable"));
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
          try {
            const { session, user } = await completeHubGrant(ctx, grant);
            return ctx.json({ token: session.token, user });
          } catch (error) {
            // Nothing local holds this grant, so revoke it at Hub, as SSO does (F6).
            await client.revoke(grant.refreshToken).catch(() => undefined);
            if (error instanceof HubPolicyError) throw hubRefusal(error);
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
                const query = new URL(ctx.request?.url ?? "http://invalid").searchParams;
                const code = query.get("code");
                const state = query.get("state");
                // A sign-in a native app started goes back to that app, never to a session here.
                const native = isState(state) ? await pendingNativeSignIn(state) : undefined;
                const toApp = (params: Record<string, string>) => {
                  const url = new URL(native!.returnTo);
                  for (const [key, value] of Object.entries(params))
                    url.searchParams.set(key, value);
                  url.searchParams.set("state", state!);
                  return url.href;
                };
                const fail = (error: NativeSsoCallbackError, reason: string) => {
                  env.onHubSsoError?.(`callback:${reason}`);
                  return ctx.redirect(
                    native
                      ? toApp({ error })
                      : new URL(`/sign-in?error=${error}`, env.webOrigin).href,
                  );
                };
                if (query.has("error")) {
                  // The web keeps one generic failure; only native apps tell the reasons apart.
                  if (!native) throw fail("sso_failed", "idp_error");
                  // The app learns of the refusal, so this state can't be finished later.
                  await consumeSsoState(state!);
                  await prisma.hubSsoNative.deleteMany({ where: { stateKey: native.stateKey } });
                  const error = HUB_CALLBACK_ERRORS.get(query.get("error")!) ?? "sso_failed";
                  throw fail(error, `idp_error:${error}`);
                }
                if (!code || !isState(state) || code.length > 256 || !BASE64URL.test(code))
                  throw fail("sso_expired", "invalid_request");
                // Login CSRF: a web sign-in must return to the browser that started it. A
                // native one is bound to the app's PKCE pair, checked when it redeems.
                if (!native && (!cookieState || !safeEqual(cookieState, state)))
                  throw fail("sso_expired", "state_mismatch");
                const verifier = await consumeSsoState(state);
                if (!verifier) throw fail("sso_expired", "state_unknown");
                const refuse = (error: HubPolicyError, step: string) =>
                  fail(hubRefusalCallbackError(error.code), `${step}:${error.code.toLowerCase()}`);
                try {
                  await policy.check();
                } catch (error) {
                  throw refuse(
                    asHubPolicyError(error) ?? new HubPolicyError(HUB_UNAVAILABLE, "gate"),
                    "policy",
                  );
                }
                let grant: HubGrant;
                try {
                  grant = await client.ssoExchange(code, verifier, redirectUri);
                } catch (error) {
                  if (hubUnreachable(error))
                    throw refuse(new HubPolicyError(HUB_UNAVAILABLE, "unreachable"), "exchange");
                  throw fail(
                    "sso_failed",
                    `exchange:${(error instanceof HubRequestError && error.code) || "rejected"}`,
                  );
                }
                let handoff: string | undefined;
                try {
                  if (native) handoff = await issueHandoff(native.stateKey, grant);
                  else await completeHubGrant(ctx, grant);
                } catch (error) {
                  await client.revoke(grant.refreshToken).catch(() => undefined);
                  if (error instanceof HubPolicyError) throw refuse(error, "admit");
                  throw fail("sso_failed", native ? "handoff" : "session");
                }
                throw ctx.redirect(
                  handoff ? toApp({ code: handoff }) : new URL("/app", env.webOrigin).href,
                );
              },
            ),
            hubSsoNativeStart: createAuthEndpoint(
              HUB_SSO_NATIVE_START_PATH,
              { method: "POST", requireHeaders: true },
              async (ctx) => {
                ctx.setHeader("cache-control", "no-store");
                assertTrustedOrigin(ctx);
                const body = ctx.body as Record<string, unknown> | undefined;
                const returnTo = nativeReturnTo(body?.client, body?.returnTo);
                if (!isEmail(body?.email) || !returnTo || !isAppChallenge(body?.appChallenge))
                  throw new APIError("BAD_REQUEST", { message: "Invalid sign-in request" });
                await gate(policy);
                const idpType = await lookupIdp(client, body.email);
                const started =
                  idpType === "entra"
                    ? await startHubSso(
                        client,
                        { prisma, encrypt, onError: env.onHubSsoError },
                        body.email,
                        "native:start",
                      )
                    : undefined;
                if (!started) {
                  const next = idpType === "google" ? "other_sso_unavailable" : "password";
                  return ctx.json({ next } satisfies NativeSsoStartResponse);
                }
                await removeExpiredNativeSignIns();
                await prisma.hubSsoNative.create({
                  data: {
                    stateKey: ssoStateKey(started.state),
                    client: body.client as NativeSsoClient,
                    returnTo,
                    appChallenge: body.appChallenge,
                    expiresAt: new Date(Date.now() + SSO_TTL_MS),
                  },
                });
                return ctx.json({
                  next: "redirect",
                  authorizeUrl: started.url,
                  state: started.state,
                } satisfies NativeSsoStartResponse);
              },
            ),
            hubSsoNativeComplete: createAuthEndpoint(
              HUB_SSO_NATIVE_COMPLETE_PATH,
              { method: "POST", requireHeaders: true },
              async (ctx) => {
                ctx.setHeader("cache-control", "no-store");
                assertTrustedOrigin(ctx);
                const body = ctx.body as Record<string, unknown> | undefined;
                const { code, state, appVerifier } = body ?? {};
                if (
                  typeof code !== "string" ||
                  !HANDOFF_CODE.test(code) ||
                  !isState(state) ||
                  !isAppVerifier(appVerifier)
                )
                  throw new APIError("BAD_REQUEST", { message: "Invalid sign-in request" });
                const expired = (reason: string) => {
                  env.onHubSsoError?.(`complete:${reason}`);
                  return new APIError("BAD_REQUEST", { message: "Your sign-in expired" });
                };
                const handoff = await redeemHandoff(code);
                if (!handoff?.grantCipher) throw expired("unknown");
                if (handoff.expiresAt.getTime() <= Date.now()) {
                  await revokeSealedGrant(handoff.grantCipher);
                  throw expired("expired");
                }
                if (
                  !safeEqual(handoff.stateKey, ssoStateKey(state)) ||
                  !safeEqual(handoff.appChallenge, sha256(appVerifier).toString("base64url"))
                ) {
                  await revokeSealedGrant(handoff.grantCipher);
                  throw expired("mismatch");
                }
                const grant = await openGrant(handoff.grantCipher);
                try {
                  await gate(policy);
                  const { session, user } = await completeHubGrant(ctx, grant);
                  // Mobile keeps a bearer, swapped for the signed one like password sign-in's.
                  // Desktop's renderer runs on this origin and relies on the HttpOnly cookie.
                  return ctx.json(
                    handoff.client === ("mobile" satisfies NativeSsoClient)
                      ? { token: session.token, user }
                      : { user },
                  );
                } catch (error) {
                  await client.revoke(grant.refreshToken).catch(() => undefined);
                  if (error instanceof APIError) throw error;
                  if (error instanceof HubPolicyError) throw hubRefusal(error);
                  throw new APIError("UNAUTHORIZED", {
                    message: "Could not sign in through CortexAI Hub",
                  });
                }
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
export const HUB_SESSION_PATHS = [
  "/hub/sign-in",
  HUB_SSO_CALLBACK_PATH,
  HUB_SSO_NATIVE_COMPLETE_PATH,
];

export function rejectHubAccountMutation(path: string) {
  if (
    ![
      ...HUB_SESSION_PATHS,
      "/hub/sign-in/continue",
      HUB_SSO_NATIVE_START_PATH,
      "/get-session",
      "/account-security",
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
