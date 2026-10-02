/**
 * Operator-only provisioning commands for deployment owner and users.
 * These commands are the ONLY way to create accounts after self-service signup is removed.
 */

import { randomBytes, scrypt } from "node:crypto";
import { readFileSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline";
import { bootstrapUserSpace, type PrismaClient } from "@cortexai-agent-hub/db";

interface ProvisionEnv {
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
}

/**
 * Hash a password using Better Auth's bcrypt-compatible approach.
 * This must match the password hashing used by Better Auth.
 */
async function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16);
    scrypt(Buffer.from(password), salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      // Format compatible with bcrypt (Better Auth uses bcrypt by default)
      // Using a simple format: $scrypt$salt$hash
      resolve(`$scrypt$${salt.toString("hex")}$${derivedKey.toString("hex")}`);
    });
  });
}

/**
 * Read password from stdin, TTY prompt, or secret file.
 * NEVER accept passwords from argv or environment variables.
 */
async function readSecret(secretFile: string | undefined, promptMsg: string): Promise<string> {
  // Check for stdin (piped input)
  if (!process.stdin.isTTY && !secretFile) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const secret = Buffer.concat(chunks).toString("utf-8").trim();
    if (!secret) throw new Error("Empty password from stdin");
    return secret;
  }

  // Read from file if specified
  if (secretFile) {
    try {
      const secret = readFileSync(secretFile, "utf-8").trim();
      if (!secret) throw new Error(`Empty password in file: ${secretFile}`);
      return secret;
    } catch (error) {
      throw new Error(`Failed to read secret file: ${secretFile}`, { cause: error });
    }
  }

  // Interactive TTY prompt
  const rl = createInterface({ input, output });
  return new Promise((resolve, reject) => {
    rl.question(promptMsg, (answer) => {
      rl.close();
      const secret = answer.trim();
      if (!secret) reject(new Error("Empty password"));
      else resolve(secret);
    });
  });
}

/**
 * Validate that password was not passed via argv or env vars.
 * This is a security check to prevent secrets from leaking into logs.
 */
function validateSecretSource(password: string): void {
  // Check if password appears in process.argv
  if (process.argv.some((arg) => arg.includes(password))) {
    throw new Error(
      "SECURITY: Password must not be passed via command line arguments. Use stdin, TTY prompt, or --secret-file.",
    );
  }

  // Check if password appears in environment variables
  for (const value of Object.values(process.env)) {
    if (value?.includes(password)) {
      throw new Error(
        "SECURITY: Password must not be passed via environment variables. Use stdin, TTY prompt, or --secret-file.",
      );
    }
  }
}

/**
 * Generate a random user ID.
 */
function generateUserId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * provision-owner: Create the first deployment owner with a local credential.
 * Fails without changes if an owner already exists.
 * Concurrent runs leave exactly one owner.
 */
