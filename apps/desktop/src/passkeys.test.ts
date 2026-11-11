import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { associatedPasskeyRpIds, PASSKEY_RP_ID, passkeyEntitlements } from "./passkeys.js";
import { CORTEXAI_AGENT_HUB_CLOUD_URL } from "./setup-config.js";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  build: { appId: string; mac: { entitlements: string; entitlementsInherit: string } };
};
const base = readFileSync(path.join(root, pkg.build.mac.entitlements), "utf8");

describe("associatedPasskeyRpIds", () => {
  const resourcesPath = "/Applications/CortexAI Agent Hub.app/Contents/Resources";
  const profile = "/Applications/CortexAI Agent Hub.app/Contents/embedded.provisionprofile";

  it("has no hosted relying party, so no build is associated with one", () => {
    expect(CORTEXAI_AGENT_HUB_CLOUD_URL).toBeNull();
    expect(PASSKEY_RP_ID).toBeNull();
    expect(
      associatedPasskeyRpIds({
        platform: "darwin",
        packaged: true,
        resourcesPath,
        exists: (file) => file === profile,
      }),
    ).toEqual([]);
  });
});

describe("passkeyEntitlements", () => {
  it("leaves the base entitlements alone without a hosted relying party", () => {
    expect(passkeyEntitlements(base, "ABCDE12345", pkg.build.appId)).toBe(base);
  });

  it("marks a development build that fetches the association itself in developer mode", async () => {
    vi.stubEnv("CORTEXAI_AGENT_HUB_PASSKEY_RP_ID", "app.example.org");
    vi.resetModules();
    const passkeys = await import("./passkeys.js");
    const plist = passkeys.passkeyEntitlements(base, "ABCDE12345", pkg.build.appId, {
      developerMode: true,
    });
    vi.unstubAllEnvs();
    expect(plist).toContain("<string>webcredentials:app.example.org?mode=developer</string>");
    expect(plist).toContain("<key>com.apple.security.get-task-allow</key>\n    <true/>\n  </dict>");
    expect(passkeys.passkeyEntitlements(base, "ABCDE12345", pkg.build.appId)).not.toContain(
      "get-task-allow",
    );
  });

  it("keeps helpers on the base entitlements", () => {
    expect(pkg.build.mac.entitlementsInherit).toBe(pkg.build.mac.entitlements);
    expect(base).not.toContain("associated-domains");
    expect(base).not.toContain("application-identifier");
  });

  it("rejects a malformed team or bundle identifier", () => {
    expect(() => passkeyEntitlements(base, "", pkg.build.appId)).toThrow();
    expect(() => passkeyEntitlements(base, "abcde12345", pkg.build.appId)).toThrow();
    expect(() => passkeyEntitlements(base, "ABCDE12345</string>", pkg.build.appId)).toThrow();
    expect(() => passkeyEntitlements(base, "ABCDE12345", "dev cortexai-agent-hub")).toThrow();
  });
});

describe("self-hosted passkey domain", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load(rpId: string) {
    vi.stubEnv("CORTEXAI_AGENT_HUB_PASSKEY_RP_ID", rpId);
    vi.resetModules();
    return import("./passkeys.js");
  }

  it("has no domain by default, since there is no hosted server", async () => {
    const passkeys = await load("");
    expect(passkeys.PASSKEY_RP_ID).toBeNull();
  });

  it("associates the build with CORTEXAI_AGENT_HUB_PASSKEY_RP_ID", async () => {
    const passkeys = await load(" CortexAI-Agent-Hub.Example.org ");
    expect(passkeys.PASSKEY_RP_ID).toBe("cortexai-agent-hub.example.org");
    expect(passkeys.passkeyEntitlements(base, "ABCDE12345", pkg.build.appId)).toContain(
      "<string>webcredentials:cortexai-agent-hub.example.org</string>",
    );
  });

  it.each([
    "https://cortexai-agent-hub.example.org",
    "localhost",
    "192.168.1.20",
    "cortexai-agent-hub.example.org:8443",
  ])("refuses to sign entitlements for %s", async (rpId) => {
    const passkeys = await load(rpId);
    expect(() => passkeys.passkeyEntitlements(base, "ABCDE12345", pkg.build.appId)).toThrow(
      "CORTEXAI_AGENT_HUB_PASSKEY_RP_ID",
    );
  });
});
