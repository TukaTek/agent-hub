export const LOCAL_DEPLOYMENT_ID = "00000000-0000-0000-0000-000000000000";

const CANONICAL_DEPLOYMENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRODUCTION_PLACEHOLDERS = new Set([
  LOCAL_DEPLOYMENT_ID,
  "00000000-0000-4000-8000-000000000000",
]);

const INVALID_DEPLOYMENT_ID =
  "CORTEXAI_DEPLOYMENT_ID must be an exact canonical lowercase UUID generated once for this deployment.";

/**
 * Resolve the immutable deployment identity shared by every process in one stack.
 *
 * Production never trims, normalizes, or substitutes this value. Local development
 * and tests get one explicit deterministic sentinel when the variable is absent.
 */
export function resolveDeploymentIdentity(source: NodeJS.ProcessEnv = process.env): string {
  const supplied = source.CORTEXAI_DEPLOYMENT_ID;
  const production = source.NODE_ENV === "production";

  if (supplied === undefined || supplied === "") {
    if (!production) return LOCAL_DEPLOYMENT_ID;
    throw new Error(INVALID_DEPLOYMENT_ID);
  }
  if (!production && supplied === LOCAL_DEPLOYMENT_ID) return LOCAL_DEPLOYMENT_ID;
  if (
    supplied !== supplied.trim() ||
    !CANONICAL_DEPLOYMENT_ID.test(supplied) ||
    PRODUCTION_PLACEHOLDERS.has(supplied)
  ) {
    throw new Error(INVALID_DEPLOYMENT_ID);
  }
  return supplied;
}
