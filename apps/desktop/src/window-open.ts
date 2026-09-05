const OAUTH_POPUP_NAMES = new Set([
  "cortexai-agent-hub-app-connect",
  "cortexai-agent-hub-mcp-oauth",
  "cortexai-agent-hub-model-oauth",
  "cortexai-agent-hub-plugin-connect",
]);

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

  const isHttp = target.protocol === "http:" || target.protocol === "https:";
  if (appOrigin !== null && target.origin === appOrigin) return isHttp;
  return target.protocol === "https:" && OAUTH_POPUP_NAMES.has(frameName);
}
