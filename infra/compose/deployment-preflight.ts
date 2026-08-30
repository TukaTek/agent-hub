import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";

export interface ComposePort {
  target?: number;
  published?: string | number;
  protocol?: string;
  host_ip?: string;
}

export interface ComposeService {
  image?: string;
  environment?: Record<string, string | number | boolean | null>;
  networks?: string[] | Record<string, unknown>;
  ports?: ComposePort[];
}

export interface ComposeModel {
  services: Record<string, ComposeService | undefined>;
  networks: Record<string, { internal?: boolean } | undefined>;
}

export interface HostFacts {
  architecture: string;
  totalMemoryBytes: number;
  freeDiskBytes: number;
  currentRevision: string;
  sourceClean: boolean;
  sourceIndexFlagsClear: boolean;
  publicOriginResolved: boolean;
}

export interface PreflightInput {
  env: NodeJS.ProcessEnv;
  host: HostFacts;
  compose: ComposeModel;
}

export type CheckStatus = "ok" | "missing" | "invalid" | "unsafe";

export interface PreflightCheck {
  subject: string;
  status: CheckStatus;
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
}

export interface DeploymentManifest {
  schemaVersion: 1;
  deploymentId: string;
  revision: string;
  image: { name: string; tag: string };
  provider: { kind: string };
  backup: { targetClass: string };
  topology: { publicPorts: string[] };
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => { status: number | null; stdout: string };

const CANONICAL_DEPLOYMENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FULL_GIT_REVISION = /^[0-9a-f]{40}$/;
const SUPPORTED_PROVIDERS: Record<string, string> = {
  e2b: "E2B_API_KEY",
  daytona: "DAYTONA_API_KEY",
  box: "BOX_API_KEY",
};
const REQUIRED_SECRETS = [
  "POSTGRES_PASSWORD",
  "BETTER_AUTH_SECRET",
  "ENCRYPTION_KEY",
  "SCREEN_PROXY_SECRET",
  "CORTEXAI_BACKUP_ENCRYPTION_KEY",
] as const;
const PLACEHOLDER_SECRET =
  /(change[-_ ]?me|replace[-_ ]?with|placeholder|example|test[-_ ]?only|default[-_ ]?secret)/i;
const MIN_MEMORY_BYTES = 4 * 1024 ** 3;
const MIN_DISK_BYTES = 20 * 1024 ** 3;
const SUPPORTED_ARCHITECTURES = new Set(["x64", "arm64"]);
const MANUAL_UPDATE_ONLY_MESSAGE = "Manual updates only for pilot.";
const LEGACY_UPDATER_SETTINGS = new Set([
  "GIT_SHA_PREVIOUS",
  "RAKAZO_COMPOSE_FILE",
  "RAKAZO_COMPOSE_PROJECT_NAME",
  "RAKAZO_DEPLOY_DIR",
  "RAKAZO_IMAGE_TAG_PREVIOUS",
]);
const BACKUP_TARGET_CLASSES: Record<string, string> = {
  "s3:": "s3",
  "gs:": "gcs",
  "azure:": "azure-object-storage",
};

export function validateProductionPreflight(input: PreflightInput): PreflightResult {
  const checks: PreflightCheck[] = [];
  checks.push(
    input.env.NODE_ENV === "production"
      ? ok("NODE_ENV", "production")
      : invalid("NODE_ENV", "production-required"),
  );
  checks.push(validateManualUpdatePilot(input.env));
  const deploymentId = input.env.CORTEXAI_DEPLOYMENT_ID;
  const deploymentIdOk =
    deploymentId !== undefined &&
    deploymentId === deploymentId.trim() &&
    CANONICAL_DEPLOYMENT_ID.test(deploymentId) &&
    !deploymentId.startsWith("00000000-0000-");
  checks.push(
    deploymentIdOk
      ? ok("CORTEXAI_DEPLOYMENT_ID", "canonical")
      : invalid("CORTEXAI_DEPLOYMENT_ID", deploymentId ? "malformed" : "missing"),
  );

  const provider = input.env.SANDBOX_PROVIDER;
  const providerSecretName = provider ? SUPPORTED_PROVIDERS[provider] : undefined;
  checks.push(
    providerSecretName
      ? ok("SANDBOX_PROVIDER", "remote-provider")
      : invalid("SANDBOX_PROVIDER", provider ? "unsafe-provider" : "missing"),
  );

  const secretNames = [...REQUIRED_SECRETS, ...(providerSecretName ? [providerSecretName] : [])];
  const duplicateValues = duplicatedSecretValues(input.env, secretNames);
  for (const name of secretNames) {
    checks.push(validateSecret(name, input.env[name], duplicateValues));
  }

  checks.push(validateOrigins(input.env));
  checks.push(validateBackup(input.env));
  checks.push(validateRevision(input));
  checks.push(
    input.host.totalMemoryBytes >= MIN_MEMORY_BYTES
      ? ok("host-memory", "at-least-4-gib")
      : invalid("host-memory", "below-4-gib"),
  );
  checks.push(
    input.host.freeDiskBytes >= MIN_DISK_BYTES
      ? ok("host-disk", "at-least-20-gib-free")
      : invalid("host-disk", "below-20-gib-free"),
  );
  checks.push(
    SUPPORTED_ARCHITECTURES.has(input.host.architecture)
      ? ok("host-architecture", "supported")
      : invalid("host-architecture", "unsupported"),
  );
  checks.push(
    input.host.publicOriginResolved
      ? ok("host-dns", "public-origin-resolved")
      : invalid("host-dns", "public-origin-unresolved"),
  );

  checks.push(validateComposePorts(input.compose));
  checks.push(validateComposeNetworks(input.compose));
  checks.push(validateComposeRuntime(input));

  return { ok: checks.every((check) => check.status === "ok"), checks };
}

export function createDeploymentManifest(input: PreflightInput): DeploymentManifest {
  const result = validateProductionPreflight(input);
  if (!result.ok) throw new Error("Deployment inventory is unavailable until preflight passes.");
  return {
    schemaVersion: 1,
    deploymentId: input.env.CORTEXAI_DEPLOYMENT_ID!,
    revision: input.env.GIT_SHA!,
    image: {
      name: input.env.RAKAZO_IMAGE!,
      tag: input.env.RAKAZO_IMAGE_TAG!,
    },
    provider: { kind: input.env.SANDBOX_PROVIDER! },
    backup: { targetClass: backupTargetClass(input.env.CORTEXAI_BACKUP_TARGET)! },
    topology: { publicPorts: renderedPublicPorts(input.compose) },
  };
}

export function renderComposeConfig(
  runner: CommandRunner,
  options: {
    cwd: string;
    envFile: string;
    composeFile: string;
    env: NodeJS.ProcessEnv;
  },
): ComposeModel {
  const args = [
    "compose",
    "--env-file",
    options.envFile,
    "-f",
    options.composeFile,
    "config",
    "--format",
    "json",
  ];
  const rendered = runner("docker", args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (rendered.status !== 0) {
    throw new Error("Compose configuration could not be rendered safely.");
  }
  try {
    const model = JSON.parse(rendered.stdout) as ComposeModel;
    if (!model.services || !model.networks) throw new Error("invalid model");
    return model;
  } catch {
    throw new Error("Compose configuration returned an invalid model.");
  }
}

function validateManualUpdatePilot(env: NodeJS.ProcessEnv): PreflightCheck {
  const updaterSettings = Object.keys(env).filter(
    (name) => name.startsWith("RAKAZO_UPDATER_") || LEGACY_UPDATER_SETTINGS.has(name),
  );
  const updaterProfile = (env.COMPOSE_PROFILES ?? "")
    .split(",")
    .map((profile) => profile.trim())
    .includes("updater");
  return updaterSettings.length === 0 && !updaterProfile
    ? ok("automated-updater", MANUAL_UPDATE_ONLY_MESSAGE)
    : unsafe("automated-updater", MANUAL_UPDATE_ONLY_MESSAGE);
}

function validateSecret(
  name: string,
  value: string | undefined,
  duplicateValues: ReadonlySet<string>,
): PreflightCheck {
  if (!value) return missing(name, "missing");
  if (value !== value.trim()) return invalid(name, "whitespace-altered");
  if (value.length < 32) return invalid(name, "length-below-32");
  if (PLACEHOLDER_SECRET.test(value)) return unsafe(name, "placeholder");
  if (name === "POSTGRES_PASSWORD" && !/^[A-Za-z0-9._~-]+$/.test(value)) {
    return invalid(name, "uri-unsafe-character");
  }
  if (name === "ENCRYPTION_KEY" && !/^[0-9a-f]{64}$/.test(value)) {
    return invalid(name, "expected-64-lowercase-hex");
  }
  if (duplicateValues.has(value)) return unsafe(name, "reused");
  return ok(name, "length-at-least-32");
}

function duplicatedSecretValues(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const name of names) {
    const value = env[name];
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([value]) => value));
}

