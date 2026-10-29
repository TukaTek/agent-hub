import { closeSettingsSheet, isSettingsLink } from "../lib/settings-sheet";

/** A link to a screen outside settings closes the settings sheet first, so the screen opens on
 * the root stack instead of over the sheet. Settings links open inside the sheet. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  // The auth session reads the Hub SSO handoff itself; keep its code out of router state.
  if (isHubSsoHandoff(path)) return "/sign-in";
  if (!isSettingsLink(path)) closeSettingsSheet();
  return path;
}

function isHubSsoHandoff(path: string): boolean {
  const screen = path
    .replace(/^[a-z][a-z\d+.-]*:\/\//i, "")
    .replace(/^\/+/, "")
    .split(/[/?#]/, 1)[0];
  return screen === "hub-sso";
}
