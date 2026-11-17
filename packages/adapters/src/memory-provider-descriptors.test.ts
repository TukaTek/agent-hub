import type {
  MemoryProviderDescriptor,
  ProviderSettingsField,
} from "@cortexai-agent-hub/contracts";
import { MemoryProviderDescriptorSchema } from "@cortexai-agent-hub/contracts";
import {
  initialSettingsValues,
  keepsSavedSecrets,
  settingsFormReady,
  settingsSubmission,
  visibleSettingsFields,
} from "@cortexai-agent-hub/core";
import { describe, expect, it } from "vitest";
import {
  assertMemoryProviderSettings,
  keptMemoryProviderSettings,
  memoryProviderConnectionLabel,
  memoryProviderDescriptors,
} from "./memory-provider-factory.js";

const descriptors = memoryProviderDescriptors();

function descriptor(id: string): MemoryProviderDescriptor {
  const found = descriptors.find((entry) => entry.id === id);
  if (!found) throw new Error(`No descriptor for ${id}`);
  return found;
}

/** The form a client draws from a descriptor, as far as its rules go. */
function form(id: string, saved?: Record<string, string>) {
  const { fields } = descriptor(id);
  const values = initialSettingsValues(fields, saved);
  const shown = (key: string): ProviderSettingsField | undefined =>
    visibleSettingsFields(fields, values).find((field) => field.key === key);
  return {
    values,
    fill(changes: Record<string, string>) {
      Object.assign(values, changes);
      return this;
    },
    shown,
    ready: () => settingsFormReady(fields, values, saved),
    keepsSecrets: () => keepsSavedSecrets(fields, values, saved),
    sends: () => settingsSubmission(fields, values),
  };
}