function validateOrigins(env: NodeJS.ProcessEnv): PreflightCheck {
  const names = ["WEB_ORIGIN", "BETTER_AUTH_URL", "API_URL"] as const;
  const declaredHost = env.RAKAZO_HOST;
  if (
    !declaredHost ||
    declaredHost !== declaredHost.trim() ||
    declaredHost !== declaredHost.toLowerCase()
  ) {
    return invalid("public-origins", "RAKAZO_HOST:missing-or-malformed");
  }
  const origins: string[] = [];
  for (const name of names) {
    const value = env[name];
    if (!value || value !== value.trim()) return invalid("public-origins", `${name}:missing`);
    try {
      const parsed = new URL(value);
      if (
        parsed.protocol !== "https:" ||
        parsed.port !== "" ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash
      ) {
        return invalid("public-origins", `${name}:unsafe`);
      }
      if (parsed.hostname !== declaredHost) {
        return invalid("public-origins", `${name}:host-mismatch`);
      }
      origins.push(parsed.origin);
    } catch {
      return invalid("public-origins", `${name}:malformed`);
    }
  }
  return new Set(origins).size === 1
    ? ok("public-origins", "same-origin-https")
    : invalid("public-origins", "inconsistent");
}

function validateBackup(env: NodeJS.ProcessEnv): PreflightCheck {
  const targetClass = backupTargetClass(env.CORTEXAI_BACKUP_TARGET);
  const encryptionKey = env.CORTEXAI_BACKUP_ENCRYPTION_KEY;
  if (!targetClass) return invalid("off-host-backup", "target-missing-or-unsafe");
  if (!encryptionKey || encryptionKey.length < 32 || PLACEHOLDER_SECRET.test(encryptionKey)) {
    return invalid("off-host-backup", "encryption-missing-or-unsafe");
  }
  return ok("off-host-backup", `encrypted-${targetClass}`);
}

