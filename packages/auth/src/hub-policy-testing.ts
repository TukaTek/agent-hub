import { createHubPolicy, type HubConfigFetch, hubPolicyDigest } from "./hub-policy.js";
import { HUB_POLICY_PRODUCT, HUB_POLICY_SCHEMA } from "./hub-policy-contract.js";
import { memoryHubPolicyStore } from "./hub-policy-store.js";

/**
 * A Hub service-config body with no overrides that assigns Agent Hub to `subjects`.
 * With no subjects the assignments are absent, which Agent Hub reads as pending.
 */
export function hubPolicyBodyForTests(
  tenantId: string,
  subjects: readonly string[],
  revision = 1,
): Record<string, unknown> {
  return {
    schemaVersion: HUB_POLICY_SCHEMA,
    product: HUB_POLICY_PRODUCT,
    tenantId,
    revision,
    updatedAt: null,
    overrides: {},
    ...(subjects.length
      ? {
          access: {
            status: "configured",
            productAssignments: subjects.map((tenantUserId) => ({
              tenantUserId,
              productId: HUB_POLICY_PRODUCT,
              role: "user",
            })),
          },
        }
      : {}),
  };
}

/**
 * A real Hub policy over an in-memory store for tests of code behind the gate.
 * Replace `hub.reply` to simulate outages or new revisions.
 */
export function hubPolicyForTests(tenantId: string, subjects: readonly string[] = ["subject-1"]) {
  const store = memoryHubPolicyStore();
  const hub: { reply: HubConfigFetch } = {
    reply: async () => ({ status: 200, body: hubPolicyBodyForTests(tenantId, subjects) }),
  };
  const policy = createHubPolicy({
    store,
    tenantId,
    fetchConfig: (etag) => hub.reply(etag),
    applied: { revision: null, digest: hubPolicyDigest(null) },
    log: () => undefined,
  });
  return { policy, store, hub };
}
