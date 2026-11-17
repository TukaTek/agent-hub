import { createHash } from "node:crypto";
import { MCP_SIGNIN_WINDOW_PREFIX } from "@cortexai-agent-hub/contracts";

const OAUTH_POPUP_NAMES = new Set([
  "cortexai-agent-hub-app-connect",
  "cortexai-agent-hub-mcp-oauth",
  "cortexai-agent-hub-sso-oauth",
  "cortexai-agent-hub-model-oauth",
  "cortexai-agent-hub-plugin-connect",
]);

/** A server id from a per-server MCP sign-in window name; null otherwise. */
export function mcpOAuthPopupServerId(frameName: string): string | null {
  if (!frameName.startsWith(MCP_SIGNIN_WINDOW_PREFIX)) return null;
  const serverId = frameName.slice(MCP_SIGNIN_WINDOW_PREFIX.length);
  return isMcpOAuthServerId(serverId) ? serverId : null;
}

export function isMcpOAuthServerId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

/** One persistent cookie jar per connected instance and server. */
export function mcpOAuthPartition(appUrl: string, serverId: string) {
  const digest = createHash("sha256")
    .update(JSON.stringify([new URL(appUrl).origin, serverId]))
    .digest("hex")
    .slice(0, 24);
  return `persist:cortexai-agent-hub-mcp-${digest}`;
}

export function shouldOpenInAppPopup(
  appOrigin: string | null,
  childUrl: string,
  frameName: string,
) {
  let target: URL;
  try {
    target = new URL(childUrl);
  } catch {
    return false;
  }

  if (childUrl === "about:blank" && frameName === "cortexai-agent-hub-sso-oauth") return true;

  const isHttp = target.protocol === "http:" || target.protocol === "https:";
  if (appOrigin !== null && target.origin === appOrigin) return isHttp;
  return (
    target.protocol === "https:" &&
    (OAUTH_POPUP_NAMES.has(frameName) ||
      (frameName.startsWith("cortexai-agent-hub-mcp-oauth:") &&
        frameName.length > "cortexai-agent-hub-mcp-oauth:".length) ||
      mcpOAuthPopupServerId(frameName) !== null)
  );
}

/** Keep auth cookies in the parent app's server-specific session. */
export function oauthPopupSessionPreferences(partition: string | null) {
  return {
    preload: "",
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    ...(partition === null ? {} : { partition }),
  };
}
