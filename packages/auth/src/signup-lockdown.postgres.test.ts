import { randomUUID } from "node:crypto";
import { createDb } from "@cortexai-agent-hub/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hubUserId } from "./hub-client.js";
import { createAuth } from "./index.js";
import {
  mapHubOwner,
  ProvisioningError,
  provisionLocalAccount,
  transferLocalOwner,
} from "./provisioning.js";

/**
 * CAAH-43 against real PostgreSQL and the real Better Auth adapter: signup is
 * closed on fresh and upgraded installs, the owner is set only by explicit
 * operator provisioning, and provisioned accounts sign in with the app's own
 * password hashing.
 */
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

const origin = "http://web.example.test";
const password = "fixture-password12";

describePostgres("signup lockdown and owner provisioning (PostgreSQL)", () => {
  // Built in beforeAll: a skipped suite still runs this callback to collect tests.
  let db: ReturnType<typeof createDb>;
  let prisma: ReturnType<typeof createDb>["prisma"];
  let auth: ReturnType<typeof createAuth>;
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    auth = createAuth(prisma, {
      secret: "offline-auth-secret-at-least-32-characters",
      baseURL: origin,
      webOrigin: origin,
      // Legacy inputs that used to open signup; they must change nothing.
      signupsEnabled: "true",
      signupAllowlist: "",
    });
  });
  const request = (path: string, body: unknown, cookie?: string) =>
    auth.handler(
      new Request(`${origin}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      }),
    );
  const email = (label: string) => `${label}-${randomUUID()}@cortexai-agent-hub.test`;
  const owner = async () =>
    (
      await prisma.deploymentSettings.findUnique({
        where: { id: "default" },
        select: { ownerUserId: true },
      })
    )?.ownerUserId ?? null;

  beforeEach(async () => {
    await prisma.deploymentSettings.updateMany({ data: { ownerUserId: null } });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.pool.end();
  });

  it("fresh install: direct signup is refused and creates no account", async () => {
    await prisma.deploymentSettings.deleteMany({});
    const visitor = email("fresh-visitor");
    const response = await request("/sign-up/email", { email: visitor, password, name: "V" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Registration is closed");
    expect(await prisma.user.count({ where: { email: visitor } })).toBe(0);
    expect(await owner()).toBeNull();
  });

  it("upgrade with a legacy open policy: signup stays closed and an unadmitted signup cannot sign in", async () => {
    const pending = email("legacy-pending");
    await prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        signupsEnabled: true,
        signupAllowlist: `${pending},@cortexai-agent-hub.test`,
        signupPolicyInitialized: true,
      },
      update: {
        signupsEnabled: true,
        signupAllowlist: `${pending},@cortexai-agent-hub.test`,
        signupPolicyInitialized: true,
      },
    });
    const visitor = email("legacy-visitor");
    for (const target of [visitor, pending]) {
      const response = await request("/sign-up/email", { email: target, password, name: "V" });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Registration is closed");
    }
    expect(await prisma.user.count({ where: { email: visitor } })).toBe(0);

    // A pre-upgrade signup that never got a space (pending mailbox proof).
    // Create it as a real credential, then strip the space provisioning added.
    const { userId } = await provisionLocalAccount(prisma, {
      email: pending,
      name: "Pending",
      password,
      owner: false,
    });
    await prisma.spaceMember.deleteMany({ where: { userId } });
    await prisma.user.update({ where: { id: userId }, data: { emailVerified: false } });
    const signIn = await request("/sign-in/email", { email: pending, password });
    expect(signIn.status).toBe(403);
    expect(await signIn.text()).toContain("Registration is closed");
    expect(await prisma.session.count({ where: { userId } })).toBe(0);
    expect(await prisma.spaceMember.count({ where: { userId } })).toBe(0);
    expect(await owner()).toBeNull();
  });

  it("provision-owner creates a local owner who signs in with the app's hashing", async () => {
    const ownerEmail = email("owner");
    const result = await provisionLocalAccount(prisma, {
      email: ownerEmail.toUpperCase(),
      name: "Owner",
      password,
      owner: true,
    });
    expect(result).toMatchObject({ email: ownerEmail, owner: true });
    expect(await owner()).toBe(result.userId);
    expect(await prisma.spaceMember.count({ where: { userId: result.userId } })).toBe(1);

    const signIn = await request("/sign-in/email", { email: ownerEmail, password });
    expect(signIn.status).toBe(200);
    expect(await prisma.session.count({ where: { userId: result.userId } })).toBe(1);
    expect(
      (await request("/sign-in/email", { email: ownerEmail, password: "wrong-pass12" })).status,
    ).toBe(401);
  });

  it("an existing owner makes provision-owner fail with no change", async () => {
    const first = await provisionLocalAccount(prisma, {
      email: email("seated"),
      name: "Seated",
      password,
      owner: true,
    });
    const usersBefore = await prisma.user.count();
    const second = email("usurper");
    await expect(
      provisionLocalAccount(prisma, { email: second, name: "Usurper", password, owner: true }),
    ).rejects.toMatchObject({ code: "OWNER_EXISTS" });
    expect(await prisma.user.count()).toBe(usersBefore);
    expect(await prisma.user.count({ where: { email: second } })).toBe(0);
    expect(await owner()).toBe(first.userId);
  });

  it("concurrent provision-owner runs leave exactly one owner and no extra account", async () => {
    const usersBefore = await prisma.user.count();
    const emails = Array.from({ length: 5 }, (_, index) => email(`race-${index}`));
    const results = await Promise.allSettled(
      emails.map((target) =>
        provisionLocalAccount(prisma, { email: target, name: "Racer", password, owner: true }),
      ),
    );
    const won = results.filter((result) => result.status === "fulfilled");
    const lost = results.filter((result) => result.status === "rejected");
    expect(won).toHaveLength(1);
    for (const result of lost) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ProvisioningError);
      expect((result as PromiseRejectedResult).reason).toMatchObject({ code: "OWNER_EXISTS" });
    }
    expect(await prisma.user.count()).toBe(usersBefore + 1);
    expect(await owner()).toBe((won[0] as PromiseFulfilledResult<{ userId: string }>).value.userId);
  });

  it("provision-user grants no ownership; transfer-owner moves the seat explicitly", async () => {
    const seated = await provisionLocalAccount(prisma, {
      email: email("before-transfer"),
      name: "Owner",
      password,
      owner: true,
    });
    const userEmail = email("member");
    const member = await provisionLocalAccount(prisma, {
      email: userEmail,
      name: "Member",
      password,
      owner: false,
    });
    expect(await owner()).toBe(seated.userId);
    expect((await request("/sign-in/email", { email: userEmail, password })).status).toBe(200);
    expect(await owner()).toBe(seated.userId);

    await expect(
      provisionLocalAccount(prisma, { email: userEmail, name: "Again", password, owner: false }),
    ).rejects.toMatchObject({ code: "EMAIL_TAKEN" });

    const moved = await transferLocalOwner(prisma, { email: userEmail });
    expect(moved).toEqual({ userId: member.userId, previousOwnerUserId: seated.userId });
    expect(await owner()).toBe(member.userId);
  });

  it("removing the owner does not reopen an automatic claim", async () => {
    const ownerEmail = email("leaving-owner");
    const seated = await provisionLocalAccount(prisma, {
      email: ownerEmail,
      name: "Leaving",
      password,
      owner: true,
    });
    const signIn = await request("/sign-in/email", { email: ownerEmail, password });
    const cookie = signIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const deleted = await request("/delete-user", { password }, cookie);
    expect(deleted.status).toBe(200);
    expect(await prisma.user.count({ where: { id: seated.userId } })).toBe(0);
    expect(await owner()).toBeNull();

    // Neither a later sign-in nor a fresh account takes the empty seat.
    const nextEmail = email("next");
    await provisionLocalAccount(prisma, { email: nextEmail, name: "Next", password, owner: false });
    expect((await request("/sign-in/email", { email: nextEmail, password })).status).toBe(200);
    const visitor = await request("/sign-up/email", { email: email("v"), password, name: "V" });
    expect(visitor.status).toBe(400);
    expect(await owner()).toBeNull();
  });

  it("Hub owner mapping names tenant_users.id plus tenant and creates no local login", async () => {
    const hubOrigin = "https://hub.example.test";
    const tenant = `tenant-${randomUUID()}`;
    const tenantUserId = randomUUID();
    const usersBefore = await prisma.user.count();
    const accountsBefore = await prisma.account.count();
    const mapped = await mapHubOwner(prisma, {
      hubOrigin,
      hubTenant: tenant,
      hubUserId: tenantUserId,
      transfer: false,
    });
    expect(mapped.ownerUserId).toBe(hubUserId(hubOrigin, tenant, tenantUserId));
    expect(await owner()).toBe(mapped.ownerUserId);
    // No user, credential or session: the seat applies only after Hub sign-in and admission.
    expect(await prisma.user.count()).toBe(usersBefore);
    expect(await prisma.account.count()).toBe(accountsBefore);
    expect(await prisma.session.count({ where: { userId: mapped.ownerUserId } })).toBe(0);

    await expect(
      mapHubOwner(prisma, {
        hubOrigin,
        hubTenant: tenant,
        hubUserId: randomUUID(),
        transfer: false,
      }),
    ).rejects.toMatchObject({ code: "OWNER_EXISTS" });
    for (const hubUser of ["owner@example.test", " ", ""]) {
      await expect(
        mapHubOwner(prisma, { hubOrigin, hubTenant: tenant, hubUserId: hubUser, transfer: true }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    await expect(
      mapHubOwner(prisma, {
        hubOrigin,
        configuredTenant: "other-tenant",
        hubTenant: tenant,
        hubUserId: tenantUserId,
        transfer: true,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await owner()).toBe(mapped.ownerUserId);
  });
});
