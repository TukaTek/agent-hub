import type { NativeSsoClient } from "@cortexai-agent-hub/core";

/**
 * Matched against the raw string, never a parsed URL, so no parser leniency
 * (userinfo, backslashes, dot segments, IPv4 shorthand) can widen the allowlist.
 */
const DESKTOP_RETURN_TO = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{3,4})\/hub-sso$/;
const MOBILE_RETURN_TO = "cortexai-agent-hub://hub-sso";
/** An S256 challenge is a base64url SHA-256 digest without padding. */
const APP_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 code verifier. */
const APP_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** The returnTo a native client may receive its handoff on, or undefined. */
export function nativeReturnTo(client: unknown, returnTo: unknown): string | undefined {
  if (typeof returnTo !== "string") return undefined;
  if (client === ("mobile" satisfies NativeSsoClient))
    return returnTo === MOBILE_RETURN_TO ? returnTo : undefined;
  if (client !== ("desktop" satisfies NativeSsoClient)) return undefined;
  const port = DESKTOP_RETURN_TO.exec(returnTo)?.[1];
  return port && Number(port) >= 1024 && Number(port) <= 65535 ? returnTo : undefined;
}

export const isAppChallenge = (value: unknown): value is string =>
  typeof value === "string" && APP_CHALLENGE.test(value);

export const isAppVerifier = (value: unknown): value is string =>
  typeof value === "string" && APP_VERIFIER.test(value);
