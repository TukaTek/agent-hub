export type AuthMode = "in" | "forgot";

export const explicitSignInRoute = {
  pathname: "/sign-in",
  params: { mode: "in" },
} as const;

/**
 * Self-service signup is closed (CAAH-43), so every logged-out visitor starts
 * at sign-in; a legacy `mode=up` link lands there too.
 */
export function initialAuthMode(_requestedMode?: string | string[]): AuthMode {
  return "in";
}
