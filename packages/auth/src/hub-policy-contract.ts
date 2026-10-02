import { HUB_CONFIG_INVALID, type HubSignInRefusalCode } from "@cortexai-agent-hub/core";

/**
 * Hub's server-scoped Agent Hub policy (`GET /api/agent-hub/service-config`,
 * schema `agent-hub-settings-v1`). The catalog mirrors Hub's field list and its
 * documented mapping onto Agent Hub's existing environment and deployment inputs.
 * Anything outside it is rejected, so an unknown field can never switch on
 * behavior or be silently ignored.
 */
export const HUB_POLICY_SCHEMA = "agent-hub-settings-v1";
export const HUB_POLICY_PRODUCT = "cortexai-agent-hub";

/** Stable sign-in refusal codes, shared with the clients through core. */
export {
  HUB_ACCESS_DENIED,
  HUB_CONFIG_INVALID,
  HUB_CONFIG_RESTART_REQUIRED,
  HUB_UNAVAILABLE,
  TENANT_DISABLED,
} from "@cortexai-agent-hub/core";
export type HubPolicyCode = HubSignInRefusalCode;

/** `reason` is a fixed token or a setting path. It never carries a setting value. */
export class HubPolicyError extends Error {
  constructor(
    readonly code: HubPolicyCode,
    readonly reason: string,
  ) {
    super(`Hub policy refused: ${code}`);
  }
}

export type HubSettingCategory =
  | "provider"
  | "model_funding"
  | "toolkit_tools"
  | "features"
  | "connections";
type Kind = "text" | "secret" | "boolean" | "number" | "list" | "select";
export type HubSettingValue = string | number | boolean | readonly string[];

export interface HubManagedSetting {
  path: string;
  kind: Kind;
  category: HubSettingCategory;
  /** Environment inputs this setting replaces; the first one receives Hub's value. */
  env: readonly string[];
  /** Persisted DeploymentSettings field this setting also overrides at read time. */
  deploymentField?:
    | "defaultModelProvider"
    | "defaultModelId"
    | "signupsEnabled"
    | "signupAllowlist";
  options?: readonly string[];
  min?: number;
  max?: number;
}