function backupTargetClass(value: string | undefined): string | undefined {
  if (!value || value !== value.trim()) return undefined;
  try {
    const target = new URL(value);
    if (!target.hostname || target.username || target.password) return undefined;
    return BACKUP_TARGET_CLASSES[target.protocol];
  } catch {
    return undefined;
  }
}

function validateRevision(input: PreflightInput): PreflightCheck {
  const revision = input.env.GIT_SHA;
  const image = input.env.RAKAZO_IMAGE;
  const tag = input.env.RAKAZO_IMAGE_TAG;
  if (
    !revision ||
    !FULL_GIT_REVISION.test(revision) ||
    input.host.currentRevision !== revision ||
    !input.host.sourceClean ||
    !input.host.sourceIndexFlagsClear ||
    !image ||
    image !== image.trim() ||
    image.includes("@") ||
    tag !== `sha-${revision}`
  ) {
    return invalid("source-revision", "checkout-or-image-not-source-addressed");
  }
  return ok("source-revision", "exact-source-addressed-image");
}

function validateComposePorts(model: ComposeModel): PreflightCheck {
  const services = model.services;
  const required = ["postgres", "api", "worker", "web", "caddy"];
  if (required.some((name) => !services[name])) {
    return invalid("compose-public-ports", "required-service-missing");
  }
  for (const [serviceName, service] of Object.entries(services)) {
    for (const port of service?.ports ?? []) {
      const published = Number(port.published);
      const protocol = port.protocol ?? "tcp";
      if (
        serviceName !== "caddy" ||
        ![80, 443].includes(published) ||
        port.target !== published ||
        !["tcp", "udp"].includes(protocol) ||
        !isPublicBind(port.host_ip)
      ) {
        return unsafe("compose-public-ports", "internal-or-unexpected-port-published");
      }
    }
  }
  const ports = new Set(renderedPublicPorts(model));
  return ["80/tcp", "443/tcp", "443/udp"].every((port) => ports.has(port))
    ? ok("compose-public-ports", "only-80-and-443")
    : invalid("compose-public-ports", "edge-port-missing");
}

