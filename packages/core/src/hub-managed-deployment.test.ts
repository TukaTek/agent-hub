import { afterEach, describe, expect, it } from "vitest";
import {
  hubManagedDeploymentSettings,
  setHubManagedDeploymentSettings,
  withHubModelDefaults,
  withHubSignupPolicy,
} from "./hub-managed-deployment.js";

const row = {
  id: "default",
  defaultModelProvider: "openrouter",
  defaultModelId: "openrouter/model",
};

afterEach(() => setHubManagedDeploymentSettings({}));

describe("Hub-managed deployment settings", () => {
  it("returns the persisted row unchanged when Hub manages no model default", () => {
    expect(withHubModelDefaults(row)).toBe(row);
    expect(withHubModelDefaults(null)).toBeNull();
  });

  it("replaces the persisted provider and model with Hub's without touching the row", () => {
    setHubManagedDeploymentSettings({
      defaultModelProvider: "anthropic",
      defaultModelId: "claude-sonnet-5",
    });
    expect(withHubModelDefaults(row)).toEqual({
      id: "default",
      defaultModelProvider: "anthropic",
      defaultModelId: "claude-sonnet-5",
    });
    expect(row.defaultModelProvider).toBe("openrouter");
  });

  it("applies Hub's defaults when no row was persisted", () => {
    setHubManagedDeploymentSettings({ defaultModelProvider: "anthropic", defaultModelId: null });
    expect(withHubModelDefaults(null)).toEqual({
      defaultModelProvider: "anthropic",
      defaultModelId: null,
    });
  });

  it("drops the persisted model when Hub replaces only the provider", () => {
    setHubManagedDeploymentSettings({ defaultModelProvider: "anthropic" });
    expect(withHubModelDefaults(row)).toMatchObject({
      defaultModelProvider: "anthropic",
      defaultModelId: null,
    });
  });

  it("applies Hub's signup policy over the persisted one", () => {
    expect(withHubSignupPolicy({ enabled: true, allowlist: ["local.test"] })).toEqual({
      enabled: true,
      allowlist: ["local.test"],
    });
    setHubManagedDeploymentSettings({ signupsEnabled: false, signupAllowlist: "hub.test,b.test" });
    expect(withHubSignupPolicy({ enabled: true, allowlist: ["local.test"] })).toEqual({
      enabled: false,
      allowlist: ["hub.test", "b.test"],
    });
  });

  it("is frozen so callers cannot widen it in place", () => {
    setHubManagedDeploymentSettings({ signupsEnabled: false });
    expect(Object.isFrozen(hubManagedDeploymentSettings())).toBe(true);
  });
});
