import type { AuthCapabilitiesResponse } from "@cortexai-agent-hub/contracts";
import type { AppEnv } from "./env.js";

type SsoAvailability = "available" | "unavailable" | "checking";

export function authCapabilities(
  env: Pick<AppEnv, "hubAuth" | "oidc" | "passwordAuth" | "webOrigin">,
  options: {
    email: boolean;
    billing: boolean;
    ssoAvailability?: SsoAvailability;
    emailCode?: boolean;
    passkeyRpId?: string | null;
    nativePasskeys?: { ios: boolean; android: boolean };
  },
): AuthCapabilitiesResponse {
  if (env.hubAuth) {
    const hubSso = Boolean(env.hubAuth.sso);
    // Hub owns sign-in, so no local credential (password, email code or passkey) is offered.
    return {
      mode: "hub",
      hubSso,
      sso: hubSso,
      passwordAuth: false,
      passwordReset: false,
      resetUrl: null,
      emailCode: false,
      billing: false,
      passkeyRpId: null,
    };
  }
  const passwordAuth = env.passwordAuth !== false;
  return {
    mode: "local",
    hubSso: false,
    sso: env.oidc
      ? { name: env.oidc.name, availability: options.ssoAvailability ?? "checking" }
      : null,
    passwordAuth,
    passwordReset: passwordAuth && options.email,
    resetUrl: passwordAuth && options.email ? new URL("/reset-password", env.webOrigin).href : null,
    emailCode: options.emailCode ?? false,
    billing: options.billing,
    passkeyRpId: options.passkeyRpId ?? null,
    ...(options.nativePasskeys ? { nativePasskeys: options.nativePasskeys } : {}),
  };
}