function renderedPublicPorts(model: ComposeModel): string[] {
  return (model.services.caddy?.ports ?? []).map(
    (port) => `${Number(port.published)}/${port.protocol ?? "tcp"}`,
  );
}

function isPublicBind(hostIp: string | undefined): boolean {
  return hostIp === undefined || hostIp === "" || hostIp === "0.0.0.0" || hostIp === "::";
}

function validateComposeNetworks(model: ComposeModel): PreflightCheck {
  const data = model.networks.data;
  if (!data?.internal) return invalid("compose-private-networks", "data-network-not-internal");
  const expectedNetworks: Record<string, string[]> = {
    postgres: ["data"],
    api: ["app", "data"],
    worker: ["app", "data"],
    web: ["edge", "app"],
    caddy: ["edge", "app"],
  };
  for (const [name, expected] of Object.entries(expectedNetworks)) {
    const service = model.services[name];
    const actual = service ? serviceNetworks(service) : [];
    if (
      actual.length !== expected.length ||
      expected.some((network) => !actual.includes(network))
    ) {
      return invalid("compose-private-networks", "service-network-drift");
    }
  }
  return ok("compose-private-networks", "internal-services-unpublished");
}

function serviceNetworks(service: ComposeService): string[] {
  if (Array.isArray(service.networks)) return service.networks;
  return Object.keys(service.networks ?? {});
}

function validateComposeRuntime(input: PreflightInput): PreflightCheck {
  const expectedIdentity = input.env.CORTEXAI_DEPLOYMENT_ID;
  const expectedProvider = input.env.SANDBOX_PROVIDER;
  const expectedImage = `${input.env.RAKAZO_IMAGE}:${input.env.RAKAZO_IMAGE_TAG}`;
  for (const name of ["api", "worker"] as const) {
    const service = input.compose.services[name];
    if (
      !service ||
      service.environment?.CORTEXAI_DEPLOYMENT_ID !== expectedIdentity ||
      service.environment?.SANDBOX_PROVIDER !== expectedProvider ||
      service.image !== expectedImage
    ) {
      return invalid("compose-runtime-identity", "api-worker-runtime-drift");
    }
  }
  if (input.compose.services.web?.image !== expectedImage) {
    return invalid("compose-runtime-identity", "web-image-drift");
  }
  const expectedHost = input.env.RAKAZO_HOST;
  if (
    input.compose.services.web?.environment?.RAKAZO_HOST !== expectedHost ||
    input.compose.services.caddy?.environment?.RAKAZO_HOST !== expectedHost
  ) {
    return invalid("compose-runtime-identity", "public-host-drift");
  }
  return ok("compose-runtime-identity", "runtime-images-and-identity-match");
}

function ok(subject: string, detail: string): PreflightCheck {
  return { subject, status: "ok", detail };
}

function missing(subject: string, detail: string): PreflightCheck {
  return { subject, status: "missing", detail };
}

function invalid(subject: string, detail: string): PreflightCheck {
  return { subject, status: "invalid", detail };
}

function unsafe(subject: string, detail: string): PreflightCheck {
  return { subject, status: "unsafe", detail };
}