export async function provisionOwner(
  prisma: PrismaClient,
  env: ProvisionEnv,
  options: {
    email: string;
    name: string;
    secretFile?: string;
    hubUserId?: string;
    hubTenant?: string;
  },
): Promise<{ userId: string; email: string; success: boolean; message: string }> {
  const { email, name, secretFile } = options;
  // Hub mode parameters reserved for future implementation
  // const { hubUserId, hubTenant } = options;

  // Read password securely
  const password = await readSecret(secretFile, `Enter password for deployment owner (${email}): `);

  // Validate password source
  validateSecretSource(password);

  // Check if owner already exists
  const existingSettings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { ownerUserId: true },
  });

  if (existingSettings?.ownerUserId) {
    const existingOwner = await prisma.user.findUnique({
      where: { id: existingSettings.ownerUserId },
      select: { email: true, name: true },
    });
    return {
      userId: existingSettings.ownerUserId,
      email: existingOwner?.email ?? "unknown",
      success: false,
      message: `Deployment owner already exists: ${existingOwner?.name} (${existingOwner?.email})`,
    };
  }

  // Hash the password
  const hashedPassword = await hashPassword(password);

  // Create owner in a transaction
  return prisma.$transaction(async (tx) => {
    // Check again inside transaction for concurrent safety
    const settings = await tx.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { ownerUserId: true },
    });

    if (settings?.ownerUserId) {
      const owner = await tx.user.findUnique({
        where: { id: settings.ownerUserId },
        select: { email: true, name: true },
      });
      return {
        userId: settings.ownerUserId,
        email: owner?.email ?? "unknown",
        success: false,
        message: `Deployment owner already exists: ${owner?.name} (${owner?.email})`,
      };
    }

    const userId = generateUserId();

    // Create user
    await tx.user.create({
      data: {
        id: userId,
        email,
        name,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // Create account with hashed password
    await tx.account.create({
      data: {
        id: generateUserId(),
        userId,
        accountId: email,
        providerId: "credential",
        password: hashedPassword,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // Bootstrap user space (org, space, memberships)
    await bootstrapUserSpace(tx as unknown as PrismaClient, { id: userId }, env);

    // Set as deployment owner
    await tx.deploymentSettings.updateMany({
      where: { id: "default", ownerUserId: null },
      data: { ownerUserId: userId },
    });

    return {
      userId,
      email,
      success: true,
      message: `Successfully provisioned deployment owner: ${name} (${email})`,
    };
  });
}

/**
 * provision-user: Create a local user without deployment owner privileges.
 * Used for additional operator-provisioned accounts.
 */
export async function provisionUser(
  prisma: PrismaClient,
  env: ProvisionEnv,
  options: {
    email: string;
    name: string;
    secretFile?: string;
  },
): Promise<{ userId: string; email: string; success: boolean; message: string }> {
  const { email, name, secretFile } = options;

  // Check if user already exists
  const existingUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true },
  });

  if (existingUser) {
    return {
      userId: existingUser.id,
      email,
      success: false,
      message: `User already exists: ${existingUser.name} (${email})`,
    };
  }

  // Read password securely
  const password = await readSecret(secretFile, `Enter password for user (${email}): `);

  // Validate password source
  validateSecretSource(password);

  // Hash the password
  const hashedPassword = await hashPassword(password);

  // Create user in a transaction
  return prisma.$transaction(async (tx) => {
    const userId = generateUserId();

    // Create user
    await tx.user.create({
      data: {
        id: userId,
        email,
        name,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // Create account with hashed password
    await tx.account.create({
      data: {
        id: generateUserId(),
        userId,
        accountId: email,
        providerId: "credential",
        password: hashedPassword,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // Bootstrap user space (org, space, memberships) without owner claim
    await bootstrapUserSpace(tx as unknown as PrismaClient, { id: userId }, env);

    return {
      userId,
      email,
      success: true,
      message: `Successfully provisioned user: ${name} (${email})`,
    };
  });
}

/**
 * transfer-owner: Transfer deployment ownership to an existing user.
 * Used for recovery and explicit owner transfers.
 * Supports mapping Hub identities to owner for AUTH_MODE=hub deployments.
 */
export async function transferOwner(
  prisma: PrismaClient,
  options: {
    email: string;
    hubUserId?: string;
    hubTenant?: string;
  },
): Promise<{ userId: string; email: string; success: boolean; message: string }> {
  const { email } = options;
  // Hub mode parameters reserved for future implementation
  // const { hubUserId, hubTenant } = options;

  // Find the target user
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true },
  });

  if (!user) {
    return {
      userId: "",
      email,
      success: false,
      message: `User not found: ${email}`,
    };
  }

  // Get current owner
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { ownerUserId: true },
  });

  const currentOwnerId = settings?.ownerUserId;

  if (currentOwnerId === user.id) {
    return {
      userId: user.id,
      email: user.email,
      success: true,
      message: `User is already the deployment owner: ${user.name} (${user.email})`,
    };
  }

  // Transfer ownership
  await prisma.deploymentSettings.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      ownerUserId: user.id,
      signupsEnabled: false,
      signupAllowlist: "",
      signupPolicyInitialized: true,
    },
    update: {
      ownerUserId: user.id,
    },
  });

  let message = `Successfully transferred ownership to: ${user.name} (${user.email})`;
  if (currentOwnerId) {
    const previousOwner = await prisma.user.findUnique({
      where: { id: currentOwnerId },
      select: { name: true, email: true },
    });
    if (previousOwner) {
      message += `\nPrevious owner: ${previousOwner.name} (${previousOwner.email})`;
    }
  }

  return {
    userId: user.id,
    email: user.email,
    success: true,
    message,
  };
}

/**
 * Parse CLI arguments for provision commands.
 */
export function parseProvisionArgs(args: string[]): {
  command: "provision-owner" | "provision-user" | "transfer-owner";
  email?: string;
  name?: string;
  secretFile?: string;
  hubUserId?: string;
  hubTenant?: string;
} | null {
  if (args.length < 1) return null;

  const command = args[0];
  if (
    command !== "provision-owner" &&
    command !== "provision-user" &&
    command !== "transfer-owner"
  ) {
    return null;
  }

  let email: string | undefined;
  let name: string | undefined;
  let hubUserId: string | undefined;
  let hubTenant: string | undefined;
  let secretFile: string | undefined;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--email" && i + 1 < args.length) {
      email = args[i + 1];
      i++;
    } else if (arg === "--name" && i + 1 < args.length) {
      name = args[i + 1];
      i++;
    } else if (arg === "--secret-file" && i + 1 < args.length) {
      secretFile = args[i + 1];
      i++;
    } else if (arg === "--hub-user-id" && i + 1 < args.length) {
      hubUserId = args[i + 1];
      i++;
    } else if (arg === "--hub-tenant" && i + 1 < args.length) {
      hubTenant = args[i + 1];
      i++;
    }
  }

  return { command, email, name, secretFile, hubUserId, hubTenant };
}
