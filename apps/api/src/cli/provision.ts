/**
 * Operator provisioning commands (CAAH-43). Self-service signup is closed, so
 * these are the only way to create the first owner, add an account, or move
 * the owner seat. They run inside the API container against its database and
 * are never reachable over HTTP.
 *
 * Secrets are read only from piped stdin or a mounted --secret-file. They are
 * never taken from argv or the environment, never echoed, and never logged.
 */
import { readFile } from "node:fs/promises";
import {
  HUB_TENANT_MISSING,
  type HubAuthConfig,
  mapHubOwner,
  ProvisioningError,
  provisionLocalAccount,
  transferLocalOwner,
} from "@cortexai-agent-hub/auth";
import type { PrismaClient } from "@cortexai-agent-hub/db";

export const PROVISION_COMMANDS = ["provision-owner", "provision-user", "transfer-owner"] as const;
export type ProvisionCommand = (typeof PROVISION_COMMANDS)[number];

const VALUE_FLAGS = [
  "--email",
  "--name",
  "--secret-file",
  "--hub-user-id",
  "--hub-tenant",
] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

/** Flag names that would carry a secret on the command line. */
const SECRET_FLAG = /^--?(password|passwd|pass|pw|secret|token|credential)(=|$)/i;

export interface ProvisionArgs {
  command: ProvisionCommand;
  email?: string;
  name?: string;
  secretFile?: string;
  hubUserId?: string;
  hubTenant?: string;
}

export class ProvisionUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionUsageError";
  }
}

export const PROVISION_USAGE = `Usage (inside the API container):
  provision provision-owner --email <email> --name <name> [--secret-file <path>] < password
  provision provision-user  --email <email> --name <name> [--secret-file <path>] < password
  provision transfer-owner  --email <email>
Hub mode (AUTH_MODE=hub), where no local password exists:
  provision provision-owner --hub-user-id <tenant_users.id> --hub-tenant <tenant id>
  provision transfer-owner  --hub-user-id <tenant_users.id> --hub-tenant <tenant id>
The password is read from piped stdin or --secret-file, never from arguments or the environment.`;

/** Strict parser: unknown flags, repeated flags and inline secrets are refused. */
export function parseProvisionArgs(argv: readonly string[]): ProvisionArgs {
  const [command, ...rest] = argv;
  if (!command || !PROVISION_COMMANDS.includes(command as ProvisionCommand)) {
    throw new ProvisionUsageError(`Unknown command ${JSON.stringify(command ?? "")}`);
  }
  const values = new Map<ValueFlag, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (SECRET_FLAG.test(token) && !token.startsWith("--secret-file")) {
      // Do not echo the token: it may be the password itself.
      throw new ProvisionUsageError(
        "Passwords are never accepted as arguments. Pipe the password on stdin or use --secret-file.",
      );
    }
    const equals = token.indexOf("=");
    const flag = (equals === -1 ? token : token.slice(0, equals)) as ValueFlag;
    if (!VALUE_FLAGS.includes(flag)) {
      throw new ProvisionUsageError(
        token.startsWith("-") ? `Unknown option ${flag}` : "Unexpected positional argument",
      );
    }
    if (values.has(flag)) throw new ProvisionUsageError(`${flag} was given more than once`);
    let value: string | undefined;
    if (equals !== -1) value = token.slice(equals + 1);
    else {
      value = rest[index + 1];
      index += 1;
    }
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new ProvisionUsageError(`${flag} needs a value`);
    }
    values.set(flag, value);
  }
  return {
    command: command as ProvisionCommand,
    email: values.get("--email"),
    name: values.get("--name"),
    secretFile: values.get("--secret-file"),
    hubUserId: values.get("--hub-user-id"),
    hubTenant: values.get("--hub-tenant"),
  };
}

export interface SecretSource {
  isTTY?: boolean;
  [Symbol.asyncIterator](): AsyncIterator<string | Buffer | Uint8Array>;
}

/** One trailing line break (from echo or a file) is not part of the password. */
function stripLineEnd(value: string) {
  return value.replace(/\r?\n$/, "");
}

/**
 * Reads the password from --secret-file or piped stdin. A terminal is refused
 * rather than prompted, so the secret can never be echoed to the screen.
 */
