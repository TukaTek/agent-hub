import { describe, expect, it } from "vitest";
import { DeploymentSettingsSchema } from "./domain.js";

const closed = {
  ownerUserId: null,
  signupsEnabled: false,
  signupAllowlist: [],
  hasDeploymentModelCredential: false,
  defaultProvider: null,
  defaultModel: null,
  computerHost: null,
  canChooseHostComputer: false,
  sandboxProvider: "fake",
};

describe("DeploymentSettingsSchema signup fields (CAAH-43)", () => {
  it("accepts only closed signup", () => {
    expect(DeploymentSettingsSchema.parse(closed)).toMatchObject({
      signupsEnabled: false,
      signupAllowlist: [],
    });
  });

  it("cannot carry a legacy open row or allowlist to clients", () => {
    for (const legacy of [
      { signupsEnabled: true },
      { signupAllowlist: ["visitor@example.test"] },
      { signupAllowlist: ["@example.test"] },
    ]) {
      expect(DeploymentSettingsSchema.safeParse({ ...closed, ...legacy }).success).toBe(false);
    }
  });
});
