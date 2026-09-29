/** Next step after the email-first sign-in screen submits an email. */
export type SignInContinueResponse =
  | { next: "password" }
  | { next: "redirect"; url: string }
  | { next: "sso_unavailable" }
  | { next: "other_sso_unavailable" };

/** The only values the SSO callback sends back as `/sign-in?error=`. */
export type SsoCallbackError = "sso_expired" | "sso_failed";
