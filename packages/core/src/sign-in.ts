/** Next step after the email-first sign-in screen submits an email. */
export type SignInContinueResponse = { next: "password" } | { next: "sso_unavailable" };
