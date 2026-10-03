import { setHubManagedDeploymentSettings } from "@cortexai-agent-hub/core";
import { describe, expect, it, vi } from "vitest";
import hubSample from "./fixtures/hub-agent-hub-service-config.v1.sample.json" with {
  type: "json",
};
import { parseHubPolicy } from "./hub-policy-contract.js";
import { hubDeploymentSettings, overlayHubEnv } from "./hub-policy-overlay.js";
import {
  buildTrustedOrigins,
  createAuth,
  isBlockedAuthPath,
  isSignupPath,
  passwordResetEmail,
} from "./index.js";

describe("auth policy", () => {
  it("closes every organization plugin route", () => {
    for (const path of [
      "/organization/delete",
      "/organization/update",
      "/organization/leave",
      "/organization/create",
      "/organization/invite-member",
      "/organization/cancel-invitation",
      "/organization/set-active",
      "/organization/list",
      "/organization/create-team",
      "/organization/some-future-route",
    ]) {
      expect(isBlockedAuthPath(path), path).toBe(true);
    }
  });

  it("closes every signup route at the app boundary (CAAH-43)", () => {
    for (const path of ["/sign-up", "/sign-up/email", "/sign-up/some-future-provider"]) {
      expect(isSignupPath(path), path).toBe(true);
      expect(isBlockedAuthPath(path), path).toBe(true);
    }
    // A prefix match must not swallow unrelated routes.
    expect(isBlockedAuthPath("/sign-upgrade")).toBe(false);
  });

  // Signup is no longer an account route the apps call (CAAH-43), so it moved
  // to the blocked list above; everything else here must stay reachable.
  it("keeps the account routes the apps call", () => {
    for (const path of [
      "/sign-in/email",
      "/sign-out",
      "/get-session",
      "/change-password",
      "/request-password-reset",
      "/reset-password",
      "/delete-user",
    ]) {
      expect(isBlockedAuthPath(path), path).toBe(false);
    }
  });

  it("disables organization deletion inside Better Auth as well", async () => {
    const auth = createAuth({} as never, {
      secret: "test-secret-that-is-long-enough-for-better-auth",
      baseURL: "http://127.0.0.1:3100",
      webOrigin: "http://127.0.0.1:5173",
      signupsEnabled: undefined,
      signupAllowlist: undefined,
    });

    const res = await auth.handler(
      new Request("http://127.0.0.1:3100/api/auth/organization/delete", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
        body: JSON.stringify({ organizationId: "space-1" }),
      }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "ORGANIZATION_DELETION_DISABLED" });
  });
});

describe("buildTrustedOrigins", () => {
  it("adds the localhost twin for a 127.0.0.1 web origin", () => {
    expect(
      buildTrustedOrigins({
        webOrigin: "http://127.0.0.1:5173",
        baseURL: "http://127.0.0.1:5173",
      }),
    ).toEqual(expect.arrayContaining(["http://127.0.0.1:5173", "http://localhost:5173"]));
  });

  it("keeps extraOrigins and does not twin non-loopback hosts", () => {
    expect(
      buildTrustedOrigins({
        webOrigin: "https://app.example.test",
        baseURL: "https://api.example.test",
        extraOrigins: ["https://extra.example.test"],
      }),
    ).toEqual([
      "https://app.example.test",
      "https://api.example.test",
      "https://extra.example.test",
    ]);
  });
});

describe("passwordResetEmail", () => {
  it("keeps the reset URL in text and escapes user-controlled HTML", () => {
    const message = passwordResetEmail(
      { id: "user-1", email: "ada@example.test", name: '<Ada & "team">' },
      "https://cortexai-agent-hub.test/reset-password?token=secret&next=1",
    );

    expect(message).toMatchObject({
      to: "ada@example.test",
      subject: "Reset your CortexAI Agent Hub password",
    });
    expect(message.text).toContain(
      "https://cortexai-agent-hub.test/reset-password?token=secret&next=1",
    );
    expect(message.html).toContain("&lt;Ada &amp; &quot;team&quot;&gt;");
    expect(message.html).toContain("token=secret&amp;next=1");
    expect(message.html).not.toContain('<Ada & "team">');
  });
});

describe("signup lockdown (CAAH-43)", () => {
  const legacyOpenRow = {
    id: "default",
    ownerUserId: null,
    signupsEnabled: true,
    signupAllowlist: "",
    signupPolicyInitialized: true,
  };

  for (const env of [
    { signupsEnabled: "true", signupAllowlist: "" },
    { signupsEnabled: "true", signupAllowlist: "visitor@example.test" },
    { signupsEnabled: undefined, signupAllowlist: undefined },
  ]) {
    it(`refuses direct email signup inside Better Auth with legacy env ${JSON.stringify(env)}`, async () => {
      const prisma = {
        deploymentSettings: { findUnique: vi.fn().mockResolvedValue(legacyOpenRow) },
        user: { create: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
        account: { create: vi.fn() },
      };
      const auth = createAuth(prisma as never, {
        secret: "test-secret-that-is-long-enough-for-better-auth",
        baseURL: "http://127.0.0.1:3100",
        webOrigin: "http://127.0.0.1:5173",
        ...env,
      });

      const res = await auth.handler(
        new Request("http://127.0.0.1:3100/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
          body: JSON.stringify({
            email: "visitor@example.test",
            password: "password12",
            name: "Visitor",
          }),
        }),
      );

      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Registration is closed");
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.account.create).not.toHaveBeenCalled();
      // The legacy row is never consulted: no stored flag can reopen signup.
      expect(prisma.deploymentSettings.findUnique).not.toHaveBeenCalled();
    });
  }

  it("keeps signup closed when Hub's policy says signupsEnabled=true with an allowlist", async () => {
    // Apply Hub's published sample the way a process does at startup.
    const policy = parseHubPolicy(structuredClone(hubSample), hubSample.tenantId);
    expect(policy.overrides["signup.enabled"]).toBe(true);
    const allowlisted = hubSample.overrides.signup.allowlist.find(
      (entry) => !entry.startsWith("@"),
    );
    expect(allowlisted).toMatch(/^[^@]+@/);
    const { env } = overlayHubEnv({}, policy);
    setHubManagedDeploymentSettings(hubDeploymentSettings(policy).managed);
    try {
      const prisma = {
        deploymentSettings: { findUnique: vi.fn().mockResolvedValue(legacyOpenRow) },
        user: { create: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
        account: { create: vi.fn() },
      };
      const auth = createAuth(prisma as never, {
        secret: "test-secret-that-is-long-enough-for-better-auth",
        baseURL: "http://127.0.0.1:3100",
        webOrigin: "http://127.0.0.1:5173",
        // Even if Hub's values reached the auth env, they could not reopen signup.
        signupsEnabled: env.SIGNUPS_ENABLED ?? "true",
        signupAllowlist: env.SIGNUP_ALLOWLIST ?? hubSample.overrides.signup.allowlist.join(","),
      });
      const res = await auth.handler(
        new Request("http://127.0.0.1:3100/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
          body: JSON.stringify({ email: allowlisted, password: "password12", name: "Partner" }),
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Registration is closed");
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.account.create).not.toHaveBeenCalled();
    } finally {
      setHubManagedDeploymentSettings({});
    }
  });
});
