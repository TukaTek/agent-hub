const EDITIONS = new Set(["self-host", "managed"]);

/**
 * Bakes `CORTEXAI_AGENT_HUB_DESKTOP_EDITION` into the main-process bundle. Unset means
 * self-host, so dev and self-host builds stay as they are; `managed` hides the
 * self-hosted server entry on setup.
 */
export function desktopEditionDefine(env) {
  const edition = env.CORTEXAI_AGENT_HUB_DESKTOP_EDITION || "self-host";
  if (!EDITIONS.has(edition)) {
    throw new Error(
      `CORTEXAI_AGENT_HUB_DESKTOP_EDITION must be "self-host" or "managed", got "${edition}".`,
    );
  }
  return { __CORTEXAI_AGENT_HUB_DESKTOP_EDITION__: JSON.stringify(edition) };
}
