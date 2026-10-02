/** Next step after the email-first sign-in screen submits an email. */
export type SignInContinueResponse =
  | { next: "password" }
  | { next: "redirect"; url: string }
  | { next: "sso_unavailable" }
  | { next: "other_sso_unavailable" };

/** Error `code` of a 403 Continue when Hub refuses this user before Microsoft sign-in. */
export const HUB_SSO_ACCESS_DENIED = "HUB_SSO_ACCESS_DENIED";

/** The only values the SSO callback sends back as `/sign-in?error=`. */
export type SsoCallbackError = "sso_expired" | "sso_failed" | Lowercase<HubSignInRefusalCode>;

/**
 * Stable `code`s for a sign-in that CortexAI Hub policy refuses (CAAH-36). Hub is
 * the source of truth, so a missing, invalid, disabled or not-yet-applied policy
 * stops every new sign-in; there is no local bypass.
 */
export const HUB_UNAVAILABLE = "HUB_UNAVAILABLE";
export const HUB_CONFIG_INVALID = "HUB_CONFIG_INVALID";
export const TENANT_DISABLED = "TENANT_DISABLED";
export const HUB_CONFIG_RESTART_REQUIRED = "HUB_CONFIG_RESTART_REQUIRED";
export const HUB_ACCESS_DENIED = "HUB_ACCESS_DENIED";
export type HubSignInRefusalCode =
  | typeof HUB_UNAVAILABLE
  | typeof HUB_CONFIG_INVALID
  | typeof TENANT_DISABLED
  | typeof HUB_CONFIG_RESTART_REQUIRED
  | typeof HUB_ACCESS_DENIED;
export const HUB_SIGN_IN_REFUSAL_CODES: readonly HubSignInRefusalCode[] = [
  HUB_UNAVAILABLE,
  HUB_CONFIG_INVALID,
  TENANT_DISABLED,
  HUB_CONFIG_RESTART_REQUIRED,
  HUB_ACCESS_DENIED,
];
/** Server copy for every refusal except HUB_ACCESS_DENIED, which asks for admin access. */
export const HUB_SIGN_IN_UNAVAILABLE_MESSAGE =
  "Sign-in is temporarily unavailable, CortexAI Hub can't be reached";

/** The SSO callback sends a refusal code as `/sign-in?error=<code in lower case>`. */
export const hubRefusalCallbackError = (code: HubSignInRefusalCode) =>
  code.toLowerCase() as Lowercase<HubSignInRefusalCode>;
