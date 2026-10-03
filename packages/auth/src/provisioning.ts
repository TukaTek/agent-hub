import { isMessagingEmail } from "@cortexai-agent-hub/core";
import { bootstrapUserSpace, type PrismaClient } from "@cortexai-agent-hub/db";
import { generateId } from "better-auth";
import { hashPassword } from "better-auth/crypto";
import { hubUserId } from "./hub-client.js";

/**
 * Operator provisioning (CAAH-43). Self-service signup is gone, so these are
 * the only ways an account or the deployment owner comes into existence.
 * Callers are operator tools (the provision CLI) and test fixtures; nothing
 * here is reachable over HTTP.
 */

/** Better Auth's default email/password bounds, so a provisioned password can sign in. */
export const PROVISION_PASSWORD_MIN_LENGTH = 8;
export const PROVISION_PASSWORD_MAX_LENGTH = 128;

/** Serializes provisioning across processes; separate from any request lock. */
const PROVISIONING_LOCK = 872043;

export type ProvisioningErrorCode =
  | "INVALID_INPUT"
  | "OWNER_EXISTS"
  | "EMAIL_TAKEN"
  | "NOT_FOUND"
  | "NOT_ADMITTED"
  /** Hub mode lacks HUB_AUTH_TENANT_ID, so no Hub identity can be trusted as owner. */
  | "NOT_CONFIGURED";

export class ProvisioningError extends Error {
  constructor(
    readonly code: ProvisioningErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProvisioningError";
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lowercased, trimmed address; internal identity domains are refused. */
export function normalizeProvisionEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) {
    throw new ProvisioningError("INVALID_INPUT", "Enter a valid email address");
  }
  if (isMessagingEmail(email) || email.endsWith("@hub.invalid")) {
    throw new ProvisioningError("INVALID_INPUT", "Email is not available");
  }
  return email;
}

function validatePassword(password: string) {
  if (password.length < PROVISION_PASSWORD_MIN_LENGTH) {
    throw new ProvisioningError(
      "INVALID_INPUT",
      `Password must be at least ${PROVISION_PASSWORD_MIN_LENGTH} characters`,
    );
  }
  if (password.length > PROVISION_PASSWORD_MAX_LENGTH) {
    throw new ProvisioningError(
      "INVALID_INPUT",
      `Password must be at most ${PROVISION_PASSWORD_MAX_LENGTH} characters`,
    );
  }
}

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/**
 * Runs `work` holding the provisioning lock, with the settings row present and
 * signup stored closed. Signup columns are legacy and inert; a fresh row
 * records the closed state so an old reader cannot see an open default.
 */
