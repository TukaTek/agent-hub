/**
 * Entrypoint for the operator provisioning commands (CAAH-43):
 *   pnpm --filter @cortexai-agent-hub/api provision <command> [options] < password
 * Reads DATABASE_URL and the Hub mode settings from the environment. The
 * password is never read from the environment; see ./provision.ts.
 */
import { hubAuthFromEnv, ProvisioningError } from "@cortexai-agent-hub/auth";
import { createDb } from "@cortexai-agent-hub/db";
import {
  PROVISION_USAGE,
  ProvisionUsageError,
  parseProvisionArgs,
  provisionExitCode,
  runProvisionCommand,
} from "./provision.js";

// Plain stream writes: this is an operator CLI, not a service that logs.
const say = (line: string) => process.stdout.write(`${line}\n`);
const warn = (line: string) => process.stderr.write(`${line}\n`);

async function main(): Promise<number> {
  let args: ReturnType<typeof parseProvisionArgs>;
  try {
    args = parseProvisionArgs(process.argv.slice(2));
  } catch (error) {
    warn(error instanceof Error ? error.message : "Invalid arguments");
    warn(PROVISION_USAGE);
    return 2;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    warn("DATABASE_URL is required");
    return 2;
  }
  const hub = hubAuthFromEnv(process.env);
  const { prisma, pool } = createDb(databaseUrl);
  try {
    await runProvisionCommand(args, {
      prisma,
      hub,
      stdin: process.stdin,
      out: (line) => say(line),
    });
    return 0;
  } catch (error) {
    if (error instanceof ProvisioningError || error instanceof ProvisionUsageError) {
      warn(error.message);
      return error instanceof ProvisionUsageError ? 2 : provisionExitCode(error);
    }
    // Unexpected failures print the class only; a driver message could quote input.
    warn(`Provisioning failed (${error instanceof Error ? error.name : "error"})`);
    return 1;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

process.exitCode = await main();
