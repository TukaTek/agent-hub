import { expect, it } from "vitest";
import {
  accountSecuritySchema,
  authCapabilitiesSchema,
  legacyAuthCapabilitiesSchema,
} from "./auth.js";

it("requires explicit password and SSO capabilities", () => {
  expect(authCapabilitiesSchema.safeParse({ passwordReset: false, resetUrl: null }).success).toBe(
    false,
  );
  expect(
    authCapabilitiesSchema.parse({
      passwordAuth: false,
      passwordReset: false,
      resetUrl: null,
      sso: { name: "SSO", availability: "checking" },
    }).passwordAuth,
  ).toBe(false);
});

it("only accepts complete legacy capabilities without partial SSO fields", () => {
  expect(
    legacyAuthCapabilitiesSchema.parse({ passwordReset: false, resetUrl: null, billing: true }),
  ).toEqual({
    mode: "local",
    hubSso: false,
    passwordAuth: true,
    sso: null,
    passwordReset: false,
    resetUrl: null,
    billing: true,
  });
  for (const value of [
    {},
    { passwordReset: false },
    { passwordReset: false, resetUrl: null, passwordAuth: false },
    { passwordReset: false, resetUrl: null, sso: null },
    { passwordReset: "false", resetUrl: null },
  ]) {
    expect(legacyAuthCapabilitiesSchema.safeParse(value).success).toBe(false);
  }
});

it("keeps Hub sign-in separate from direct OIDC", () => {
  expect(
    authCapabilitiesSchema.parse({
      mode: "hub",
      hubSso: true,
      sso: true,
      passwordAuth: false,
      passwordReset: false,
      resetUrl: null,
      billing: false,
    }),
  ).toEqual({
    mode: "hub",
    hubSso: true,
    sso: null,
    passwordAuth: false,
    passwordReset: false,
    resetUrl: null,
    billing: false,
  });
  expect(
    legacyAuthCapabilitiesSchema.parse({
      mode: "hub",
      sso: true,
      passwordReset: false,
      resetUrl: null,
    }),
  ).toMatchObject({ mode: "hub", hubSso: true, passwordAuth: false, sso: null });
  expect(
    legacyAuthCapabilitiesSchema.parse({
      mode: "local",
      sso: false,
      passwordReset: true,
      resetUrl: "https://app.example.test/reset-password",
    }),
  ).toMatchObject({ mode: "local", hubSso: false, passwordAuth: true, sso: null });
});

it("accepts older account security and explicit password-change policy", () => {
  const security = {
    hasPassword: true,
    freshOidcAuth: false,
    ssoLinked: false,
    emailDeletion: true,
    sso: null,
  };
  expect(accountSecuritySchema.parse(security).passwordChangeEnabled).not.toBe(false);
  expect(
    accountSecuritySchema.parse({ ...security, passwordChangeEnabled: false })
      .passwordChangeEnabled,
  ).toBe(false);
  expect(
    accountSecuritySchema.safeParse({ ...security, passwordChangeEnabled: "false" }).success,
  ).toBe(false);
});
