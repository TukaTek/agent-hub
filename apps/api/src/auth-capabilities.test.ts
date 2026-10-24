import { authCapabilitiesSchema } from "@cortexai-agent-hub/contracts";
import { describe, expect, it } from "vitest";
import { authCapabilities } from "./auth-capabilities.js";

const webOrigin = "https://app.example.test";
const hubAuth = { origin: "https://hub.example.test", tenantId: "tenant-1" };

describe("authCapabilities", () => {
  it("reports Hub sign-in with the legacy sso flag and no local password or billing", () => {
    for (const sso of [true, false]) {
      const reply = authCapabilities(
        { hubAuth: { ...hubAuth, sso } as never, webOrigin },
        { email: true, billing: true },
      );
      expect(reply).toEqual({
        mode: "hub",
        hubSso: sso,
        sso,
        passwordAuth: false,
        passwordReset: false,
        resetUrl: null,
        emailCode: false,
        billing: false,
        passkeyRpId: null,
      });
      expect(authCapabilitiesSchema.parse(reply)).toMatchObject({ hubSso: sso, sso: null });
    }
  });

  it("reports local password, reset, OIDC and billing", () => {
    const reply = authCapabilities(
      {
        webOrigin,
        passwordAuth: true,
        oidc: {
          issuer: "https://id.example.test",
          clientId: "client",
          clientSecret: "secret",
          name: "Company SSO",
          scopes: ["openid"],
          allowSignupBypass: false,
        },
      },
      { email: true, billing: true, ssoAvailability: "available" },
    );
    expect(reply).toEqual({
      mode: "local",
      hubSso: false,
      sso: { name: "Company SSO", availability: "available" },
      passwordAuth: true,
      passwordReset: true,
      resetUrl: `${webOrigin}/reset-password`,
      emailCode: false,
      billing: true,
      passkeyRpId: null,
    });
  });

  it("hides password reset when password sign-in is off", () => {
    expect(
      authCapabilities({ webOrigin, passwordAuth: false }, { email: true, billing: false }),
    ).toMatchObject({ passwordAuth: false, passwordReset: false, resetUrl: null });
  });
});
