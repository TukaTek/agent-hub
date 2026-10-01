import { createHash } from "node:crypto";
import { readBoundedJsonResponse } from "@cortexai-agent-hub/core";

export interface HubServiceCredential {
  apiId: string;
  secret: string;
}
export interface HubAuthConfig {
  origin: string;
  /** Optional deployment restriction. Tenant identity is discovered at login. */
  tenantId?: string;
  /** Hub-issued id of this Agent Hub deployment in Hub's deployment registry. */
  deploymentId?: string;
  /** Cache TTL in milliseconds for Hub session verification. Default: 30000 (30s) */
  verifyCacheTtlMs?: number;
  /** Whether to enable Hub session verification caching. Default: true */
  verifyCacheEnabled?: boolean;
  /** Present only when tenant Entra SSO is enabled; implies tenantId and deploymentId. */
  sso?: HubServiceCredential;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * SSO settings are read only when `readSecretFile` is given, so processes that
 * never start sign-in (the worker) do not need the service secret mounted.
 */
export function hubAuthFromEnv(
  source: NodeJS.ProcessEnv,
  options: { readSecretFile?: (path: string) => string } = {},
): HubAuthConfig | undefined {
  const mode = source.AUTH_MODE ?? "local";
  const ssoFlag = source.HUB_SSO_ENABLED?.trim() || "false";
  if (ssoFlag !== "true" && ssoFlag !== "false") {
    throw new Error("HUB_SSO_ENABLED must be true or false");
  }
  const ssoEnabled = Boolean(options.readSecretFile) && ssoFlag === "true";
  if (ssoEnabled && mode !== "hub") throw new Error("HUB_SSO_ENABLED requires AUTH_MODE=hub");
  if (mode === "local") return undefined;
  if (mode !== "hub") throw new Error("AUTH_MODE must be local or hub");
  const url = new URL(source.HUB_AUTH_ORIGIN?.trim() || "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("HUB_AUTH_ORIGIN must be an HTTPS origin");
  }
  let cacheTtlMs: number | undefined;
  if (source.HUB_VERIFY_CACHE_TTL_MS) {
    const raw = source.HUB_VERIFY_CACHE_TTL_MS.trim();
    // Reject malformed values like "30000junk" by checking the raw string matches /^\d+$/
    if (!/^\d+$/.test(raw)) {
      throw new Error("HUB_VERIFY_CACHE_TTL_MS must be a non-negative integer");
    }
    cacheTtlMs = parseInt(raw, 10);
    // Reject Infinity and values outside safe integer range
    if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 0) {
      throw new Error("HUB_VERIFY_CACHE_TTL_MS must be a non-negative safe integer");
    }
  }

  const cacheEnabled =
    source.HUB_VERIFY_CACHE_ENABLED === undefined
      ? undefined
      : source.HUB_VERIFY_CACHE_ENABLED !== "false";

  const tenantId = source.HUB_AUTH_TENANT_ID?.trim();
  const deploymentId = source.HUB_DEPLOYMENT_ID?.trim();
  if (deploymentId && !UUID.test(deploymentId)) {
    throw new Error("HUB_DEPLOYMENT_ID must be the deployment UUID issued by CortexAI Hub");
  }
  let sso: HubServiceCredential | undefined;
  if (ssoEnabled) {
    if (!tenantId) throw new Error("HUB_SSO_ENABLED requires HUB_AUTH_TENANT_ID");
    if (tenantId.length > 256) throw new Error("HUB_AUTH_TENANT_ID must be at most 256 characters");
    if (!deploymentId) throw new Error("HUB_SSO_ENABLED requires HUB_DEPLOYMENT_ID");
    const apiId = source.HUB_SERVICE_API_ID?.trim();
    if (!apiId) throw new Error("HUB_SSO_ENABLED requires HUB_SERVICE_API_ID");
    if (apiId.length > 256) throw new Error("HUB_SERVICE_API_ID must be at most 256 characters");
    const secretFile = source.HUB_SERVICE_SECRET_FILE?.trim();
    if (!secretFile) throw new Error("HUB_SSO_ENABLED requires HUB_SERVICE_SECRET_FILE");
    let secret: string;
    try {
      secret = options.readSecretFile!(secretFile).trim();
    } catch {
      throw new Error("HUB_SERVICE_SECRET_FILE could not be read");
    }
    if (!secret) throw new Error("HUB_SERVICE_SECRET_FILE is empty");
    if (secret.length > 4096)
      throw new Error("HUB_SERVICE_SECRET_FILE must hold at most 4096 characters");
    sso = { apiId, secret };
  }

  return {
    origin: url.origin,
    ...(tenantId ? { tenantId } : {}),
    ...(deploymentId ? { deploymentId: deploymentId.toLowerCase() } : {}),
    ...(cacheTtlMs !== undefined ? { verifyCacheTtlMs: cacheTtlMs } : {}),
    ...(cacheEnabled !== undefined ? { verifyCacheEnabled: cacheEnabled } : {}),
    ...(sso ? { sso } : {}),
  };
}
export class HubUnsupportedIdpError extends Error {
  constructor() {
    super("This organization’s sign-in method is not supported yet");
  }
}