export async function readProvisionSecret(
  args: Pick<ProvisionArgs, "secretFile">,
  stdin: SecretSource,
  readSecretFile: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<string> {
  if (args.secretFile) {
    let raw: string;
    try {
      raw = await readSecretFile(args.secretFile);
    } catch {
      throw new ProvisionUsageError("Could not read --secret-file");
    }
    return stripLineEnd(raw);
  }
  if (stdin.isTTY) {
    throw new ProvisionUsageError(
      "Pipe the password on stdin (for example `< password.txt`) or pass --secret-file.",
    );
  }
  const chunks: string[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  }
  return stripLineEnd(chunks.join(""));
}

export interface ProvisionDeps {
  prisma: PrismaClient;
  /** Parsed from the environment by hubAuthFromEnv; undefined in local mode. */
  hub: HubAuthConfig | undefined;
  stdin: SecretSource;
  out: (line: string) => void;
  readSecretFile?: (path: string) => Promise<string>;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new ProvisionUsageError(`${flag} is required`);
  return value;
}

function refuse(args: ProvisionArgs, flags: Array<keyof ProvisionArgs>, reason: string) {
  for (const flag of flags) {
    if (args[flag] !== undefined) throw new ProvisionUsageError(reason);
  }
}

/** Runs one command. Output names ids and emails only, never a secret. */
export async function runProvisionCommand(args: ProvisionArgs, deps: ProvisionDeps) {
  if (deps.hub) {
    // Hub mode: identities and passwords live in Hub. Creating a local
    // credential here would be a login that Hub mode never accepts, and a
    // seat keyed by email or Entra oid could be claimed by the wrong person.
    if (args.command === "provision-user") {
      throw new ProvisionUsageError(
        "AUTH_MODE=hub: accounts are managed in CortexAI Hub; provision-user is unavailable.",
      );
    }
    refuse(
      args,
      ["email", "name", "secretFile"],
      "AUTH_MODE=hub: no local password is created. Use --hub-user-id and --hub-tenant only.",
    );
    // M1: a not-configured Hub mode (no HUB_AUTH_TENANT_ID) has no tenant to check against,
    // so --hub-tenant alone must never decide whose seat this is.
    const configuredTenant = deps.hub.tenantId?.trim();
    if (deps.hub.notConfigured || !configuredTenant) {
      throw new ProvisioningError(HUB_TENANT_MISSING.code, HUB_TENANT_MISSING.message);
    }
    const result = await mapHubOwner(deps.prisma, {
      hubOrigin: deps.hub.origin,
      configuredTenant,
      hubTenant: requireValue(args.hubTenant, "--hub-tenant"),
      hubUserId: requireValue(args.hubUserId, "--hub-user-id"),
      transfer: args.command === "transfer-owner",
    });
    deps.out(
      `Deployment owner mapped to Hub user ${args.hubUserId} in tenant ${args.hubTenant}. ` +
        "It takes effect when that person signs in through Hub and is admitted.",
    );
    return result;
  }
  refuse(
    args,
    ["hubUserId", "hubTenant"],
    "--hub-user-id and --hub-tenant need AUTH_MODE=hub with HUB_AUTH_ORIGIN.",
  );
  const email = requireValue(args.email, "--email");
  if (args.command === "transfer-owner") {
    refuse(args, ["name", "secretFile"], "transfer-owner takes only --email.");
    const result = await transferLocalOwner(deps.prisma, { email });
    deps.out(`Deployment owner is now ${email}.`);
    return result;
  }
  const name = requireValue(args.name, "--name");
  const password = await readProvisionSecret(args, deps.stdin, deps.readSecretFile);
  const result = await provisionLocalAccount(deps.prisma, {
    email,
    name,
    password,
    owner: args.command === "provision-owner",
  });
  deps.out(
    result.owner
      ? `Created deployment owner ${result.email}.`
      : `Created account ${result.email} (not the owner).`,
  );
  return result;
}

/** Exit codes: 0 ok, 1 refused by state (owner exists, email taken), 2 usage. */
export function provisionExitCode(error: unknown): 1 | 2 {
  if (error instanceof ProvisioningError && error.code !== "INVALID_INPUT") return 1;
  return 2;
}
