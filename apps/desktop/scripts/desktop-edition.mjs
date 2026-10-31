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

/**
 * Bakes `CORTEXAI_AGENT_HUB_DISCOVERY_URL`, the central Hub that managed setup asks
 * which organization a work email belongs to. Required for managed builds, which
 * have no other way to connect; unset bakes null for self-host builds.
 */
export function desktopDiscoveryDefine(env) {
  const raw = env.CORTEXAI_AGENT_HUB_DISCOVERY_URL?.trim() || null;
  if (raw === null && env.CORTEXAI_AGENT_HUB_DESKTOP_EDITION === "managed") {
    throw new Error(
      "CORTEXAI_AGENT_HUB_DISCOVERY_URL is required when CORTEXAI_AGENT_HUB_DESKTOP_EDITION is managed.",
    );
  }
  if (raw !== null && !isHttpsOrigin(raw)) {
    throw new Error(
      `CORTEXAI_AGENT_HUB_DISCOVERY_URL must be an HTTPS origin such as https://hub.example.com, got "${raw}".`,
    );
  }
  return { __CORTEXAI_AGENT_HUB_DISCOVERY_URL__: JSON.stringify(raw) };
}

function isHttpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}
