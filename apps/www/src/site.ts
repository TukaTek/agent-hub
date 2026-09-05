export const SITE_NAME = "CortexAI Agent Hub";
export const SITE_URL = "https://www.tukasolutions.com/cortexaiagenthub";
export const SITE_DESCRIPTION =
  "CortexAI Agent Hub gives every person a persistent, always-on AI assistant that can do real work.";

export const GITHUB_URL = "https://github.com/TukaTek/agent-hub";
export const GITHUB_API_REPO = "https://api.github.com/repos/TukaTek/agent-hub";
export const DOCS_URL = "https://github.com/TukaTek/agent-hub/blob/main/docs/self-host.md";
export const SETUP_PROMPT_URL = "https://github.com/TukaTek/agent-hub/blob/main/SETUP_PROMPT.md";
export const CHANGELOG_URL = "https://github.com/TukaTek/agent-hub/releases";
export const CORTEXAI_URL = "https://www.tukasolutions.com/";
export const CORTEXAI_CONTACT_URL = "https://www.tukasolutions.com/contact";
export const SECURITY_URL = "https://github.com/TukaTek/agent-hub/security/advisories/new";

export function absoluteSiteUrl(pathname = "/"): string {
  const base = SITE_URL.endsWith("/") ? SITE_URL : `${SITE_URL}/`;
  return new URL(pathname.replace(/^\/+/, ""), base).toString();
}
