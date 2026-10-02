import { createHubPolicy, type HubConfigFetch } from "./hub-policy.js";
import {
  HUB_ASSIGNMENTS_CONTRACT,
  HUB_POLICY_PRODUCT,
  HUB_POLICY_SCHEMA,
} from "./hub-policy-contract.js";
import { memoryHubPolicyStore } from "./hub-policy-store.js";

export interface HubPolicyBodyOptions {
  /** Send Hub's `access.contract` marker; an empty list then means nobody is assigned. */
  contract?: boolean;
}

/**
 * A Hub service-config body with no overrides that assigns Agent Hub to `subjects`.
 * Without the contract marker and with no subjects, the assignments are absent,
 * which Agent Hub reads as pending (CAH-204).
 */
export function hubPolicyBodyForTests(
  tenantId: string,
  subjects: readonly string[],
  revision = 1,
  options: HubPolicyBodyOptions = {},
): Record<string, unknown> {
  const productAssignments = subjects.map((tenantUserId) => ({
    tenantUserId,
    productId: HUB_POLICY_PRODUCT,
    role: "user",
  }));
  if (options.contract)
    return {
      ...hubPolicyBodyForTests(tenantId, [], revision),
      access: { status: "configured", contract: HUB_ASSIGNMENTS_CONTRACT, productAssignments },
    };
  return {
    schemaVersion: HUB_POLICY_SCHEMA,
    product: HUB_POLICY_PRODUCT,
    tenantId,
    revision,
    updatedAt: null,
    overrides: {},
    ...(subjects.length
      ? {
          access: { status: "configured", productAssignments },
        }
      : {}),
  };
}

/**
 * A real Hub policy over an in-memory store for tests of code behind the gate.
 * Replace `hub.reply` to simulate outages or new revisions.
 */
export function hubPolicyForTests(
  tenantId: string,
  subjects: readonly string[] = ["subject-1"],
  options: HubPolicyBodyOptions = {},
) {
  const store = memoryHubPolicyStore();
  const hub: { reply: HubConfigFetch } = {
    reply: async () => ({
      status: 200,
      body: hubPolicyBodyForTests(tenantId, subjects, 1, options),
    }),
  };
  const policy = createHubPolicy({
    store,
    tenantId,
    fetchConfig: (etag) => hub.reply(etag),
    applied: { revision: null, digest: store.digest(null) },
    log: () => undefined,
  });
  return { policy, store, hub };
}
