import { z } from "zod";

export const signInProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  presentation: z
    .object({
      variant: z.enum(["solid", "outline"]),
      mark: z
        .object({
          viewBox: z.string().max(64),
          paths: z
            .array(
              z.object({
                d: z.string().max(4096),
                /** Brand color; omitted paths follow the button's text color. */
                fill: z
                  .string()
                  .regex(/^#[0-9a-fA-F]{6}$/)
                  .optional(),
              }),
            )
            .max(8),
        })
        .optional(),
    })
    .optional(),
});
export type SignInProvider = z.infer<typeof signInProviderSchema>;

/** Readable by the sign-in page; set only after a sign-in succeeds. Holds a provider id or `email`. */
export const LAST_SIGN_IN_COOKIE = "cortexai-agent-hub_last_sign_in";

/** The chooser button a remembered sign-in method belongs to: a provider id, or `email`. */
export function lastSignInChoice(method: string | null | undefined): string | null {
  if (!method) return null;
  return method === "email" || method === "email-otp" ? "email" : method;
}

const oidcSsoSchema = z.object({
  name: z.string().min(1),
  availability: z.enum(["available", "unavailable", "checking"]),
});

/**
 * Hub servers keep sending the pre-merge boolean `sso` (mirroring `hubSso`) so older
 * clients keep their Microsoft button; it never describes direct OIDC.
 */
export const authCapabilitiesSchema = z
  .object({
    mode: z.enum(["hub", "local"]).default("local"),
    hubSso: z.boolean().default(false),
    /**
     * Desktop and mobile can finish Hub SSO through `/hub/sso/native/*`. A sibling of
     * `hubSso` rather than `hubSso.native`, because older clients parse `hubSso` as a
     * boolean. Older servers omit it, which means unavailable.
     */
    hubSsoNative: z.boolean().optional(),
    sso: z.union([oidcSsoSchema, z.boolean()]).nullable(),
    passwordAuth: z.boolean(),
    passwordReset: z.boolean(),
    resetUrl: z.string().url().nullable(),
    // Older servers omit this field; clients treat omission as unavailable.
    emailCode: z.boolean().optional(),
    billing: z.boolean().optional(),
    /** WebAuthn relying party ID; null or omitted when this server does not offer passkeys. */
    passkeyRpId: z.string().min(1).nullable().optional(),
    /** Native apps this domain vouches for; omitted by older servers, which means none. */
    nativePasskeys: z.object({ ios: z.boolean(), android: z.boolean() }).optional(),
    /**
     * Sign-in buttons. Older servers omit it; clients then show `sso` alone.
     * An empty list means this server configured none. Hub servers list none.
     */
    providers: z.array(signInProviderSchema).max(8).optional(),
    /** Crisp chat on the paywall; null or omitted when the deployment offers none. */
    crispWebsiteId: z.string().min(1).nullable().optional(),
    /** A shared account whose login is public, offered on sign-in and sign-up; only throwaway demo servers set it. */
    demoAccount: z
      .object({ email: z.string().min(1), password: z.string().min(1) })
      .nullable()
      .optional(),
  })
  .transform(({ sso, ...value }) => ({
    ...value,
    sso: typeof sso === "boolean" ? null : sso,
  }));
export type AuthCapabilities = z.output<typeof authCapabilitiesSchema>;
export type AuthCapabilitiesResponse = z.input<typeof authCapabilitiesSchema>;

/**
 * The buttons on sign-in. A server that lists `providers` wins, including an empty list.
 * Older servers only had `sso`.
 */
export function signInProviders(capabilities: {
  sso: { name: string } | null;
  providers?: SignInProvider[] | undefined;
}): SignInProvider[] {
  if (capabilities.providers) return capabilities.providers;
  return capabilities.sso ? [{ id: "oidc", name: capabilities.sso.name }] : [];
}

/** Organization SSO is secondary alongside personal providers, and prominent on SSO-only servers. */
export function signInProviderGroups(providers: SignInProvider[]) {
  const alongsidePersonal = providers.some((provider) => provider.id !== "oidc");
  return {
    primary: alongsidePersonal ? providers.filter((provider) => provider.id !== "oidc") : providers,
    secondary: alongsidePersonal ? providers.filter((provider) => provider.id === "oidc") : [],
  };
}

export const accountSecuritySchema = z.object({
  hasPassword: z.boolean(),
  // Older servers omit this field; clients treat omission as enabled.
  passwordChangeEnabled: z.boolean().optional(),
  freshOidcAuth: z.boolean(),
  ssoLinked: z.boolean(),
  linkedProviderIds: z.array(z.string()).optional(),
  emailDeletion: z.boolean(),
  sso: z.object({ name: z.string().min(1) }).nullable(),
});
export type AccountSecurity = z.infer<typeof accountSecuritySchema>;

/** Only a complete pre-SSO shape may opt into password-only compatibility. */
const preSsoAuthCapabilitiesSchema = z
  .object({
    passwordReset: z.boolean(),
    resetUrl: z.string().url().nullable(),
    billing: z.boolean().optional(),
  })
  .strict()
  .transform(
    (value): AuthCapabilities => ({
      ...value,
      mode: "local",
      hubSso: false,
      passwordAuth: true,
      sso: null,
    }),
  );

/** Hub-era servers before the OIDC merge sent `mode` and a boolean `sso`. */
const preOidcHubAuthCapabilitiesSchema = z
  .object({
    mode: z.enum(["hub", "local"]),
    sso: z.boolean().optional(),
    passwordReset: z.boolean(),
    resetUrl: z.string().url().nullable(),
  })
  .strict()
  .transform(
    ({ mode, sso, ...value }): AuthCapabilities => ({
      ...value,
      mode,
      hubSso: mode === "hub" && sso === true,
      passwordAuth: mode !== "hub",
      sso: null,
    }),
  );

export const legacyAuthCapabilitiesSchema = preSsoAuthCapabilitiesSchema.or(
  preOidcHubAuthCapabilitiesSchema,
);

/** Pre-SSO servers only had credential accounts and password-protected deletion. */
export const legacyAccountSecurity: AccountSecurity = {
  hasPassword: true,
  passwordChangeEnabled: true,
  freshOidcAuth: false,
  ssoLinked: false,
  emailDeletion: false,
  sso: null,
};

/**
 * The RPC error code for a sensitive action the session must confirm its
 * identity for first. Clients confirm, then retry the action once.
 */
export const IDENTITY_CONFIRMATION_REQUIRED = "IDENTITY_CONFIRMATION_REQUIRED";

export function isIdentityConfirmationRequired(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === IDENTITY_CONFIRMATION_REQUIRED
  );
}

/**
 * Runs an action that may need a recent identity confirmation. When the server asks for one,
 * `confirm` prompts; once confirmed, the action is retried a single time.
 * A dismissed prompt rethrows the server's error.
 */
export async function runWithIdentityConfirmation<T>(
  action: () => Promise<T>,
  confirm: () => Promise<boolean>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!isIdentityConfirmationRequired(error) || !(await confirm())) throw error;
  }
  return action();
}

/** Only organization SSO supports verifiable fresh authentication. */
export function identityConfirmationProviders(security: AccountSecurity): SignInProvider[] {
  return security.sso && security.ssoLinked ? [{ id: "oidc", name: security.sso.name }] : [];
}
