import { randomUUID } from "node:crypto";
import { createDb } from "@cortexai-agent-hub/db";
import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/agent-hub-service-config.v1.json" with { type: "json" };
import { applyHubPolicyAtStartup, createHubPolicy, type HubConfigFetch } from "./hub-policy.js";
import { prismaHubPolicyStore } from "./hub-policy-store.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;
const encryptionKey = "offline-encryption-key-not-a-real-secret";

describePostgres("Hub policy snapshot (PostgreSQL)", () => {
  it("shares one encrypted last-known-good revision between API and worker processes", async () => {
    const api = createDb(process.env.DATABASE_URL!);
    const worker = createDb(process.env.DATABASE_URL!);
    const tenantId = `tenant-${randomUUID()}`;
    const body = { ...structuredClone(fixture.cases.configured), tenantId };
    const fetchConfig = vi.fn<HubConfigFetch>(async () => ({
      status: 200,
      body,
      etag: '"etag-7"',
    }));
    try {
      const apiStore = prismaHubPolicyStore(api.prisma, encryptionKey);
      const apiEnv: NodeJS.ProcessEnv = {};
      const apiApplied = await applyHubPolicyAtStartup({
        store: apiStore,
        tenantId,
        env: apiEnv,
        fetchConfig,
        log: () => undefined,
      });
      const row = await api.prisma.hubPolicySnapshot.findUniqueOrThrow({
        where: { tenant: tenantId },
      });
      expect(row).toMatchObject({ revision: 7, state: "ok", source: "hub" });
      expect(row.documentCipher).not.toContain("hub-model-secret-not-real");
      const workerStore = prismaHubPolicyStore(worker.prisma, encryptionKey);
      const workerEnv: NodeJS.ProcessEnv = {};
      const workerApplied = await applyHubPolicyAtStartup({
        store: workerStore,
        tenantId,
        env: workerEnv,
        log: () => undefined,
      });
      expect(workerApplied).toEqual(apiApplied);
      expect(workerEnv.ANTHROPIC_API_KEY).toBe(apiEnv.ANTHROPIC_API_KEY);
      const policy = createHubPolicy({
        store: workerStore,
        tenantId,
        applied: workerApplied,
        log: () => undefined,
      });
      expect(await policy.workAllowed({ tenant: tenantId, subject: "subject-1" })).toBe(true);
      // A snapshot this key cannot read is no snapshot: nothing is granted.
      const otherKey = prismaHubPolicyStore(worker.prisma, "a-different-offline-key-not-real");
      expect((await otherKey.read(tenantId))?.document).toBeNull();
    } finally {
      await api.prisma.hubPolicySnapshot.deleteMany({ where: { tenant: tenantId } });
      await api.prisma.$disconnect();
      await worker.prisma.$disconnect();
      await api.pool.end();
      await worker.pool.end();
    }
  });
});
