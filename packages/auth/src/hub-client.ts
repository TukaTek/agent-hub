import { createHash } from "node:crypto";
import { readBoundedJsonResponse } from "@cortexai-agent-hub/core";

export interface HubAuthConfig {
  origin: string;
  /** Optional deployment restriction. Tenant identity is discovered at login. */
  tenantId?: string;
}
export function hubAuthFromEnv(source: NodeJS.ProcessEnv): HubAuthConfig | undefined {
  const mode = source.AUTH_MODE ?? "local";
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
  return {
    origin: url.origin,
    ...(source.HUB_AUTH_TENANT_ID?.trim() ? { tenantId: source.HUB_AUTH_TENANT_ID.trim() } : {}),
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
      await response.body?.cancel();
      throw new Error("Hub access denied");
    }
    return record(await readBoundedJsonResponse(response, limit, signal));
  }
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
  return {
    verify,
    async login(email: string, password: string) {
      const lookup = await request("/api/tenant-auth/lookup", { email: email.trim() });
      const tenant = text(lookup.tenantId);
      if (config.tenantId && tenant !== config.tenantId) throw new Error("Hub access denied");
      if (lookup.idpType !== "native") throw new HubUnsupportedIdpError();
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
