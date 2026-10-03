import { createHmac, randomBytes } from "node:crypto";
import type { PrismaClient } from "@cortexai-agent-hub/db";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import type { HubPolicyDocument } from "./hub-policy-contract.js";

/**
 * Keyed digest of the startup-bound overrides. The overrides include Hub-delivered
 * secrets, so the stored digest is an HMAC under a server-side key, never a plain hash.
 */
export function hubPolicyDigest(
  document: Pick<HubPolicyDocument, "overrides"> | null,
  key: string,
): string {
  const overrides = document?.overrides ?? {};
  const canonical = Object.keys(overrides)
    .sort()
    .map((path) => [path, overrides[path]]);
  return createHmac("sha256", key).update(JSON.stringify(canonical)).digest("hex");
}

export type HubPolicyState =
  | "ok"
  | "unavailable"
  | "invalid"
  | "tenant_disabled"
  | "credential_invalid";

/**
 * The shared last-known-good Hub policy. API and worker read the same row, so both
 * see one revision. `source` says whether the document was confirmed by the latest
 * Hub contact (`hub`) or is being kept after a failed one (`last_known_good`).
 */
export interface HubPolicyRecord {
  tenant: string;
  document: HubPolicyDocument | null;
  revision: number | null;
  etag: string | null;
  /** Digest of the startup-bound overrides. Server-side only; never shown to anyone. */
  digest: string | null;
  state: HubPolicyState;
  /** A fixed reason token or setting path; never a value. */
  reason: string | null;
  source: "hub" | "last_known_good";
  assignmentsSource: "hub" | "last_known_good";
  /** Last accepted 200 from Hub. */
  fetchedAt: Date | null;
  /** Last successful Hub contact (200 or 304). */
  checkedAt: Date | null;
  attemptedAt: Date;
}

export interface HubPolicyStore {
  read(tenant: string): Promise<HubPolicyRecord | null>;
  write(record: HubPolicyRecord): Promise<void>;
  /** The keyed overrides digest. Every process sharing the store computes the same one. */
  digest(document: Pick<HubPolicyDocument, "overrides"> | null): string;
}

/** Process-local store for tests and single-process tools. */
export function memoryHubPolicyStore(digestKey = randomBytes(32).toString("hex")): HubPolicyStore {
  const rows = new Map<string, HubPolicyRecord>();
  return {
    digest: (document) => hubPolicyDigest(document, digestKey),
    read: async (tenant) => {
      const row = rows.get(tenant);
      return row ? structuredClone(row) : null;
    },
    write: async (record) => {
      rows.set(record.tenant, structuredClone(record));
    },
  };
}

/** The document holds Hub-delivered credentials, so it is stored encrypted. */
export function prismaHubPolicyStore(prisma: PrismaClient, encryptionKey: string): HubPolicyStore {
  // A purpose-bound subkey, so the digest never uses the encryption key directly.
  const digestKey = createHmac("sha256", encryptionKey)
    .update("cortexai-agent-hub/hub-policy-digest/v1")
    .digest("hex");
  return {
    digest: (document) => hubPolicyDigest(document, digestKey),
    async read(tenant) {
      const row = await prisma.hubPolicySnapshot.findUnique({ where: { tenant } });
      if (!row) return null;
      let document: HubPolicyDocument | null = null;
      if (row.documentCipher) {
        try {
          document = JSON.parse(
            await symmetricDecrypt({ key: encryptionKey, data: row.documentCipher }),
          );
        } catch {
          // An unreadable snapshot (for example after a key rotation) is no snapshot.
          document = null;
        }
      }
      return {
        tenant: row.tenant,
        document,
        revision: document ? row.revision : null,
        etag: document ? row.etag : null,
        digest: document ? row.digest : null,
        state: row.state as HubPolicyState,
        reason: row.reason,
        source: row.source as HubPolicyRecord["source"],
        assignmentsSource: row.assignmentsSource as HubPolicyRecord["assignmentsSource"],
        fetchedAt: row.fetchedAt,
        checkedAt: row.checkedAt,
        attemptedAt: row.attemptedAt,
      };
    },
    async write(record) {
      const data = {
        documentCipher: record.document
          ? await symmetricEncrypt({ key: encryptionKey, data: JSON.stringify(record.document) })
          : null,
        revision: record.revision,
        etag: record.etag,
        digest: record.digest,
        state: record.state,
        reason: record.reason,
        source: record.source,
        assignmentsSource: record.assignmentsSource,
        fetchedAt: record.fetchedAt,
        checkedAt: record.checkedAt,
        attemptedAt: record.attemptedAt,
      };
      await prisma.hubPolicySnapshot.upsert({
        where: { tenant: record.tenant },
        create: { tenant: record.tenant, ...data },
        update: data,
      });
    },
  };
}
