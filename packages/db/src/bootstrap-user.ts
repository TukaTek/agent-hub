import { randomBytes } from "node:crypto";
import type { PrismaClient } from "./client.js";

/**
 * Legacy signup inputs. Since CAAH-43 they are accepted for call compatibility
 * and ignored: no environment value or stored row can reopen signup.
 */
export interface SignupPolicyEnv {
  signupsEnabled?: string | undefined;
  signupAllowlist?: string | undefined;
}

function newId(): string {
  return randomBytes(16).toString("hex");
}

/** Prisma unique-constraint violation; anything else must still throw. */
function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

/**
 * Everything a brand-new user needs around their account row: a personal
 * organization, its default space, owner memberships for both boundaries,
 * user memory, and notification preferences. Shared by the Better Auth
 * `session.create.before` hook and phone-identity provisioning.
 *
 * It never claims the deployment owner (CAAH-43): the seat is set only by an
 * explicit operator command (provision-owner, transfer-owner). The legacy
 * `claimDeploymentOwner: false` option is still accepted so existing callers
 * (Hub sign-in, messaging) keep their call shape.
 */
export async function bootstrapUserSpace(
  prisma: PrismaClient,
  user: { id: string },
  _env: SignupPolicyEnv,
  _options: { claimDeploymentOwner?: false } = {},
): Promise<{ spaceId: string }> {
  // Concurrent bootstraps for the same user (e.g. overlapping first phone
  // inbounds) race on every unique key below; each step either wins or
  // joins the winner's state instead of failing.
  // Hub IDs share a prefix. Preserve their complete identity hash instead of
  // shrinking the workspace boundary to the first eight hexadecimal digits.
  const slug = `user-${user.id.startsWith("hub_") ? user.id : user.id.slice(0, 12)}`;
  let orgId = newId();
  try {
    await prisma.organization.create({
      data: { id: orgId, name: "Personal", slug, createdAt: new Date() },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    orgId = (await prisma.organization.findUniqueOrThrow({ where: { slug } })).id;
  }
  await prisma.member
    .create({
      data: {
        id: newId(),
        organizationId: orgId,
        userId: user.id,
        role: "owner",
        createdAt: new Date(),
      },
    })
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
    });
  await prisma.space
    .create({
      data: {
        id: orgId,
        organizationId: orgId,
        name: "Personal",
        isDefault: true,
        createdByUserId: user.id,
        createdAt: new Date(),
      },
    })
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
    });
  await prisma.spaceMember
    .create({
      data: {
        id: newId(),
        spaceId: orgId,
        organizationId: orgId,
        userId: user.id,
        role: "owner",
        createdAt: new Date(),
      },
    })
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
    });
  // A fresh row records signup closed; the columns are legacy and never read.
  await prisma.deploymentSettings.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      ownerUserId: null,
      signupsEnabled: false,
      signupAllowlist: "",
      signupPolicyInitialized: true,
    },
    update: {},
  });
  const hasMemory = await prisma.memoryDocument.findFirst({
    where: { spaceId: orgId, userId: user.id, scope: "user", path: "MEMORY.md" },
  });
  if (!hasMemory) {
    await prisma.memoryDocument
      .create({
        data: {
          spaceId: orgId,
          userId: user.id,
          scope: "user",
          path: "MEMORY.md",
          content: "# Space memory\n\nPreferences and context kept within this space live here.\n",
        },
      })
      .catch((error: unknown) => {
        if (!isUniqueViolation(error)) throw error;
      });
  }
  await prisma.notificationPreference
    .create({
      data: {
        spaceId: orgId,
        userId: user.id,
      },
    })
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
    });
  return { spaceId: orgId };
}
