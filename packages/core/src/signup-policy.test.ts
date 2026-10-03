import { describe, expect, it } from "vitest";
import { isMessagingEmail, signupsOpen } from "./signup-policy.js";

describe("signup policy (CAAH-43: closed)", () => {
  it("never opens signup, whatever the legacy SIGNUPS_ENABLED or stored value", () => {
    for (const legacy of [undefined, null, "", "true", "TRUE", "1", "false", true, false]) {
      expect(signupsOpen(legacy)).toBe(false);
    }
  });

  it("recognizes internal messaging addresses", () => {
    expect(isMessagingEmail(" Phone-1@Messaging.Invalid ")).toBe(true);
    expect(isMessagingEmail("person@example.test")).toBe(false);
  });
});
