import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapUserSpace, createTestPrisma, type PrismaClient } from "@cortexai-agent-hub/db";
import type { AuthEnv } from "./index.js";
import { createAuth } from "./index.js";

describe("signup lockdown", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = await createTestPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$transaction([
      prisma.session.deleteMany(),
      prisma.user.deleteMany(),
      prisma.deploymentSettings.deleteMany(),
    ]);
  });

  const createTestAuth = (overrides: Partial<AuthEnv> = {}) => {
    return createAuth(prisma, {
      secret: "test-secret-that-is-long-enough-for-better-auth-validation",
      baseURL: "http://127.0.0.1:3100",
      webOrigin: "http://127.0.0.1:5173",
      signupsEnabled: undefined,
      signupAllowlist: undefined,
      ...overrides,
    });
  };

  describe("fresh install", () => {
    it("rejects email/password signup unconditionally", async () => {
      const auth = createTestAuth();

      const res = await auth.handler(
        new Request("http://127.0.0.1:3100/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
          body: JSON.stringify({
            email: "new@example.test",
            password: "secure-password-123",
            name: "New User",
          }),
        }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/registration is closed/i);
    });

    it("rejects signup even with SIGNUPS_ENABLED=true in env", async () => {
      const auth = createTestAuth({ signupsEnabled: "true" });

      const res = await auth.handler(
        new Request("http://127.0.0.1:3100/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
          body: JSON.stringify({
            email: "new@example.test",
            password: "secure-password-123",
            name: "New User",
          }),
        }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/registration is closed/i);
    });

    it("rejects signup even with allowlist in env", async () => {
      const auth = createTestAuth({
        signupsEnabled: "true",
        signupAllowlist: "new@example.test",
      });

      const res = await auth.handler(
        new Request("http://127.0.0.1:3100/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
          body: JSON.stringify({
            email: "new@example.test",
            password: "secure-password-123",
            name: "New User",
          }),
        }),
      );

      expect(res.status).toBe(400);
    });
  });

  describe("upgraded install with legacy settings", () => {
    it("rejects signup when stored signupsEnabled=true", async () => {
      // Simulate legacy deployment with open signup
      await prisma.deploymentSettings.create({
        data: {
          id: "default",
          ownerUserId: null,
          signupsEnabled: true,
          signupAllowlist: "",
          signupPolicyInitialized: true,
        },
      });

      const auth = createTestAuth();

      const res = await auth.handler(
        new Request("http://127.0.0.1:3100/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
          body: JSON.stringify({
            email: "new@example.test",
            password: "secure-password-123",
            name: "New User",
          }),
        }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/registration is closed/i);
    });

    it("rejects signup when stored allowlist exists", async () => {
      await prisma.deploymentSettings.create({
        data: {
          id: "default",
          ownerUserId: null,
          signupsEnabled: true,
          signupAllowlist: "approved@example.test",
          signupPolicyInitialized: true,
        },
      });

      const auth = createTestAuth();

      const res = await auth.handler(
        new Request("http://127.0.0.1:3100/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
          body: JSON.stringify({
            email: "approved@example.test",
            password: "secure-password-123",
            name: "Approved User",
          }),
        }),
      );

      expect(res.status).toBe(400);
    });
  });

  describe("existing account sign-in", () => {
    it("allows sign-in for existing verified users", async () => {
      // Create a verified user
      const user = await prisma.user.create({
        data: {
          id: "user-1",
          email: "existing@example.test",
          name: "Existing User",
          emailVerified: true,
        },
      });

      // Create account record for Better Auth
      await prisma.account.create({
        data: {
          id: "account-1",
          userId: user.id,
          accountId: user.email,
          providerId: "credential",
          password: "$2a$10$X8JK7H5Z3R1YqW5N6wQZ7eB3x4W7jJ1nG8K9mL0pQ2r5S6T7u8v9w", // hashed "password"
        },
      });

      await bootstrapUserSpace(prisma, user, {
        signupsEnabled: undefined,
        signupAllowlist: undefined,
      });

      const auth = createTestAuth();

      const res = await auth.handler(
        new Request("http://127.0.0.1:3100/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
          body: JSON.stringify({
            email: "existing@example.test",
            password: "password",
          }),
        }),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user).toBeDefined();
      expect(body.user.email).toBe("existing@example.test");
    });

    it("supports password reset for existing users", async () => {
      const user = await prisma.user.create({
        data: {
          id: "user-2",
          email: "reset@example.test",
          name: "Reset User",
          emailVerified: true,
        },
      });

      await prisma.account.create({
        data: {
          id: "account-2",
          userId: user.id,
          accountId: user.email,
          providerId: "credential",
          password: "$2a$10$X8JK7H5Z3R1YqW5N6wQZ7eB3x4W7jJ1nG8K9mL0pQ2r5S6T7u8v9w",
        },
      });

      const auth = createTestAuth();

      const res = await auth.handler(
        new Request("http://127.0.0.1:3100/api/auth/forgot-password", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
          body: JSON.stringify({
            email: "reset@example.test",
            redirectTo: "http://127.0.0.1:5173/reset-password",
          }),
        }),
      );

      // Should accept the request (actual email delivery is mocked)
      expect(res.status).toBe(200);
    });
  });

  describe("owner claim prevention", () => {
    it("never claims empty ownerUserId on session creation", async () => {
      // Create deployment settings with no owner
      await prisma.deploymentSettings.create({
        data: {
          id: "default",
          ownerUserId: null,
          signupsEnabled: false,
          signupAllowlist: "",
          signupPolicyInitialized: true,
        },
      });

      // Manually create a user (simulating operator provisioning)
      const user = await prisma.user.create({
        data: {
          id: "user-3",
          email: "noowner@example.test",
          name: "No Owner",
          emailVerified: true,
        },
      });

      await prisma.account.create({
        data: {
          id: "account-3",
          userId: user.id,
          accountId: user.email,
          providerId: "credential",
          password: "$2a$10$X8JK7H5Z3R1YqW5N6wQZ7eB3x4W7jJ1nG8K9mL0pQ2r5S6T7u8v9w",
        },
      });

      // Bootstrap WITHOUT owner claim
      await bootstrapUserSpace(prisma, user, {
        signupsEnabled: undefined,
        signupAllowlist: undefined,
      });

      const auth = createTestAuth();

      // Sign in to create session
      await auth.handler(
        new Request("http://127.0.0.1:3100/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
          body: JSON.stringify({
            email: "noowner@example.test",
            password: "password",
          }),
        }),
      );

      // Verify owner is still null
      const settings = await prisma.deploymentSettings.findUnique({
        where: { id: "default" },
      });
      expect(settings?.ownerUserId).toBeNull();
    });

    it("never reopens owner claim after deletion", async () => {
      // Create owner
      const owner = await prisma.user.create({
        data: {
          id: "owner-1",
          email: "owner@example.test",
          name: "Owner",
          emailVerified: true,
        },
      });

      await prisma.deploymentSettings.create({
        data: {
          id: "default",
          ownerUserId: owner.id,
          signupsEnabled: false,
          signupAllowlist: "",
          signupPolicyInitialized: true,
        },
      });

      // Delete owner (sets ownerUserId to null)
      await prisma.deploymentSettings.update({
        where: { id: "default" },
        data: { ownerUserId: null },
      });

      // Create another user
      const user = await prisma.user.create({
        data: {
          id: "user-4",
          email: "another@example.test",
          name: "Another User",
          emailVerified: true,
        },
      });

      await prisma.account.create({
        data: {
          id: "account-4",
          userId: user.id,
          accountId: user.email,
          providerId: "credential",
          password: "$2a$10$X8JK7H5Z3R1YqW5N6wQZ7eB3x4W7jJ1nG8K9mL0pQ2r5S6T7u8v9w",
        },
      });

      await bootstrapUserSpace(prisma, user, {
        signupsEnabled: undefined,
        signupAllowlist: undefined,
      });

      const auth = createTestAuth();

      // Sign in
      await auth.handler(
        new Request("http://127.0.0.1:3100/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
          body: JSON.stringify({
            email: "another@example.test",
            password: "password",
          }),
        }),
      );

      // Verify owner is still null (not claimed by new user)
      const settings = await prisma.deploymentSettings.findUnique({
        where: { id: "default" },
      });
      expect(settings?.ownerUserId).toBeNull();
    });
  });

  describe("bootstrapUserSpace never claims owner", () => {
    it("leaves ownerUserId null when bootstrapping new user", async () => {
      await prisma.deploymentSettings.create({
        data: {
          id: "default",
          ownerUserId: null,
          signupsEnabled: false,
          signupAllowlist: "",
          signupPolicyInitialized: true,
        },
      });

      const user = await prisma.user.create({
        data: {
          id: "user-5",
          email: "bootstrap@example.test",
          name: "Bootstrap User",
          emailVerified: true,
        },
      });

      await bootstrapUserSpace(prisma, user, {
        signupsEnabled: undefined,
        signupAllowlist: undefined,
      });

      const settings = await prisma.deploymentSettings.findUnique({
        where: { id: "default" },
      });
      expect(settings?.ownerUserId).toBeNull();
    });
  });
});