async function withProvisioningLock<T>(prisma: PrismaClient, work: (tx: Tx) => Promise<T>) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PROVISIONING_LOCK})`;
      await tx.deploymentSettings.upsert({
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
      return work(tx);
    },
    { timeout: 30_000, maxWait: 15_000 },
  );
}

async function ownerOf(tx: Tx): Promise<string | null> {
  const settings = await tx.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { ownerUserId: true },
  });
  return settings?.ownerUserId ?? null;
}

export interface ProvisionLocalAccountInput {
  email: string;
  name: string;
  /** Plain text from stdin or a mounted file. Hashed here with Better Auth's hasher. */
  password: string;
  /** Grant the deployment owner seat. Fails with no change when an owner exists. */
  owner: boolean;
}

/**
 * Creates a local email/password account and its personal space in one
 * transaction. With `owner`, the owner seat is taken in the same transaction:
 * concurrent runs serialize on the provisioning lock and only the first
 * commits; the rest fail with OWNER_EXISTS and leave nothing behind.
 */
export async function provisionLocalAccount(
  prisma: PrismaClient,
  input: ProvisionLocalAccountInput,
): Promise<{ userId: string; email: string; owner: boolean }> {
  const email = normalizeProvisionEmail(input.email);
  const name = input.name.trim();
  if (!name || name.length > 200) {
    throw new ProvisioningError("INVALID_INPUT", "Enter a name of 1 to 200 characters");
  }
  validatePassword(input.password);
  const passwordHash = await hashPassword(input.password);
  return withProvisioningLock(prisma, async (tx) => {
    if (input.owner && (await ownerOf(tx))) {
      throw new ProvisioningError(
        "OWNER_EXISTS",
        "This deployment already has an owner. Use transfer-owner to move the seat.",
      );
    }
    const existing = await tx.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true },
    });
    if (existing) {
      throw new ProvisioningError("EMAIL_TAKEN", "An account with this email already exists");
    }
    const userId = generateId(32);
    const now = new Date();
    await tx.user.create({
      // The operator vouches for the address; no mailbox round trip is pending.
      data: { id: userId, email, name, emailVerified: true, createdAt: now, updatedAt: now },
    });
    await tx.account.create({
      data: {
        id: generateId(32),
        accountId: userId,
        providerId: "credential",
        userId,
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      },
    });
    // Same space bootstrap as every other admitted identity; it never claims the owner.
    await bootstrapUserSpace(
      tx as unknown as PrismaClient,
      { id: userId },
      {
        signupsEnabled: "false",
        signupAllowlist: undefined,
      },
    );
    if (input.owner) {
      const claimed = await tx.deploymentSettings.updateMany({
        where: { id: "default", ownerUserId: null },
        data: { ownerUserId: userId },
      });
      if (claimed.count !== 1) {
        throw new ProvisioningError("OWNER_EXISTS", "This deployment already has an owner.");
      }
    }
    return { userId, email, owner: input.owner };
  });
}

/** Moves the owner seat to an existing, already admitted local account. */
export async function transferLocalOwner(
  prisma: PrismaClient,
  input: { email: string },
): Promise<{ userId: string; previousOwnerUserId: string | null }> {
  const email = normalizeProvisionEmail(input.email);
  return withProvisioningLock(prisma, async (tx) => {
    const user = await tx.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true },
    });
    if (!user || user.id.startsWith("hub_")) {
      throw new ProvisioningError("NOT_FOUND", "No local account has this email");
    }
    const membership = await tx.spaceMember.findFirst({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!membership) {
      throw new ProvisioningError(
        "NOT_ADMITTED",
        "This account was never admitted; provision it before making it the owner",
      );
    }
    const previousOwnerUserId = await ownerOf(tx);
    await tx.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: user.id },
    });
    return { userId: user.id, previousOwnerUserId };
  });
}

/** Hub identifiers are opaque ids; an email in their place is an operator mistake. */
function validateHubIdentifier(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200 || /\s/.test(trimmed) || trimmed.includes("@")) {
    throw new ProvisioningError(
      "INVALID_INPUT",
      `${label} must be the Hub id, not an email address or blank`,
    );
  }
  return trimmed;
}

/** Refusal for Hub owner mapping without the deployment's tenant. Nothing is written. */
export const HUB_TENANT_MISSING = {
  code: "NOT_CONFIGURED",
  message:
    "AUTH_MODE=hub needs this deployment's tenant: set HUB_AUTH_TENANT_ID first. No owner was mapped.",
} as const;

export interface HubOwnerMappingInput {
  /** HUB_AUTH_ORIGIN as parsed by hubAuthFromEnv. */
  hubOrigin: string;
  /**
   * HUB_AUTH_TENANT_ID. Required: the owner's tenant must be this deployment's tenant, never
   * just the one the operator typed. Blank refuses the mapping (CAAH-43 M1).
   */
  configuredTenant: string;
  /** Hub tenant id that owns `hubUserId`. */
  hubTenant: string;
  /** Hub `tenant_users.id`. Never an Entra object id or an email. */
  hubUserId: string;
  /** Replace an existing owner instead of failing. */
  transfer: boolean;
}

/**
 * Names the deployment owner as a Hub identity without creating a user,
 * credential or session. The seat holds the same id Hub sign-in derives
 * (`hubUserId(origin, tenant, tenant_users.id)`), so it takes effect only
 * after that person signs in through Hub and passes Hub's admission check;
 * provisioning never bypasses the Hub gate.
 */
export async function mapHubOwner(
  prisma: PrismaClient,
  input: HubOwnerMappingInput,
): Promise<{ ownerUserId: string; previousOwnerUserId: string | null }> {
  if (typeof input.configuredTenant !== "string" || !input.configuredTenant.trim()) {
    throw new ProvisioningError(HUB_TENANT_MISSING.code, HUB_TENANT_MISSING.message);
  }
  const tenant = validateHubIdentifier("--hub-tenant", input.hubTenant);
  const subject = validateHubIdentifier("--hub-user-id", input.hubUserId);
  if (input.configuredTenant.trim() !== tenant) {
    throw new ProvisioningError(
      "INVALID_INPUT",
      "--hub-tenant does not match this deployment's HUB_AUTH_TENANT_ID",
    );
  }
  const ownerUserId = hubUserId(input.hubOrigin, tenant, subject);
  return withProvisioningLock(prisma, async (tx) => {
    const previousOwnerUserId = await ownerOf(tx);
    if (previousOwnerUserId && !input.transfer) {
      throw new ProvisioningError(
        "OWNER_EXISTS",
        "This deployment already has an owner. Use transfer-owner to move the seat.",
      );
    }
    const claimed = await tx.deploymentSettings.updateMany({
      where: { id: "default", ownerUserId: previousOwnerUserId },
      data: { ownerUserId },
    });
    if (claimed.count !== 1) {
      throw new ProvisioningError("OWNER_EXISTS", "The owner changed concurrently; retry.");
    }
    return { ownerUserId, previousOwnerUserId };
  });
}