const settings: HubManagedSetting[] = [];
function add(
  category: HubSettingCategory,
  path: string,
  kind: Kind,
  env: string | readonly string[],
  extra: Partial<HubManagedSetting> = {},
) {
  settings.push({ category, path, kind, env: typeof env === "string" ? [env] : env, ...extra });
}
add("features", "signup.enabled", "boolean", "SIGNUPS_ENABLED", {
  deploymentField: "signupsEnabled",
});
add("features", "signup.allowlist", "list", "SIGNUP_ALLOWLIST", {
  deploymentField: "signupAllowlist",
});
add("provider", "model.defaultProvider", "text", "PI_DEFAULT_PROVIDER", {
  deploymentField: "defaultModelProvider",
});
add("model_funding", "model.defaultModel", "text", "PI_DEFAULT_MODEL", {
  deploymentField: "defaultModelId",
});
add("model_funding", "model.credentials.openrouter", "secret", "OPENROUTER_API_KEY");
add("model_funding", "model.credentials.anthropic", "secret", "ANTHROPIC_API_KEY");
add("model_funding", "model.local.ids", "list", "CORTEXAI_AGENT_HUB_LOCAL_MODELS");
add("model_funding", "model.local.baseUrl", "text", "CORTEXAI_AGENT_HUB_LOCAL_MODELS_URL");
add(
  "model_funding",
  "model.local.contextWindow",
  "number",
  "CORTEXAI_AGENT_HUB_LOCAL_CONTEXT_WINDOW",
  { min: 1 },
);
add("model_funding", "model.local.maxTokens", "number", "CORTEXAI_AGENT_HUB_LOCAL_MAX_TOKENS", {
  min: 1,
});
add("provider", "computer.provider", "select", "SANDBOX_PROVIDER", {
  options: ["none", "docker", "e2b", "daytona", "box"],
});
add("connections", "computer.e2b.apiKey", "secret", "E2B_API_KEY");
add("connections", "computer.daytona.apiKey", "secret", "DAYTONA_API_KEY");
add("connections", "computer.daytona.apiUrl", "text", "DAYTONA_API_URL");
add("connections", "computer.daytona.target", "text", "DAYTONA_TARGET");
add("connections", "computer.box.apiKey", "secret", "BOX_API_KEY");
add("connections", "computer.box.apiUrl", "text", ["BOX_API_URL", "BOX_BASE_URL"]);
add("features", "computer.idleMs", "number", "SANDBOX_IDLE_MS", { min: 30_000 });
add("features", "computer.takeoverTtlMs", "number", "COMPUTER_TAKEOVER_TTL_MS", { min: 1_000 });
add("provider", "cloudAgent.provider", "select", "CLOUD_AGENT_PROVIDER", {
  options: ["none", "cursor"],
});
add("connections", "cloudAgent.spaceId", "text", "CLOUD_AGENT_SPACE_ID");
add("connections", "cloudAgent.apiKey", "secret", "CURSOR_API_KEY");
add("toolkit_tools", "connectors.composio.apiKey", "secret", "COMPOSIO_API_KEY");
add("toolkit_tools", "connectors.pipedream.clientId", "text", "PIPEDREAM_CLIENT_ID");
add("toolkit_tools", "connectors.pipedream.clientSecret", "secret", "PIPEDREAM_CLIENT_SECRET");
add("toolkit_tools", "connectors.pipedream.projectId", "text", "PIPEDREAM_PROJECT_ID");
add("toolkit_tools", "connectors.pipedream.environment", "select", "PIPEDREAM_ENVIRONMENT", {
  options: ["development", "production"],
});
add("toolkit_tools", "mcp.stdioEnabled", "boolean", "MCP_STDIO_ENABLED");
add("toolkit_tools", "mcp.stdioAllowedCommands", "list", "MCP_STDIO_ALLOWED_COMMANDS");
add("features", "autoReview.defaultEnabled", "boolean", "CORTEXAI_AGENT_HUB_AUTO_REVIEW");
add("provider", "autoReview.provider", "text", "CORTEXAI_AGENT_HUB_AUTO_REVIEW_PROVIDER");
add("model_funding", "autoReview.model", "text", "CORTEXAI_AGENT_HUB_AUTO_REVIEW_MODEL");
add("features", "autoReview.timeoutMs", "number", "CORTEXAI_AGENT_HUB_AUTO_REVIEW_TIMEOUT_MS", {
  min: 200,
  max: 30_000,
});
add("features", "messaging.openSignup", "boolean", "MESSAGING_OPEN_SIGNUP");
const messaging: Record<string, Record<string, [env: string, secret: boolean]>> = {
  sendblue: {
    apiKeyId: ["SENDBLUE_API_KEY_ID", true],
    apiSecret: ["SENDBLUE_API_SECRET", true],
    signingSecret: ["SENDBLUE_SIGNING_SECRET", true],
    phoneNumber: ["SENDBLUE_PHONE_NUMBER", false],
  },
  slack: { botToken: ["SLACK_BOT_TOKEN", true], signingSecret: ["SLACK_SIGNING_SECRET", true] },
  whatsapp: {
    accessToken: ["WHATSAPP_ACCESS_TOKEN", true],
    phoneNumberId: ["WHATSAPP_PHONE_NUMBER_ID", false],
    appSecret: ["WHATSAPP_APP_SECRET", true],
    verifyToken: ["WHATSAPP_VERIFY_TOKEN", true],
  },
  telegram: {
    botToken: ["TELEGRAM_BOT_TOKEN", true],
    webhookSecret: ["TELEGRAM_WEBHOOK_SECRET_TOKEN", true],
  },
  lark: {
    appId: ["LARK_APP_ID", false],
    appSecret: ["LARK_APP_SECRET", true],
    verificationToken: ["LARK_VERIFICATION_TOKEN", true],
    encryptKey: ["LARK_ENCRYPT_KEY", true],
  },
};
for (const [provider, fields] of Object.entries(messaging)) {
  for (const [key, [env, secret]] of Object.entries(fields)) {
    add("connections", `messaging.providers.${provider}.${key}`, secret ? "secret" : "text", env);
  }
}
add("connections", "messaging.providers.lark.domain", "select", "LARK_DOMAIN", {
  options: ["lark", "feishu"],
});
add("connections", "email.smtpUrl", "secret", "SMTP_URL");
add("connections", "email.from", "text", "EMAIL_FROM");