export interface HubIdentity {
  subject: string;
  tenant: string;
}
export interface HubGrant extends HubIdentity {
  accessToken: string;
  refreshToken: string;
  accessUntil: Date;
  displayName?: string;
}
export function hubUserId(origin: string, tenant: string, subject: string): string {
  return `hub_${createHash("sha256")
    .update(JSON.stringify([origin, tenant, subject]))
    .digest("hex")}`;
}
const PRODUCT = "cortexai-agent-hub";
const RETURN_CHANNEL = "agent-hub-web";
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Hub response");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Invalid Hub response");
  return value.trim();
}
function enabled(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some(
      (entry) =>
        entry && typeof entry === "object" && entry.id === PRODUCT && entry.enabled === true,
    )
  );
}
function expiry(value: unknown): Date {
  const date = new Date(text(value));
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now())
    throw new Error("Hub session expired");
  return date;
}
/** A non-2xx Hub reply. `code` is Hub's fixed `error` value, never free-form text. */
export class HubRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super("Hub access denied");
  }
}
/**
 * Hub's sso-start has no fields for re-authentication or a login hint, so add the
 * standard OIDC parameters to a direct authorization request. `prompt=login` keeps
 * an IdP session left in a shared browser from silently signing the next person in
 * after an Agent Hub sign-out. The browser can strip it, so Hub must also enforce it.
 */
