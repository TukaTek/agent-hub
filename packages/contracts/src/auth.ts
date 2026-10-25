import { z } from "zod";

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
  })
  .transform(({ sso, ...value }) => ({
    ...value,
    sso: typeof sso === "boolean" ? null : sso,
  }));
export type AuthCapabilities = z.output<typeof authCapabilitiesSchema>;
export type AuthCapabilitiesResponse = z.input<typeof authCapabilitiesSchema>;

export const accountSecuritySchema = z.object({
  hasPassword: z.boolean(),
  // Older servers omit this field; clients treat omission as enabled.
  passwordChangeEnabled: z.boolean().optional(),
  freshOidcAuth: z.boolean(),
  ssoLinked: z.boolean(),
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
