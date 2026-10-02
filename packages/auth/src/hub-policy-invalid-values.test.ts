import { describe, expect, it } from "vitest";
import hubSample from "./fixtures/hub-agent-hub-service-config.v1.sample.json" with {
  type: "json",
};
import invalidValues from "./fixtures/hub-agent-hub-settings.v1.invalid-values.json" with {
  type: "json",
};
import { HubPolicyError, parseHubPolicy } from "./hub-policy-contract.js";

/**
 * Hub's shared bad-value fixture (F2), mirrored byte for byte from cortexai-hub #103
 * (see fixtures/README.md). Hub's save-time validation and this parser must agree: a
 * value Hub saves but Agent Hub rejects refuses every sign-in for the tenant.
 *
 * Each case is applied to a copy of Hub's published sample, which is valid:
 * - `settings[]`: `value` at the Hub setting `path` must be rejected as
 *   `HUB_CONFIG_INVALID` with reason `setting:<path>`.
 * - `toolkitIds[]`: the id in either Composio tier must be rejected with reason
 *   `toolkits:enabled` or `toolkits:allowed`.
 * - `valid.settings[]` and `valid.toolkitIds[]` must be accepted.
 */
type SettingCase = { name: string; path: string; value: unknown };
type ToolkitCase = { name: string; value: string };
const fixture = invalidValues as {
  fixtureVersion: number;
  settings: SettingCase[];
  toolkitIds: ToolkitCase[];
  valid: { settings: SettingCase[]; toolkitIds: ToolkitCase[] };
};
const tenant = hubSample.tenantId;

function withSetting(path: string, value: unknown) {
  const document: any = structuredClone(hubSample);
  const keys = path.split(".");
  let node = document.overrides;
  for (const key of keys.slice(0, -1)) {
    if (!node[key] || typeof node[key] !== "object" || Array.isArray(node[key])) node[key] = {};
    node = node[key];
  }
  node[keys.at(-1)!] = value;
  return document;
}

function withToolkit(tier: "tenantEnablement" | "productAccess", id: string) {
  const document: any = structuredClone(hubSample);
  const field = tier === "tenantEnablement" ? "enabledToolkitIds" : "allowedToolkitIds";
  document.composio.tenantEnablement.enabledToolkitIds.push(id);
  if (tier === "productAccess") document.composio.productAccess[field].push(id);
  else document.composio.productAccess.allowedToolkitIds = ["github"];
  return document;
}

function rejection(document: unknown) {
  try {
    parseHubPolicy(document, tenant);
  } catch (error) {
    expect(error).toBeInstanceOf(HubPolicyError);
    return error as HubPolicyError;
  }
  return undefined;
}

describe("Hub's shared invalid-values fixture (cortexai-hub #103)", () => {
  it("is fixture version 1 with cases in every group", () => {
    expect(fixture.fixtureVersion).toBe(1);
    expect(fixture.settings.length).toBeGreaterThan(0);
    expect(fixture.toolkitIds.length).toBeGreaterThan(0);
    expect(fixture.valid.settings.length + fixture.valid.toolkitIds.length).toBeGreaterThan(0);
    const names = [
      ...fixture.settings,
      ...fixture.toolkitIds,
      ...fixture.valid.settings,
      ...fixture.valid.toolkitIds,
    ].map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("starts from a valid base document", () => {
    expect(rejection(structuredClone(hubSample))).toBeUndefined();
  });

  it.each(fixture.settings.map((entry) => [entry.name, entry] as const))(
    "rejects the setting case %s",
    (_name, entry) => {
      const error = rejection(withSetting(entry.path, entry.value));
      expect(error?.code).toBe("HUB_CONFIG_INVALID");
      expect(error?.reason).toBe(`setting:${entry.path}`);
    },
  );

  it.each(fixture.toolkitIds.map((entry) => [entry.name, entry] as const))(
    "rejects the toolkit id case %s in both tiers",
    (_name, entry) => {
      expect(rejection(withToolkit("tenantEnablement", entry.value))?.reason).toBe(
        "toolkits:enabled",
      );
      expect(rejection(withToolkit("productAccess", entry.value))?.reason).toBe("toolkits:enabled");
      const allowedOnly: any = structuredClone(hubSample);
      allowedOnly.composio.productAccess.allowedToolkitIds = [entry.value];
      expect(rejection(allowedOnly)?.reason).toBe("toolkits:allowed");
    },
  );

  it.each(fixture.valid.settings.map((entry) => [entry.name, entry] as const))(
    "accepts the valid setting case %s",
    (_name, entry) => {
      expect(rejection(withSetting(entry.path, entry.value))).toBeUndefined();
    },
  );

  it.each(fixture.valid.toolkitIds.map((entry) => [entry.name, entry] as const))(
    "accepts the valid toolkit id case %s in both tiers",
    (_name, entry) => {
      expect(rejection(withToolkit("productAccess", entry.value))).toBeUndefined();
    },
  );
});
