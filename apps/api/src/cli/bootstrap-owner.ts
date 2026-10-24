import { randomUUID } from "node:crypto";
import { createAuth, hubAuthFromEnv } from "@cortexai-agent-hub/auth";
import { bootstrapUserSpace, createDb, runAsSystem } from "@cortexai-agent-hub/db";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

// Hub owns every sign-in in Hub mode, so a local password owner would route around it.
if (hubAuthFromEnv(process.env))
  throw new Error("Owner bootstrap can't be combined with Hub sign-in");

const { prisma, pool } = createDb(required("DATABASE_URL"));
try {
  await runAsSystem("private account bootstrap", bootstrap);
} finally {
  await prisma.$disconnect();
  await pool.end();
}

async function bootstrap() {
  const email = required("OWNER_EMAIL").trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing?.emailVerified) {
    const password = required("OWNER_PASSWORD");
    if (password.length < 16) throw new Error("OWNER_PASSWORD must contain at least 16 characters");
    const baseURL = required("BETTER_AUTH_URL");
    const auth = createAuth(prisma, {
      secret: required("BETTER_AUTH_SECRET"),
      baseURL,
      webOrigin: baseURL,
      signupsEnabled: "false",
      signupAllowlist: "",
    });
    const context = await auth.$context;
    if (existing) {
      // Never verify a public signup just because its email matches the operator's input.
      const account = await prisma.account.findFirst({
        where: { userId: existing.id, providerId: "credential" },
      });
      if (
        !account?.password ||
        !(await context.password.verify({ hash: account.password, password }))
      ) {
        throw new Error("Existing account password does not match; account was not verified");
      }
      await prisma.user.update({ where: { id: existing.id }, data: { emailVerified: true } });
    } else {
      const hash = await context.password.hash(password);
      const userId = randomUUID();
      await prisma.user.create({
        data: {
          id: userId,
          name: "Account",
          email,
          emailVerified: true,
          accounts: {
            create: {
              id: randomUUID(),
              accountId: userId,
              providerId: "credential",
              password: hash,
            },
          },
        },
      });
    }
    process.stdout.write("Account verified\n");
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  await bootstrapUserSpace(prisma, user, { signupsEnabled: "false", signupAllowlist: "" });
  await prisma.deploymentSettings.update({
    where: { id: "default" },
    data: { signupsEnabled: false, signupPolicyInitialized: true },
  });
}
