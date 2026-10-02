import { describe, expect, it } from "vitest";
import { isMessagingEmail, parseAllowlist, signupsOpen } from "./signup-policy.js";

describe("signup policy (CAAH-43: closed)", () => {
  it("never opens signup, whatever the legacy SIGNUPS_ENABLED or stored value", () => {
    for (const legacy of [undefined, null, "", "true", "TRUE", "1", "false", true, false]) {
      expect(signupsOpen(legacy)).toBe(false);
    }
  });

  it("still parses a legacy stored allowlist for display-free reads", () => {
    expect(parseAllowlist("You@Example.com, @company.com,,")).toEqual([
      "you@example.com",
      "@company.com",
    ]);
    expect(parseAllowlist(undefined)).toEqual([]);
  });

  it("recognizes internal messaging addresses", () => {
    expect(isMessagingEmail(" Phone-1@Messaging.Invalid ")).toBe(true);
    expect(isMessagingEmail("person@example.test")).toBe(false);
  });
});
