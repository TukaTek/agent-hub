import { describe, expect, it } from "vitest";
import fixture from "./fixtures/agent-hub-service-config.v1.json" with { type: "json" };
import hubSample from "./fixtures/hub-agent-hub-service-config.v1.sample.json" with {
  type: "json",
};
import { HUB_MANAGED_SETTINGS, parseHubPolicy } from "./hub-policy-contract.js";
import { hubDeploymentSettings, overlayHubEnv } from "./hub-policy-overlay.js";

const configured = parseHubPolicy(fixture.cases.configured, "tenant-a");
const withOverrides = (overrides: Record<string, unknown>) =>
  parseHubPolicy({ ...fixture.cases.minimal, revision: 9, overrides }, "tenant-a");

describe("Hub precedence over local environment and deployment settings", () => {
  it.each([
    ["provider", "PI_DEFAULT_PROVIDER", "openrouter", "anthropic"],
    ["provider", "SANDBOX_PROVIDER", "docker", "e2b"],
    ["provider", "CLOUD_AGENT_PROVIDER", "cursor", "none"],
    ["model and funding", "PI_DEFAULT_MODEL", "local/model", "claude-sonnet-5"],
    ["model and funding", "ANTHROPIC_API_KEY", "local-model-secret", "hub-model-secret-not-real"],
    [
      "toolkit and tools",
      "COMPOSIO_API_KEY",
      "local-composio-secret",
      "hub-composio-secret-not-real",
    ],
    ["toolkit and tools", "MCP_STDIO_ENABLED", "true", "false"],
    ["toolkit and tools", "MCP_STDIO_ALLOWED_COMMANDS", "npx,uvx", ""],
    ["features", "CORTEXAI_AGENT_HUB_AUTO_REVIEW", "false", "true"],
    ["features", "MESSAGING_OPEN_SIGNUP", "true", "false"],
    ["features", "SANDBOX_IDLE_MS", "600000", "120000"],
    ["connections", "E2B_API_KEY", "local-computer-secret", "hub-computer-secret-not-real"],
  ])("%s: Hub replaces a conflicting %s", (_category, name, local, hub) => {
    const { env, signals } = overlayHubEnv({ [name]: local }, configured);
    expect(env[name]).toBe(hub);
    expect(signals).toContainEqual({
      event: "hub_policy_override",
      key: expect.any(String),
      hubRevision: 7,
      overriddenSource: `env:${name}`,
    });
  });

  it.each([
    ["budget and rate", "GRAPHILE_WORKER_CONCURRENCY", "4"],
    ["branding", "WEB_ORIGIN", "https://agents.example.test"],
    ["unmanaged connection", "DAYTONA_API_KEY", "local-daytona-secret"],
    ["bootstrap", "DATABASE_URL", "postgres://local"],
  ])("%s: a setting Hub does not manage keeps its local value", (_category, name, local) => {
    const { env, signals } = overlayHubEnv({ [name]: local }, configured);
    expect(env[name]).toBe(local);
    expect(signals.some((signal) => signal.overriddenSource === `env:${name}`)).toBe(false);
  });

  it("supplies a Hub value with no local input without reporting an override", () => {
    const { env, signals } = overlayHubEnv({}, configured);
    expect(env.PI_DEFAULT_PROVIDER).toBe("anthropic");
    expect(signals).toEqual([]);
  });

  it("does not report an override when the local value already matches", () => {
    expect(overlayHubEnv({ PI_DEFAULT_PROVIDER: "anthropic" }, configured).signals).toEqual([]);
  });

  it("drops a local model that belongs to the provider Hub replaced", () => {
    const policy = withOverrides({ model: { defaultProvider: "anthropic" } });
    const { env, signals } = overlayHubEnv(
      { PI_DEFAULT_PROVIDER: "openrouter", PI_DEFAULT_MODEL: "openrouter/model" },
      policy,
    );
    expect(env.PI_DEFAULT_PROVIDER).toBe("anthropic");
    expect(env.PI_DEFAULT_MODEL).toBeUndefined();
    expect(signals.map((signal) => signal.overriddenSource)).toEqual([
      "env:PI_DEFAULT_PROVIDER",
      "env:PI_DEFAULT_MODEL",
    ]);
  });

  it("clears an alias so a local fallback cannot win over Hub", () => {
    const policy = withOverrides({ computer: { box: { apiUrl: "https://box.example.test" } } });
    const { env, signals } = overlayHubEnv({ BOX_BASE_URL: "https://local.example.test" }, policy);
    expect(env.BOX_API_URL).toBe("https://box.example.test");
    expect(env.BOX_BASE_URL).toBeUndefined();
    expect(signals).toEqual([
      {
        event: "hub_policy_override",
        key: "computer.box.apiUrl",
        hubRevision: 9,
        overriddenSource: "env:BOX_BASE_URL",
      },
    ]);
  });

  it("leaves the input environment untouched", () => {
    const local = { PI_DEFAULT_PROVIDER: "openrouter" };
    overlayHubEnv(local, configured);
    expect(local).toEqual({ PI_DEFAULT_PROVIDER: "openrouter" });
  });

  it("never logs a local or Hub value in a signal", () => {
    const { signals } = overlayHubEnv(
      { ANTHROPIC_API_KEY: "local-model-secret", COMPOSIO_API_KEY: "local-composio-secret" },
      configured,
    );
    const text = JSON.stringify(signals);
    expect(signals).toHaveLength(2);
    for (const value of [
      "local-model-secret",
      "local-composio-secret",
      "hub-model-secret",
      "hub-composio-secret",
    ])
      expect(text).not.toContain(value);
  });

  it("an empty Hub snapshot changes nothing", () => {
    const empty = parseHubPolicy(fixture.cases.empty, "tenant-a");
    const local = { PI_DEFAULT_PROVIDER: "openrouter", SANDBOX_PROVIDER: "docker" };
    expect(overlayHubEnv(local, empty)).toEqual({ env: local, signals: [] });
  });
});