describe("memory provider descriptors", () => {
  it("lists the providers in the order a Space picks from", () => {
    expect(descriptors.map((entry) => entry.id)).toEqual(["supermemory", "serenity", "hindsight"]);
    expect(descriptors.map((entry) => entry.displayName)).toEqual([
      "Supermemory",
      "Serenity",
      "Hindsight",
    ]);
  });

  it.each(descriptors)("$id sends only public, well-formed metadata", (entry) => {
    expect(MemoryProviderDescriptorSchema.strict().safeParse(entry).success).toBe(true);
    for (const field of entry.fields) {
      const controller = field.visibleWhen
        ? entry.fields.find((candidate) => candidate.key === field.visibleWhen?.key)
        : undefined;
      if (field.visibleWhen) {
        expect(controller, field.key).toBeDefined();
        expect(controller?.visibleWhen, field.key).toBeUndefined();
      }
      if (field.visibleWhen?.equals !== undefined) {
        expect(controller?.options?.map((option) => option.value)).toContain(
          field.visibleWhen.equals,
        );
      }
      if (field.kind === "select") {
        expect(field.options?.map((option) => option.value)).toContain(field.default);
      }
      if (field.kind === "toggle") expect(["true", "false"]).toContain(field.default);
      if (field.kind === "secret") {
        expect(field.minLength).toBe(8);
        expect(field.scopesSecrets).toBeUndefined();
      }
      for (const check of field.checks ?? []) expect(() => new RegExp(check.pattern)).not.toThrow();
    }
    // Fields that share a key are variants: exactly one shows, whatever the other one holds.
    const repeated = entry.fields.filter(
      (field) => entry.fields.filter((other) => other.key === field.key).length > 1,
    );
    for (const field of repeated) {
      const variants = repeated.filter((other) => other.key === field.key);
      expect(new Set(variants.map((variant) => variant.visibleWhen?.key)).size).toBe(1);
      const equals = variants.map((variant) => variant.visibleWhen?.equals);
      expect(equals).not.toContain(undefined);
      expect(new Set(equals).size).toBe(variants.length);
    }
    // Every saved connection has something to say beside "Connected".
    expect(memoryProviderConnectionLabel(entry.id, {})).toEqual(expect.any(String));
  });

  it("names a saved connection", () => {
    const label = memoryProviderConnectionLabel;
    expect(label("supermemory", { mode: "cloud", baseUrl: "https://api.example.test" })).toBe(
      "Supermemory Cloud",
    );
    expect(label("supermemory", { mode: "local", baseUrl: "http://10.0.0.8:6767" })).toBe(
      "Self-hosted (http://10.0.0.8:6767)",
    );
    expect(label("serenity", { endpoint: "https://memory.example.test/mcp" })).toBe(
      "https://memory.example.test/mcp, recall only",
    );
    expect(
      label("serenity", {
        endpoint: "https://memory.example.test/mcp",
        brainLabel: " personal ",
        allowWrites: "true",
      }),
    ).toBe("personal, read/write");
    expect(label("hindsight", { recallBanks: "notes" })).toBe("Hindsight Cloud");
    expect(label("hindsight", { mode: "local", baseUrl: "http://10.0.0.8:8888" })).toBe(
      "Self-hosted (http://10.0.0.8:8888)",
    );
    expect(label("not-in-this-build", {})).toBeUndefined();
  });

  it("asks one provider for a key named after where it connects", () => {
    const connecting = form("supermemory");
    expect(connecting.shown("apiKey")).toMatchObject({
      label: "Organization API key",
      placeholder: "sm_…",
    });
    expect(connecting.shown("baseUrl")).toBeUndefined();
    expect(connecting.ready()).toBe(false);
    expect(connecting.fill({ apiKey: "short" }).ready()).toBe(false);
    expect(connecting.fill({ apiKey: " sm_test_key_12345 " }).ready()).toBe(true);
    expect(connecting.sends()).toEqual({
      settings: { mode: "cloud" },
      credentials: { apiKey: "sm_test_key_12345" },
    });

    connecting.fill({ mode: "local" });
    expect(connecting.shown("apiKey")).toMatchObject({ label: "Instance API key" });
    expect(connecting.shown("baseUrl")).toMatchObject({
      label: "Base URL",
      placeholder: "https://…",
    });
    expect(connecting.ready()).toBe(false);
    expect(connecting.fill({ baseUrl: " http://10.0.0.8:6767 " }).sends()).toEqual({
      settings: { mode: "local", baseUrl: "http://10.0.0.8:6767" },
      credentials: { apiKey: "sm_test_key_12345" },
    });
    expect(connecting.ready()).toBe(true);
  });

  it("keeps that provider's stored key only while the host is unchanged", () => {
    // A cloud connection stores the cloud URL, which is not the self-hosted address to edit.
    const cloud = form("supermemory", { mode: "cloud", baseUrl: "https://api.example.test" });
    expect(cloud.values.baseUrl).toBe("");
    expect(cloud.keepsSecrets()).toBe(true);
    expect(cloud.ready()).toBe(true);
    expect(cloud.sends()).toEqual({ settings: { mode: "cloud" }, credentials: {} });
    cloud.fill({ mode: "local", baseUrl: "http://10.0.0.8:6767" });
    expect(cloud.keepsSecrets()).toBe(false);
    expect(cloud.ready()).toBe(false);

    const local = form("supermemory", { mode: "local", baseUrl: "http://10.0.0.8:6767" });
    expect(local.values.baseUrl).toBe("http://10.0.0.8:6767");
    expect(local.fill({ baseUrl: "http://10.0.0.8:6767/" }).keepsSecrets()).toBe(true);
    expect(local.fill({ baseUrl: "http://10.0.0.9:6767" }).keepsSecrets()).toBe(false);
  });

  it("requires an explicit endpoint and leaves URL validity to the connection", () => {
    const connecting = form("serenity");
    expect(connecting.shown("endpoint")).toMatchObject({
      label: "MCP endpoint",
      placeholder: "https://serenity.sire.run/mcp",
      requiredMessage: "Serenity endpoint is required.",
    });
    expect(connecting.shown("token")).toMatchObject({
      label: "Bearer token",
      placeholder: "sk_live_…",
    });
    // The missing endpoint is said on submit; only the token holds the button.
    expect(connecting.ready()).toBe(false);
    expect(connecting.fill({ token: "serenity_token" }).ready()).toBe(true);
    expect(() => assertMemoryProviderSettings("serenity", connecting.sends().settings)).toThrow(
      "Serenity endpoint is required.",
    );
    expect(() => assertMemoryProviderSettings("serenity", { endpoint: "   " })).toThrow(
      "Serenity endpoint is required.",
    );
    for (const endpoint of [
      "not a url",
      "ftp://memory.example.test/mcp",
      "https://user:pass@memory.example.test/mcp",
      "https://memory.example.test/mcp?x=1",
    ]) {
      expect(() => assertMemoryProviderSettings("serenity", { endpoint })).not.toThrow();
    }
    expect(connecting.fill({ endpoint: "not a url" }).sends()).toEqual({
      settings: { endpoint: "not a url", allowWrites: "false" },
      credentials: { token: "serenity_token" },
    });
    connecting.fill({
      endpoint: " https://memory.example.test/mcp ",
      token: " sk_live_example ",
      brainLabel: " personal ",
      allowWrites: "true",
    });
    expect(connecting.sends()).toEqual({
      settings: {
        endpoint: "https://memory.example.test/mcp",
        allowWrites: "true",
        brainLabel: "personal",
      },
      credentials: { token: "sk_live_example" },
    });
  });

  it("keeps a stored token only while the endpoint is unchanged", () => {
    const editing = form("serenity", {
      endpoint: "https://memory.example.test/mcp",
      endpointTrust: "private",
      allowWrites: "true",
      brainLabel: "personal",
    });
    expect(editing.values).toEqual({
      endpoint: "https://memory.example.test/mcp",
      brainLabel: "personal",
      allowWrites: "true",
    });
    expect(editing.fill({ brainLabel: "work", allowWrites: "false" }).keepsSecrets()).toBe(true);
    expect(editing.ready()).toBe(true);
    // What the server classified is its own to decide again, so it is not sent back.
    expect(editing.sends()).toEqual({
      settings: {
        endpoint: "https://memory.example.test/mcp",
        brainLabel: "work",
        allowWrites: "false",
      },
      credentials: {},
    });
    expect(editing.fill({ endpoint: "https://other.example.test/mcp" }).ready()).toBe(false);
  });

  it("carries no stored setting over that the provider's fields already name", () => {
    expect(keptMemoryProviderSettings("hindsight", { recallBudget: "high" })).toEqual({});
  });

  it("lets a self-hosted server run without a key, and reads its saved recall settings", () => {
    const connecting = form("hindsight");
    expect(connecting.shown("apiKey")).toMatchObject({ label: "API key", required: true });
    expect(connecting.ready()).toBe(false);
    expect(connecting.values).toMatchObject({
      mode: "cloud",
      recallBanks: "",
      retainConversations: "true",
      autoRecall: "true",
      recallBudget: "mid",
      recallFacts: "false",
      skipUnrelated: "false",
    });
    connecting.fill({ mode: "local", baseUrl: "http://10.0.0.8:8888" });
    expect(connecting.shown("apiKey")).toMatchObject({ required: false });
    expect(connecting.ready()).toBe(true);
    expect(connecting.fill({ apiKey: "short" }).ready()).toBe(false);
    connecting.fill({ apiKey: "", recallBanks: " notes, ,journal ", skipUnrelated: "true" });
    expect(connecting.sends()).toEqual({
      settings: {
        mode: "local",
        baseUrl: "http://10.0.0.8:8888",
        recallBanks: "notes,journal",
        retainConversations: "true",
        autoRecall: "true",
        recallBudget: "mid",
        recallFacts: "false",
        skipUnrelated: "true",
      },
      credentials: {},
    });

    const saved = { recallBanks: "other-app,notes", retainConversations: "false" };
    const editing = form("hindsight", saved);
    expect(editing.values).toMatchObject({
      mode: "cloud",
      recallBanks: "other-app,notes",
      retainConversations: "false",
      autoRecall: "true",
    });
    // Nothing the stored key can reach has changed, so it saves without the key.
    expect(editing.fill({ recallBanks: "notes, other-app", recallBudget: "high" }).ready()).toBe(
      true,
    );
    // Another bank is something more the key could read, so it is asked for again.
    expect(editing.fill({ recallBanks: "other-app,notes,journal" }).ready()).toBe(false);
  });

  it("refuses settings the provider's form would not send", () => {
    const check = assertMemoryProviderSettings;
    expect(() => check("not-in-this-build", {})).toThrow(/Unknown memory provider/);
    expect(() => check("supermemory", { mode: "local" })).toThrow("baseUrl is required");
    expect(() => check("supermemory", { mode: "elsewhere" })).toThrow(/mode/);
    expect(() => check("hindsight", { recallBudget: "deepest" })).toThrow(/recallBudget/);
    expect(() => check("hindsight", { autoRecall: "sometimes" })).toThrow(/autoRecall/);
    expect(() => check("hindsight", { recallBanks: "a".repeat(2049) })).toThrow(/recallBanks/);
    expect(() =>
      check("supermemory", { mode: "cloud", baseUrl: "https://api.example.test" }),
    ).not.toThrow();
  });
});
