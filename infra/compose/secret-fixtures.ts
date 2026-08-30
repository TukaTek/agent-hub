import { createHash } from "node:crypto";

const FIXTURE_DOMAIN = "rakazo:deterministic-non-secret-fixture:v1\0";

/**
 * Produce stable runtime-only test material without committing secret-shaped literals.
 */
export function deterministicSecretFixture(label: string): string {
  return createHash("sha256").update(FIXTURE_DOMAIN).update(label).digest("hex");
}
