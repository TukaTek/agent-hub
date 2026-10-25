import { expect, it } from "vitest";
import { redirectSystemPath } from "../app/+native-intent";

it.each([
  "cortexai-agent-hub://hub-sso?code=secret-code&state=secret-state",
  "cortexai-agent-hub:///hub-sso?error=sso_failed&state=secret-state",
  "/hub-sso?code=secret-code&state=secret-state",
  "hub-sso",
])("routes the Hub SSO handoff %s to sign-in without its query", (path) => {
  expect(redirectSystemPath({ path, initial: false })).toBe("/sign-in");
});

it("leaves other links alone", () => {
  expect(redirectSystemPath({ path: "cortexai-agent-hub://sign-in?cookie=x", initial: true })).toBe(
    "cortexai-agent-hub://sign-in?cookie=x",
  );
  expect(redirectSystemPath({ path: "/hub-sso-other", initial: false })).toBe("/hub-sso-other");
});
