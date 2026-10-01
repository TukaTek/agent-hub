/** Next step after the email-first sign-in screen submits an email. */
export type SignInContinueResponse =
  | { next: "password" }
  | { next: "redirect"; url: string }
  | { next: "sso_unavailable" }
  | { next: "other_sso_unavailable" };

/** Error `code` of a 403 Continue when Hub refuses this user before Microsoft sign-in. */
export const HUB_SSO_ACCESS_DENIED = "HUB_SSO_ACCESS_DENIED";

/** The only values the SSO callback sends back as `/sign-in?error=`. */
export type SsoCallbackError = "sso_expired" | "sso_failed";