export const HUB_MANAGED_SETTINGS: readonly HubManagedSetting[] = settings;
const byPath = new Map(settings.map((setting) => [setting.path, setting]));

export interface HubPolicyDocument {
  tenantId: string;
  revision: number;
  updatedAt: string | null;
  /** Hub-managed settings by path. Secret values stay server-side. */
  overrides: Readonly<Record<string, HubSettingValue>>;
  /** Composio toolkits for this product. Unknown means none, never all. */
  toolkits: { status: "configured" | "unknown"; allowed: readonly string[] };
  /** Assigned Hub users. Empty or unattributable lists are unknown (CAH-204). */
  assignments: { status: "configured" | "unknown"; subjects: readonly string[] };
}

type Json = Record<string, unknown>;
const TOP_LEVEL = new Set([
  "schemaVersion",
  "product",
  "tenantId",
  "revision",
  "updatedAt",
  "overrides",
  "composio",
  "mcp",
  "skills",
  "access",
  "onboarding",
]);
const TOOLKIT_STATUS = new Set(["pending", "configured", "configured-empty"]);
const TOOLKIT_ID = /^[a-z0-9][a-z0-9_.-]{0,127}$/i;

const invalid = (reason: string) => new HubPolicyError(HUB_CONFIG_INVALID, reason);
const isObject = (value: unknown): value is Json =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function validValue(setting: HubManagedSetting, value: unknown): value is HubSettingValue {
  switch (setting.kind) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= (setting.min ?? 0) &&
        value <= (setting.max ?? Number.MAX_SAFE_INTEGER)
      );
    case "list":
      // Lists reach comma-separated inputs, so a comma inside an entry is rejected.
      return (
        Array.isArray(value) &&
        value.length <= 1000 &&
        new Set(value).size === value.length &&
        value.every(
          (entry) =>
            typeof entry === "string" &&
            entry.trim().length > 0 &&
            entry.length <= 512 &&
            !entry.includes(","),
        )
      );
    case "select":
      return typeof value === "string" && Boolean(setting.options?.includes(value));
    default: {
      if (
        typeof value !== "string" ||
        !value ||
        value.length > (setting.kind === "secret" ? 16_384 : 2_048) ||
        value.startsWith("enc:v1:") ||
        /[\r\n\0]/.test(value)
      )
        return false;
      if (!/\.(baseUrl|apiUrl)$/.test(setting.path)) return true;
      try {
        const url = new URL(value);
        return (
          (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
        );
      } catch {
        return false;
      }
    }
  }
}

function flattenOverrides(value: unknown): Record<string, HubSettingValue> {
  if (!isObject(value)) throw invalid("overrides");
  const result: Record<string, HubSettingValue> = {};
  const walk = (node: Json, prefix: string) => {
    for (const [key, child] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const setting = byPath.get(path);
      if (setting) {
        if (!validValue(setting, child)) throw invalid(`setting:${path}`);
        result[path] = child;
      } else if (isObject(child) && settings.some((s) => s.path.startsWith(`${path}.`))) {
        walk(child, path);
      } else {
        throw invalid(`setting:${path}`);
      }
    }
  };
  walk(value, "");
  if ("autoReview.provider" in result !== "autoReview.model" in result)
    throw invalid("setting:autoReview");
  return result;
}

function toolkitIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && TOOLKIT_ID.test(id)))
    throw invalid(`toolkits:${field}`);
  return value as string[];
}

function parseToolkits(value: unknown): HubPolicyDocument["toolkits"] {
  if (value === undefined) return { status: "unknown", allowed: [] };
  if (!isObject(value) || !isObject(value.tenantEnablement) || !isObject(value.productAccess))
    throw invalid("toolkits");
  const tenant = value.tenantEnablement;
  const product = value.productAccess;
  for (const tier of [tenant, product]) {
    if (typeof tier.status !== "string" || !TOOLKIT_STATUS.has(tier.status))
      throw invalid("toolkits:status");
    if (!isRevision(tier.revision)) throw invalid("toolkits:revision");
  }
  const enabled = toolkitIds(tenant.enabledToolkitIds, "enabled");
  const allowed = toolkitIds(product.allowedToolkitIds, "allowed");
  if (tenant.status === "pending" || product.status === "pending")
    return { status: "unknown", allowed: [] };
  // Hub already intersects; repeat it so a Hub regression cannot widen access.
  return { status: "configured", allowed: allowed.filter((id) => enabled.includes(id)) };
}

function parseAssignments(value: unknown, tenantId: string): HubPolicyDocument["assignments"] {
  if (value === undefined) return { status: "unknown", subjects: [] };
  if (
    !isObject(value) ||
    typeof value.status !== "string" ||
    !Array.isArray(value.productAssignments)
  )
    throw invalid("assignments");
  const subjects = new Set<string>();
  for (const row of value.productAssignments) {
    if (!isObject(row) || typeof row.tenantUserId !== "string" || !row.tenantUserId.trim())
      throw invalid("assignments");
    if (row.tenantId !== undefined && row.tenantId !== tenantId) throw invalid("tenant_mismatch");
    // Pre-CAH-204 rows carry Hub's internal product id and cover every product, so only
    // rows explicitly attributed to Agent Hub count as an assignment.
    if (row.productId === HUB_POLICY_PRODUCT) subjects.add(row.tenantUserId);
  }
  if (value.status !== "configured" || subjects.size === 0)
    return { status: "unknown", subjects: [] };
  return { status: "configured", subjects: [...subjects].sort() };
}

/** Validates one service-config document for the pinned tenant. Throws HubPolicyError. */
export function parseHubPolicy(raw: unknown, tenantId: string): HubPolicyDocument {
  if (!isObject(raw)) throw invalid("document");
  for (const key of Object.keys(raw)) if (!TOP_LEVEL.has(key)) throw invalid("unknown_field");
  if (raw.schemaVersion !== HUB_POLICY_SCHEMA) throw invalid("schema_version");
  if (raw.product !== HUB_POLICY_PRODUCT) throw invalid("audience");
  if (typeof raw.tenantId !== "string" || !raw.tenantId) throw invalid("tenant");
  if (raw.tenantId !== tenantId) throw invalid("tenant_mismatch");
  if (!isRevision(raw.revision)) throw invalid("revision");
  if (raw.updatedAt !== null && raw.updatedAt !== undefined) {
    if (typeof raw.updatedAt !== "string" || !Number.isFinite(Date.parse(raw.updatedAt)))
      throw invalid("updated_at");
  }
  for (const section of ["mcp", "skills", "onboarding"] as const) {
    if (raw[section] !== undefined && !isObject(raw[section])) throw invalid(section);
  }
  return {
    tenantId,
    revision: raw.revision,
    updatedAt: (raw.updatedAt as string | null | undefined) ?? null,
    overrides: flattenOverrides(raw.overrides),
    toolkits: parseToolkits(raw.composio),
    assignments: parseAssignments(raw.access, tenantId),
  };
}
