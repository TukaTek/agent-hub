import { expect, it } from "vitest";
import { loadEnv } from "../../../apps/api/src/env.js";
import { loadWorkerMetadata } from "../../../apps/worker/src/env.js";

const deploymentId = "0198f2ce-7d11-7a41-8b5c-7d1dfd62c551";

it("loads the identical deployment identity in API and worker composition", () => {
  const source = {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://rakazo:rakazo@127.0.0.1:5433/rakazo",
    CORTEXAI_DEPLOYMENT_ID: deploymentId,
  };

  expect(loadEnv(source).deploymentId).toBe(deploymentId);
  expect(loadWorkerMetadata(source).deploymentId).toBe(deploymentId);
});
