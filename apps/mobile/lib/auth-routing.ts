export type AuthMode = "in" | "forgot";

export const explicitSignInRoute = {
  pathname: "/sign-in",
  params: { mode: "in" },
} as const;

export function initialAuthMode(requestedMode?: string | string[]): AuthMode {
  // Self-service signup removed; default to sign-in
  return "in";
}
