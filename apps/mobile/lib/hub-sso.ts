import { HUB_ACCESS_DENIED, HUB_SSO_ACCESS_DENIED } from "@cortexai-agent-hub/core";
import { clearSpace, currentApiBase, fetchMobileJson } from "./api";
import { t } from "./i18n";
import {
  currentSessionGeneration,
  replaceSessionTokenIfCurrent,
  tokenFromAuthResponse,
} from "./session";
import { authResponseErrorText, sessionSaveErrorText } from "./user-error";

const RETURN_TO = "cortexai-agent-hub://hub-sso";
const ORIGIN = "cortexai-agent-hub://";

/** `cancelled` covers the user closing Microsoft and a server or session change meanwhile. */
export type HubSsoResult = "signed_in" | "password" | "other_sso_unavailable" | "cancelled" | "busy";

let inFlight = false;

/**
 * Hub's native SSO handoff (docs/hub-auth.md, "Native SSO"). The app PKCE verifier stays in this
 * call and leaves the device only in the complete request. Nothing here logs.
 */
export async function continueWithHubSso(email: string): Promise<HubSsoResult> {
  if (inFlight) return "busy";
  inFlight = true;
  try {
    const apiBase = currentApiBase();
    const generation = currentSessionGeneration();
    const changed = () =>
      apiBase !== currentApiBase() || generation !== currentSessionGeneration();
    const failed = () => new Error(t("Sign-in failed. Try again."));

    const { verifier, challenge } = await pkcePair();
    const start = await postJson<{ next?: unknown; authorizeUrl?: unknown; state?: unknown }>(
      `${apiBase}/api/auth/hub/sso/native/start`,
      { email: email.trim(), client: "mobile", returnTo: RETURN_TO, appChallenge: challenge },
    );
    if (changed()) return "cancelled";
    if (!start.response.ok || start.invalidJson) {
      if (accessDenied(start.response.status, start.body)) throw accessError();
      throw new Error(authResponseErrorText(start.response.status, start.body, start.invalidJson));
    }
    const { next, authorizeUrl, state } = start.body;
    if (next === "password" || next === "other_sso_unavailable") return next;
    if (next !== "redirect" || typeof state !== "string" || !state || !isHttps(authorizeUrl))
      throw new Error(t("Could not continue"));

    // Defer the native module so password sign-in still works in older binaries.
    const { openAuthSessionAsync } = await import("expo-web-browser").catch(() => {
      throw new Error(t("Could not continue"));
    });
    const result = await openAuthSessionAsync(authorizeUrl, RETURN_TO, {
      preferEphemeralSession: true,
    });
    if (changed() || result.type !== "success") return "cancelled";

    const params = callbackParams(result.url, state);
    if (!params) throw failed();
    if (params.has("error")) {
      const error = params.get("error");
      if (error === "sso_cancelled") return "cancelled";
      throw error === "hub_access_denied" ? accessError() : failed();
    }
    const codes = params.getAll("code");
    if (codes.length !== 1 || !codes[0]) throw failed();

    const complete = await postJson<unknown>(`${apiBase}/api/auth/hub/sso/native/complete`, {
      code: codes[0],
      state,
      appVerifier: verifier,
    }).catch(() => {
      throw failed();
    });
    if (changed()) return "cancelled";
    if (!complete.response.ok || complete.invalidJson)
      throw accessDenied(complete.response.status, complete.body) ? accessError() : failed();
    const token = tokenFromAuthResponse(complete.response, complete.body);
    if (!token) throw failed();
    try {
      if (!(await clearSpace()))
        throw new Error(t("Could not save your sign-in on this device. Try again."));
      if (changed()) return "cancelled";
      return (await replaceSessionTokenIfCurrent(generation, token)) ? "signed_in" : "cancelled";
    } catch (error) {
      throw new Error(sessionSaveErrorText(error));
    }
  } finally {
    inFlight = false;
  }
}

async function pkcePair() {
  // Defer the native module so password sign-in still works in older binaries.
  const Crypto = await import("expo-crypto").catch(() => {
    throw new Error(t("Could not continue"));
  });
  const verifier = base64Url(await Crypto.getRandomBytesAsync(32));
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  return { verifier, challenge: base64Url(digest) };
}

function base64Url(value: Uint8Array | string): string {
  const base64 = typeof value === "string" ? value : btoa(String.fromCharCode(...value));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function postJson<T>(url: string, body: Record<string, string>) {
  return fetchMobileJson<T>(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(body),
    },
    {} as T,
  );
}

/** The handoff's query, only when the URL is exactly our return URI with our one state. */
function callbackParams(url: string, state: string): URLSearchParams | undefined {
  let callback: URL;
  try {
    callback = new URL(url);
  } catch {
    return undefined;
  }
  const states = callback.searchParams.getAll("state");
  if (
    callback.protocol !== "cortexai-agent-hub:" ||
    callback.host !== "hub-sso" ||
    (callback.pathname && callback.pathname !== "/") ||
    callback.username ||
    callback.password ||
    callback.hash ||
    states.length !== 1 ||
    states[0] !== state
  )
    return undefined;
  return callback.searchParams;
}

function isHttps(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function accessDenied(status: number, body: unknown): boolean {
  const code = body && typeof body === "object" && "code" in body ? body.code : undefined;
  return status === 403 && (code === HUB_SSO_ACCESS_DENIED || code === HUB_ACCESS_DENIED);
}

function accessError() {
  return new Error(t("You don't have access to Agent Hub. Ask your admin."));
}
