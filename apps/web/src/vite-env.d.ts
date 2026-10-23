/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_UI_LOCALE?: string;
  /** Build id (`YYYYMMDDHHMMSS`) of a production build; empty on the dev server. */
  readonly CORTEXAI_AGENT_HUB_BUILD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.po" {
  export const messages: Record<string, unknown>;
}
