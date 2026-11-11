import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
