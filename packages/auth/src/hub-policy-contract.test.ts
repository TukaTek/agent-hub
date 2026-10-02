import { describe, expect, it } from "vitest";
import fixture from "./fixtures/agent-hub-service-config.v1.json" with { type: "json" };
import {
  HUB_ASSIGNMENTS_CONTRACT,
  HUB_POLICY_PRODUCT,
  HubPolicyError,
  parseHubPolicy,
} from "./hub-policy-contract.js";

const TENANT = "tenant-a";
const clone = <T>(value: T): T => structuredClone(value);
const reject = (raw: unknown, tenant = TENANT) => {
  try {
    parseHubPolicy(raw, tenant);
  } catch (error) {
    expect(error).toBeInstanceOf(HubPolicyError);
    return error as HubPolicyError;
  }
  throw new Error("expected the config to be rejected");
};

describe("Hub service-config contract (agent-hub-settings-v1)", () => {
  it("accepts Hub's empty snapshot as no overrides with unknown toolkits and assignments", () => {
    const policy = parseHubPolicy(fixture.cases.empty, TENANT);
    expect(policy).toMatchObject({ tenantId: TENANT, revision: 0, overrides: {} });
    expect(policy.toolkits).toEqual({ status: "unknown", allowed: [] });
    // CAH-204: an empty assignment list is "unknown", never "nobody has access".
    expect(policy.assignments).toEqual({ status: "unknown", subjects: [] });
  });

  it("accepts the minimal documented envelope", () => {
    const policy = parseHubPolicy(fixture.cases.minimal, TENANT);
    expect(policy.toolkits.status).toBe("unknown");
    expect(policy.assignments.status).toBe("unknown");
  });

  it("flattens overrides to Hub paths and intersects toolkits with tenant enablement", () => {
    const policy = parseHubPolicy(fixture.cases.configured, TENANT);
    expect(policy.revision).toBe(7);
    expect(policy.overrides).toMatchObject({
      "signup.enabled": false,
      "signup.allowlist": ["example.test"],
      "model.defaultProvider": "anthropic",
      "model.credentials.anthropic": "hub-model-secret-not-real",
      "computer.idleMs": 120000,
      "mcp.stdioAllowedCommands": [],
    });
    expect(policy.toolkits).toEqual({ status: "configured", allowed: ["github"] });
    expect(policy.assignments).toEqual({
      status: "configured",
      subjects: ["subject-1", "subject-2"],
    });
  });

  it("treats pre-CAH-204 raw assignment rows as unknown rather than as access", () => {
    const policy = parseHubPolicy(fixture.cases["raw-assignment-rows"], TENANT);
    expect(policy.assignments).toEqual({ status: "unknown", subjects: [] });
  });

  it("treats configured-empty toolkit access as configured with no toolkits", () => {
    const raw = clone(fixture.cases.configured);
    raw.composio.productAccess = { status: "configured-empty", revision: 4, allowedToolkitIds: [] };
    expect(parseHubPolicy(raw, TENANT).toolkits).toEqual({ status: "configured", allowed: [] });
  });

  it.each([
    [
      "schema version",
      (raw: any) => (raw.schemaVersion = "agent-hub-settings-v2"),
      "schema_version",
    ],
    ["audience (product)", (raw: any) => (raw.product = "cortexai-other"), "audience"],
    ["missing tenant", (raw: any) => delete raw.tenantId, "tenant"],
    ["negative revision", (raw: any) => (raw.revision = -1), "revision"],
    ["fractional revision", (raw: any) => (raw.revision = 1.5), "revision"],
    ["unknown top-level field", (raw: any) => (raw.lockUserSets = true), "unknown_field"],
    ["unknown setting path", (raw: any) => (raw.overrides.model.unlimited = true), "setting"],
    ["wrong setting type", (raw: any) => (raw.overrides.signup.enabled = "yes"), "setting"],
    [
      "select outside its options",
      (raw: any) => (raw.overrides.computer.provider = "any"),
      "setting",
    ],
    ["number under its minimum", (raw: any) => (raw.overrides.computer.idleMs = 10), "setting"],
    [
      "encrypted storage value",
      (raw: any) => (raw.overrides.model.defaultModel = "enc:v1:abc"),
      "setting",
    ],
    [
      "URL with credentials",
      (raw: any) => (raw.overrides.computer.box = { apiUrl: "https://u:p@box.example.test" }),
      "setting",
    ],
    ["half an auto-review pair", (raw: any) => delete raw.overrides.autoReview.model, "setting"],
    [
      "unknown toolkit status",
      (raw: any) => (raw.composio.productAccess.status = "all"),
      "toolkits",
    ],
    [
      "non-string toolkit id",
      (raw: any) => (raw.composio.productAccess.allowedToolkitIds = [1]),
      "toolkits",
    ],
    [
      "malformed assignments",
      (raw: any) => (raw.access.productAssignments = "everyone"),
      "assignments",
    ],
  ])("rejects %s as HUB_CONFIG_INVALID", (_name, mutate, reason) => {
    const raw = clone(fixture.cases.configured);
    mutate(raw);
    const error = reject(raw);
    expect(error.code).toBe("HUB_CONFIG_INVALID");
    expect(error.reason).toContain(reason);
  });

  it.each([
    ["a string", "nope"],
    ["an array", []],
    ["null", null],
  ])("rejects %s as the document", (_name, raw) => {
    expect(reject(raw).reason).toBe("document");
  });

  it("rejects a document for another tenant", () => {
    const error = reject(fixture.cases.configured, "tenant-b");
    expect(error.code).toBe("HUB_CONFIG_INVALID");
    expect(error.reason).toBe("tenant_mismatch");
  });

  it("rejects assignment rows that belong to another tenant", () => {
    const raw = clone(fixture.cases["raw-assignment-rows"]);
    raw.access.productAssignments[0]!.tenantId = "tenant-b";
    expect(reject(raw).reason).toBe("tenant_mismatch");
  });

  it.each([
    ["branding", { branding: { appName: "Other" } }],
    ["supported surfaces", { surfaces: { mobile: false } }],
    ["budget and rate", { budget: { monthlyUsd: 0 } }],
  ])("rejects %s overrides Hub does not manage instead of applying them", (_name, extra) => {
    const raw: any = clone(fixture.cases.configured);
    Object.assign(raw.overrides, extra);
    expect(reject(raw).code).toBe("HUB_CONFIG_INVALID");
  });

  it("never puts a setting value into an error reason", () => {
    const raw: any = clone(fixture.cases.configured);
    raw.overrides.model.credentials.anthropic = 42;
    const error = reject(raw);
    expect(`${error.message} ${error.reason}`).not.toContain("42");
    expect(`${error.message} ${error.reason}`).not.toContain("hub-model-secret");
  });
});

