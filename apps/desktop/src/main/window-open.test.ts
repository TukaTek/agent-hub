import { describe, expect, it } from "vitest";
import {
  mcpOAuthPartition,
  mcpOAuthPopupServerId,
  oauthPopupSessionPreferences,
  shouldOpenInAppPopup,
} from "./window-open.js";

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
    "cortexai-agent-hub-mcp-oauth:session",
    "cortexai-agent-hub-sso-oauth",
    "cortexai-agent-hub-app-connect",
    "cortexai-agent-hub-plugin-connect",
  ])("keeps the intentional %s flow in an Electron popup", (frameName) => {
    expect(
      shouldOpenInAppPopup(appOrigin, "https://provider.example.com/authorize", frameName),
    ).toBe(true);
  });

  it("rejects malformed URLs and non-HTTPS third-party targets", () => {
    expect(shouldOpenInAppPopup(appOrigin, "not a url", "cortexai-agent-hub-model-oauth")).toBe(false);
    expect(
      shouldOpenInAppPopup(appOrigin, "http://provider.example.com", "cortexai-agent-hub-model-oauth"),
    ).toBe(false);
  });
});

it("keeps a server-named MCP sign-in window in an Electron popup", () => {
  const authorize = "https://provider.example.com/authorize";
  expect(shouldOpenInAppPopup(appOrigin, authorize, "cortexai-agent-hub-mcp-signin:cabc")).toBe(true);
  expect(shouldOpenInAppPopup(appOrigin, authorize, "cortexai-agent-hub-mcp-signin:")).toBe(false);
  expect(shouldOpenInAppPopup(appOrigin, authorize, "cortexai-agent-hub-mcp-signin:../other")).toBe(false);
});

describe("MCP sign-in browsers", () => {
  it("reads the server from the window name", () => {
    expect(mcpOAuthPopupServerId("cortexai-agent-hub-mcp-signin:clx123abc")).toBe("clx123abc");
    expect(mcpOAuthPopupServerId("cortexai-agent-hub-mcp-signin:")).toBeNull();
    expect(mcpOAuthPopupServerId("cortexai-agent-hub-mcp-signin:a/b")).toBeNull();
    // Session-named windows sign in through the app's own session.
    expect(mcpOAuthPopupServerId("cortexai-agent-hub-mcp-oauth:session-1")).toBeNull();
    expect(mcpOAuthPopupServerId("_blank")).toBeNull();
  });

  it("gives every server a persistent, opaque jar of its own", () => {
    const first = mcpOAuthPartition("https://first.example.test", "clx123abc");
    expect(first).toMatch(/^persist:cortexai-agent-hub-mcp-[0-9a-f]{24}$/);
    expect(mcpOAuthPartition("https://first.example.test", "clx123abc")).toBe(first);
    expect(mcpOAuthPartition("https://first.example.test", "clx999xyz")).not.toBe(first);
    expect(mcpOAuthPartition("https://second.example.test", "clx123abc")).not.toBe(first);
    expect(mcpOAuthPartition("https://first.example.test:8443", "clx123abc")).not.toBe(first);
    expect(mcpOAuthPartition("https://first.example.test/settings", "clx123abc")).toBe(first);
    expect(first).not.toContain("clx123abc");
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
  expect(shouldOpenInAppPopup(appOrigin, "http://provider.example.com", "cortexai-agent-hub-sso-oauth")).toBe(
    false,
  );
});

it("allows only the named SSO blank popup before provider navigation", () => {
  expect(shouldOpenInAppPopup(appOrigin, "about:blank", "cortexai-agent-hub-sso-oauth")).toBe(true);
  for (const name of ["_blank", "cortexai-agent-hub-mcp-oauth", ""])
    expect(shouldOpenInAppPopup(appOrigin, "about:blank", name)).toBe(false);
  expect(shouldOpenInAppPopup(appOrigin, "about:blank#unsafe", "cortexai-agent-hub-sso-oauth")).toBe(false);
});

it("keeps session-named MCP popups restricted to HTTPS", () => {
  expect(
    shouldOpenInAppPopup(appOrigin, "http://provider.example.com", "cortexai-agent-hub-mcp-oauth:session"),
  ).toBe(false);
  expect(shouldOpenInAppPopup(appOrigin, "https://provider.example.com", "cortexai-agent-hub-mcp-oauth:")).toBe(
    false,
  );
});
