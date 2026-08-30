import { describe, expect, it } from "vitest";
import { LOCAL_DEPLOYMENT_ID, resolveDeploymentIdentity } from "./deployment-identity.js";

const deploymentId = "0198f2ce-7d11-7a41-8b5c-7d1dfd62c551";

describe("resolveDeploymentIdentity", () => {
  it.each([
    ["missing", undefined],
    ["blank", ""],
    ["whitespace", "   "],
    ["local placeholder", LOCAL_DEPLOYMENT_ID],
    ["example placeholder", "00000000-0000-4000-8000-000000000000"],
    ["malformed", "deployment-123"],
    ["uppercase", deploymentId.toUpperCase()],
    ["whitespace-altered", ` ${deploymentId}`],
  ])("rejects a %s production ID", (_label, value) => {
    expect(() =>
      resolveDeploymentIdentity({
        NODE_ENV: "production",
        CORTEXAI_DEPLOYMENT_ID: value,
      }),
    ).toThrow(/CORTEXAI_DEPLOYMENT_ID/);
  });

  it("preserves an exact canonical production ID", () => {
    expect(
      resolveDeploymentIdentity({
        NODE_ENV: "production",
        CORTEXAI_DEPLOYMENT_ID: deploymentId,
      }),
    ).toBe(deploymentId);
  });

  it.each(["development", "test"])(
    "uses one deterministic local identity in %s when no ID is supplied",
    (nodeEnv) => {
      expect(resolveDeploymentIdentity({ NODE_ENV: nodeEnv })).toBe(LOCAL_DEPLOYMENT_ID);
    },
  );

  it("does not replace a malformed explicit local ID with the fallback", () => {
    expect(() =>
      resolveDeploymentIdentity({
        NODE_ENV: "test",
        CORTEXAI_DEPLOYMENT_ID: " malformed ",
      }),
    ).toThrow(/CORTEXAI_DEPLOYMENT_ID/);
  });
});
