// Hosted integration Connect Links are excluded: provider sign-in pages can fail
// to render in Electron, and the app polls their completion after browser auth.
const OAUTH_POPUP_NAMES = new Set([
  "cortexai-agent-hub-app-connect",
  "cortexai-agent-hub-mcp-oauth",
  "cortexai-agent-hub-model-oauth",
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
