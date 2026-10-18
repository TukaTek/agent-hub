import { readFileSync } from "node:fs";
import path from "node:path";
import type { ConfigContext } from "expo/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import appConfig from "../app.config";

const root = path.resolve(import.meta.dirname, "..");
const { expo } = JSON.parse(readFileSync(path.join(root, "app.json"), "utf8"));
const eas = JSON.parse(readFileSync(path.join(root, "eas.json"), "utf8")) as {
  build: Record<string, { extends?: string; environment?: string; channel?: string }>;
};
const PROJECT_ID = "c5ac54e3-8365-495d-a638-51b4e0deb329";

function resolvedProfile(name: string): { environment?: string; channel?: string } {
  const { extends: parent, ...profile } = eas.build[name] ?? {};
  return parent ? { ...resolvedProfile(parent), ...profile } : profile;
}

function resolveConfig() {
  return appConfig({ config: expo } as ConfigContext);
}

afterEach(() => vi.unstubAllEnvs());

describe("EAS project link", () => {
  it("links to @tukatek/agent-hub without changing app identity", () => {
    expect(expo).toMatchObject({
      name: "CortexAI Agent Hub",
      slug: "agent-hub",
      owner: "tukatek",
      scheme: "cortexai-agent-hub",
      ios: { bundleIdentifier: "com.tukatek.cortexai.agenthub" },
      android: { package: "com.tukatek.cortexai.agenthub" },
      extra: { eas: { projectId: PROJECT_ID } },
      runtimeVersion: { policy: "appVersion" },
    });
  });

  it("serves updates from the linked project", () => {
    expect(expo.updates.url).toBe(`https://u.expo.dev/${expo.extra.eas.projectId}`);
  });

  it.each([
    ["preview", "preview", "preview"],
    ["production", "production", "production"],
    ["android-apk", "production", "production"],
  ])("builds %s against the %s EAS environment and %s channel", (name, environment, channel) => {
    expect(resolvedProfile(name)).toMatchObject({ environment, channel });
  });

  it.each(["production", "android-apk"])("requires an HTTPS API URL for %s", (profile) => {
    vi.stubEnv("EAS_BUILD_PROFILE", profile);
    vi.stubEnv("EXPO_PUBLIC_API_URL", "");
    expect(resolveConfig).toThrow(/must be set/);
    vi.stubEnv("EXPO_PUBLIC_API_URL", "http://tukatek.cortexaiagenthub.com");
    expect(resolveConfig).toThrow(/HTTPS/);
    vi.stubEnv("EXPO_PUBLIC_API_URL", "https://tukatek.cortexaiagenthub.com");
    expect(resolveConfig().slug).toBe("agent-hub");
  });
});