describe("Agent Hub assignment contract marker (agent-hub-assignments.v1, CAH-204)", () => {
  const row = (tenantUserId: string, role = "user") => ({
    tenantUserId,
    productId: HUB_POLICY_PRODUCT,
    role,
  });
  const withAccess = (access: Record<string, unknown>) => {
    const raw: any = clone(fixture.cases.configured);
    raw.access = access;
    return raw;
  };
  const marked = (productAssignments: unknown[], extra: Record<string, unknown> = {}) =>
    withAccess({
      status: "configured",
      contract: HUB_ASSIGNMENTS_CONTRACT,
      productAssignments,
      ...extra,
    });

  it("names the agreed contract", () => {
    expect(HUB_ASSIGNMENTS_CONTRACT).toBe("agent-hub-assignments.v1");
  });

  it("reads an empty list under the marker as nobody assigned, not as pending", () => {
    expect(parseHubPolicy(marked([]), TENANT).assignments).toEqual({
      status: "configured",
      subjects: [],
    });
  });

  it("admits only the users listed under the marker", () => {
    const policy = parseHubPolicy(fixture.cases["assignments-contract"], TENANT);
    expect(policy.assignments).toEqual({
      status: "configured",
      subjects: ["subject-1", "subject-3"],
    });
  });

  it("parses rows with exactly tenantUserId, productId and role", () => {
    const rows = [row("subject-1"), row("subject-2", "admin")];
    for (const entry of rows)
      expect(Object.keys(entry).sort()).toEqual(["productId", "role", "tenantUserId"]);
    for (const raw of [
      marked(rows),
      withAccess({ status: "configured", productAssignments: rows }),
    ])
      expect(parseHubPolicy(raw, TENANT).assignments).toEqual({
        status: "configured",
        subjects: ["subject-1", "subject-2"],
      });
  });

  it("keeps the CAH-204 guard for an empty list without the marker", () => {
    const raw = withAccess({ status: "configured", productAssignments: [] });
    expect(parseHubPolicy(raw, TENANT).assignments).toEqual({ status: "unknown", subjects: [] });
  });

  it("keeps the CAH-204 guard when the marker arrives with a status other than configured", () => {
    const raw = marked([], { status: "pending" });
    expect(parseHubPolicy(raw, TENANT).assignments).toEqual({ status: "unknown", subjects: [] });
  });

  it.each([
    ["a newer version", "agent-hub-assignments.v2"],
    ["an empty string", ""],
    ["null", null],
    ["a number", 1],
    ["an object", { name: HUB_ASSIGNMENTS_CONTRACT }],
  ])("rejects a contract marker that is %s, even when it would grant access", (_name, contract) => {
    for (const rows of [[], [row("subject-1")]]) {
      const error = reject(marked(rows, { contract }));
      expect(error.code).toBe("HUB_CONFIG_INVALID");
      expect(error.reason).toBe("assignments_contract");
    }
  });

  it("still rejects marked rows that belong to another tenant", () => {
    expect(reject(marked([{ ...row("subject-1"), tenantId: "tenant-b" }])).reason).toBe(
      "tenant_mismatch",
    );
  });
});