describe("Hub precedence over persisted deployment settings", () => {
  const row = {
    defaultModelProvider: "openrouter",
    defaultModelId: "openrouter/model",
    signupsEnabled: true,
    signupAllowlist: "",
  };

  it("overrides each persisted field Hub manages and reports the source", () => {
    const { managed, signals } = hubDeploymentSettings(configured, row);
    expect(managed).toEqual({
      defaultModelProvider: "anthropic",
      defaultModelId: "claude-sonnet-5",
    });
    expect(signals.map((signal) => signal.overriddenSource).sort()).toEqual([
      "deployment_settings.defaultModelId",
      "deployment_settings.defaultModelProvider",
    ]);
  });

  it("clears a persisted model when Hub manages only the provider", () => {
    const policy = withOverrides({ model: { defaultProvider: "anthropic" } });
    expect(hubDeploymentSettings(policy, row).managed).toEqual({
      defaultModelProvider: "anthropic",
      defaultModelId: null,
    });
  });

  it("manages nothing for an empty snapshot", () => {
    const empty = parseHubPolicy(fixture.cases.empty, "tenant-a");
    expect(hubDeploymentSettings(empty, row)).toEqual({ managed: {}, signals: [] });
  });
});

describe("Hub's signup settings are accepted but inert (CAAH-43)", () => {
  // Hub's published sample still sends signup.enabled=true and an allowlist.
  const sample = parseHubPolicy(structuredClone(hubSample), hubSample.tenantId);
  const signupPaths = ["signup.enabled", "signup.allowlist"];

  it("still parses Hub's signup values, so Hub documents stay valid", () => {
    expect(hubSample.overrides.signup.enabled).toBe(true);
    expect(hubSample.overrides.signup.allowlist.length).toBeGreaterThan(0);
    expect(sample.overrides["signup.enabled"]).toBe(true);
    expect(sample.overrides["signup.allowlist"]).toEqual(hubSample.overrides.signup.allowlist);
  });

  it("maps them to no environment input and no deployment field", () => {
    for (const path of signupPaths) {
      const setting = HUB_MANAGED_SETTINGS.find((entry) => entry.path === path);
      expect(setting, path).toMatchObject({ inert: true, env: [] });
      expect(setting?.deploymentField, path).toBeUndefined();
    }
  });

  it("never writes SIGNUPS_ENABLED or SIGNUP_ALLOWLIST and reports no signup override", () => {
    const { env, signals } = overlayHubEnv({}, sample);
    expect(env).not.toHaveProperty("SIGNUPS_ENABLED");
    expect(env).not.toHaveProperty("SIGNUP_ALLOWLIST");
    expect(signals.filter((signal) => signupPaths.includes(signal.key))).toEqual([]);
  });

  it("puts no signup value in the Hub-managed deployment settings", () => {
    // A stored row still has the legacy signup columns.
    const legacyRow = { defaultModelProvider: null, signupsEnabled: false, signupAllowlist: "" };
    const { managed, signals } = hubDeploymentSettings(sample, legacyRow);
    expect(managed).not.toHaveProperty("signupsEnabled");
    expect(managed).not.toHaveProperty("signupAllowlist");
    expect(signals.filter((signal) => signupPaths.includes(signal.key))).toEqual([]);
  });
});
