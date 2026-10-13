import { describe, expect, it } from "vitest";
import { oauthPopupSessionPreferences, shouldOpenInAppPopup } from "./window-open.js";

const appOrigin = "https://cortexai-agent-hub.example.com";

describe("desktop child windows", () => {
  it("keeps same-origin app routes in Electron", () => {
    expect(shouldOpenInAppPopup(appOrigin, `${appOrigin}/mcp/oauth/callback`, "_blank")).toBe(true);
  });

  it("opens ordinary external links outside Electron", () => {
    expect(
      shouldOpenInAppPopup(appOrigin, "https://github.com/TukaTek/agent-hub/pull/395", "_blank"),
    ).toBe(false);
  });

  it.each([
    "cortexai-agent-hub-model-oauth",
    "cortexai-agent-hub-mcp-oauth",
    "cortexai-agent-hub-sso-oauth",
    "cortexai-agent-hub-app-connect",
    "cortexai-agent-hub-plugin-connect",
  ])("keeps the intentional %s flow in an Electron popup", (frameName) => {
    expect(
      shouldOpenInAppPopup(appOrigin, "https://provider.example.com/authorize", frameName),
    ).toBe(true);
  });

  it("rejects malformed URLs and non-HTTPS third-party targets", () => {
    expect(shouldOpenInAppPopup(appOrigin, "not a url", "cortexai-agent-hub-model-oauth")).toBe(
      false,
    );
    expect(
      shouldOpenInAppPopup(
        appOrigin,
        "http://provider.example.com",
        "cortexai-agent-hub-model-oauth",
      ),
    ).toBe(false);
  });
});

it("keeps SSO popups sandboxed in the parent session without a privileged preload", () => {
  expect(oauthPopupSessionPreferences("persist:test-server")).toEqual({
    partition: "persist:test-server",
    preload: "",
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  });
  expect(oauthPopupSessionPreferences(null)).not.toHaveProperty("partition");
  expect(
    shouldOpenInAppPopup(appOrigin, "http://provider.example.com", "cortexai-agent-hub-sso-oauth"),
  ).toBe(false);
});

it("allows only the named SSO blank popup before provider navigation", () => {
  expect(shouldOpenInAppPopup(appOrigin, "about:blank", "cortexai-agent-hub-sso-oauth")).toBe(true);
  for (const name of ["_blank", "cortexai-agent-hub-mcp-oauth", ""])
    expect(shouldOpenInAppPopup(appOrigin, "about:blank", name)).toBe(false);
  expect(
    shouldOpenInAppPopup(appOrigin, "about:blank#unsafe", "cortexai-agent-hub-sso-oauth"),
  ).toBe(false);
});