function interactiveAuthorizeUrl(url: URL, email: string): URL {
  if (!url.searchParams.has("client_id") || !url.searchParams.has("response_type")) return url;
  url.searchParams.set("prompt", "login");
  if (!url.searchParams.has("login_hint")) url.searchParams.set("login_hint", email);
  return url;
}
/** Hub issues 300 s service tokens; renew this long before expiry. */
const SERVICE_TOKEN_RENEW_MS = 45_000;
/** Hub accepts `Bearer <token>` with no whitespace, up to 16384 characters. */
const SERVICE_TOKEN = /^[^\s]{1,16384}$/;
export function createHubClient(config: HubAuthConfig, fetcher: typeof fetch = fetch) {
  async function request(path: string, body?: unknown, accessToken?: string, limit = 64 * 1024) {
    const signal = AbortSignal.timeout(8_000);
    const response = await fetcher(new URL(path, config.origin), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      const reply = await readBoundedJsonResponse<{ error?: unknown }>(
        response,
        4096,
        signal,
      ).catch(() => undefined);
      const code = typeof reply?.error === "string" ? reply.error : undefined;
      throw new HubRequestError(
        response.status,
        code && /^[a-z_]{1,64}$/.test(code) ? code : undefined,
      );
    }
    return record(await readBoundedJsonResponse(response, limit, signal));
  }
  /** UUIDs are case-insensitive; the configured id is stored lowercase. */
  const isThisDeployment = (value: unknown) =>
    typeof value === "string" && value.toLowerCase() === config.deploymentId;
  function identity(subject: unknown, tenant: unknown): HubIdentity {
    const result = { subject: text(subject), tenant: text(tenant) };
    if (config.tenantId && result.tenant !== config.tenantId) throw new Error("Hub access denied");
    return result;
  }
  async function verify(accessToken: string, expected: HubIdentity): Promise<void> {
    const session = await request("/api/tenant-auth/session", undefined, accessToken);
    if (session.valid !== true) throw new Error("Hub access denied");
    const actual = identity(session.userId, session.tenantId);
    if (actual.subject !== expected.subject || actual.tenant !== expected.tenant)
      throw new Error("Hub identity changed");
    // Hub binds SSO sessions to a product and deployment; password sessions carry neither.
    if (session.product != null && session.product !== PRODUCT)
      throw new Error("Hub access denied");
    if (session.deploymentId != null && !isThisDeployment(session.deploymentId))
      throw new Error("Hub access denied");
    // The config payload can contain credentials. Consume only its entitlement;
    // never expose, persist, or log this response as browser authentication state.
    const configResponse = await request(
      `/api/tenant-auth/config?product=${PRODUCT}`,
      undefined,
      accessToken,
      2 * 1024 * 1024,
    );
    if (configResponse.product !== PRODUCT || !enabled(configResponse.products))
      throw new Error("Hub access denied");
  }
  async function grant(body: Record<string, unknown>, expectedTenant?: string): Promise<HubGrant> {
    if (body.success !== true) throw new Error("Hub access denied");
    const user = record(body.user);
    const result: HubGrant = {
      ...identity(user.id, user.tenantId),
      accessToken: text(body.accessToken),
      refreshToken: text(body.refreshToken),
      accessUntil: expiry(body.accessTokenExpiresAt),
      ...(typeof user.displayName === "string" && user.displayName.trim()
        ? { displayName: user.displayName.trim() }
        : {}),
    };
    if (expectedTenant && result.tenant !== expectedTenant) throw new Error("Hub identity changed");
    expiry(body.refreshTokenExpiresAt);
    if (!enabled(body.products)) throw new Error("Hub access denied");
    await verify(result.accessToken, result);
    return result;
  }
  /** Throws for other-tenant, invalid, or failed lookups. */
  async function lookup(email: string): Promise<{
    tenant: string;
    idpType: "native" | "entra" | "google";
  }> {
    const found = await request("/api/tenant-auth/lookup", { email: email.trim() });
    const tenant = text(found.tenantId);
    if (config.tenantId && tenant !== config.tenantId) throw new Error("Hub access denied");
    if (found.idpType !== "native" && found.idpType !== "entra" && found.idpType !== "google") {
      throw new Error("Invalid Hub response");
    }
    return { tenant, idpType: found.idpType };
  }
  let serviceToken: { value: string; expiresAt: number } | undefined;
  let pendingServiceToken: Promise<string> | undefined;
  async function fetchServiceToken(): Promise<string> {
    const credential = sso();
    // Hub's schema is strict: any other field is rejected as invalid_request.
    const reply = await request("/api/agent-hub/service-token", {
      apiId: credential.apiId,
      secret: credential.secret,
      tenantId: config.tenantId,
    });
    const value = reply.token;
    if (
      reply.tokenType !== "Bearer" ||
      typeof value !== "string" ||
      !SERVICE_TOKEN.test(value) ||
      typeof reply.expiresIn !== "number" ||
      !(reply.expiresIn > 0)
    )
      throw new Error("Invalid Hub response");
    serviceToken = { value, expiresAt: Date.now() + reply.expiresIn * 1000 };
    return value;
  }
  /**
   * The client serves one pinned tenant, so this cache is per tenant. Concurrent
   * callers share one in-flight renewal to stay under Hub's per-credential limit.
   */
  function currentServiceToken(): Promise<string> {
    if (serviceToken && serviceToken.expiresAt - Date.now() > SERVICE_TOKEN_RENEW_MS)
      return Promise.resolve(serviceToken.value);
    pendingServiceToken ??= fetchServiceToken().finally(() => {
      pendingServiceToken = undefined;
    });
    return pendingServiceToken;
  }
  function sso(): HubServiceCredential {
    if (!config.sso || !config.tenantId || !config.deploymentId)
      throw new Error("Hub SSO is not configured");
    return config.sso;
  }
  async function serviceRequest(path: string, body: Record<string, unknown>) {
    const token = await currentServiceToken();
    try {
      return await request(path, body, token);
    } catch (error) {
      // Keep a token another caller already renewed; drop only the rejected one.
      if (
        error instanceof HubRequestError &&
        error.code === "invalid_service_token" &&
        serviceToken?.value === token
      )
        serviceToken = undefined;
      throw error;
    }
  }
  return {
    verify,
    lookup,
    /** Returns Hub's authorize URL. `state` and `codeChallenge` are the caller's own. */
    async ssoStart(email: string, state: string, codeChallenge: string): Promise<string> {
      sso();
      const body = {
        tenantId: config.tenantId,
        email: email.trim(),
        product: PRODUCT,
        returnChannel: RETURN_CHANNEL,
        deploymentId: config.deploymentId,
        state,
        codeChallenge,
        codeChallengeMethod: "S256",
      };
      let reply: Record<string, unknown>;
      try {
        reply = await serviceRequest("/api/tenant-auth/sso-start", body);
      } catch (error) {
        // Start consumes nothing, so one retry with a freshly issued token is safe.
        if (!(error instanceof HubRequestError && error.code === "invalid_service_token"))
          throw error;
        reply = await serviceRequest("/api/tenant-auth/sso-start", body);
      }
      const url = new URL(text(reply.authorizeUrl));
      if (url.protocol !== "https:") throw new Error("Invalid Hub response");
      return interactiveAuthorizeUrl(url, body.email).href;
    },
    /** Hub consumes the code on every attempt, so callers must never retry with the same code. */
    async ssoExchange(code: string, codeVerifier: string, redirectUri: string) {
      sso();
      const reply = await serviceRequest("/api/agent-hub/sso-exchange", {
        code,
        codeVerifier,
        returnChannel: RETURN_CHANNEL,
        redirectUri,
      });
      if (reply.tenantId !== config.tenantId || !isThisDeployment(reply.deploymentId))
        throw new Error("Hub access denied");
      return grant(reply, config.tenantId);
    },
    async login(email: string, password: string) {
      const { tenant, idpType } = await lookup(email);
      if (idpType !== "native") throw new HubUnsupportedIdpError();
      const result = await grant(
        await request("/api/tenant-auth/login", { email: email.trim(), password }),
        tenant,
      );
      if (result.tenant !== tenant) throw new Error("Hub identity changed");
      return result;
    },
    refresh: async (refreshToken: string) =>
      grant(await request("/api/tenant-auth/refresh", { refreshToken })),
    revoke: async (refreshToken: string) => {
      await request("/api/tenant-auth/revoke", { refreshToken });
    },
  };
}
