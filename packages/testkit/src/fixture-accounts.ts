import { ProvisioningError, provisionLocalAccount } from "@cortexai-agent-hub/auth";
import type { PrismaClient } from "@cortexai-agent-hub/db";

/**
 * Test-only account fixtures (CAAH-43). Self-service signup is closed, so
 * suites create accounts the way an operator does, through the provisioning
 * code the CLI calls, and then sign in over HTTP like any client. Nothing here
 * adds an HTTP route to the product.
 */

export const FIXTURE_ORIGIN = "http://127.0.0.1:5173";

export interface FixtureAccount {
  email: string;
  name: string;
  password?: string;
  /**
   * Owner seat. "first" (default) grants it only while the deployment has no
   * owner, matching what suites written before CAAH-43 assumed of their first
   * account. Suites that test ownership pass true or false explicitly.
   */
  owner?: boolean | "first";
}

export const FIXTURE_PASSWORD = "password12";

export async function provisionFixtureAccount(prisma: PrismaClient, account: FixtureAccount) {
  const input = {
    email: account.email,
    name: account.name,
    password: account.password ?? FIXTURE_PASSWORD,
  };
  if (account.owner !== "first" && account.owner !== undefined) {
    return provisionLocalAccount(prisma, { ...input, owner: account.owner });
  }
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { ownerUserId: true },
  });
  if (settings?.ownerUserId) return provisionLocalAccount(prisma, { ...input, owner: false });
  try {
    return await provisionLocalAccount(prisma, { ...input, owner: true });
  } catch (error) {
    // A concurrent fixture took the seat first; this one is an ordinary account.
    if (!(error instanceof ProvisioningError) || error.code !== "OWNER_EXISTS") throw error;
    return provisionLocalAccount(prisma, { ...input, owner: false });
  }
}

interface RequestingApp {
  request(input: string, init?: RequestInit): Response | Promise<Response>;
}

/** Signs in with email and password; returns the raw response. */
export async function signInFixture(
  app: RequestingApp,
  email: string,
  password: string = FIXTURE_PASSWORD,
  origin: string = FIXTURE_ORIGIN,
) {
  return app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email, password }),
  });
}

/** Cookie header carrying the session a Better Auth response set. */
export function sessionCookieHeader(response: Response) {
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
  return response.headers.get("set-cookie")?.split(",")[0]?.split(";")[0] ?? "";
}

/**
 * Provisions an account and signs it in, returning its session cookie header.
 * This replaces the pre-CAAH-43 `POST /api/auth/sign-up/email` fixture.
 */
export async function provisionAndSignIn(
  handles: { app: RequestingApp; prisma: PrismaClient },
  account: FixtureAccount,
  origin: string = FIXTURE_ORIGIN,
): Promise<string> {
  await provisionFixtureAccount(handles.prisma, account);
  const response = await signInFixture(
    handles.app,
    account.email,
    account.password ?? FIXTURE_PASSWORD,
    origin,
  );
  if (response.status >= 400) {
    throw new Error(`fixture sign-in failed ${response.status}: ${await response.text()}`);
  }
  const cookie = sessionCookieHeader(response);
  if (!cookie.includes("session_token")) throw new Error("fixture sign-in returned no session");
  return cookie;
}
