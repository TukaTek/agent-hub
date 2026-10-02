import type { Socket } from "node:net";
import { loadRootEnv } from "@cortexai-agent-hub/core/node/load-root-env";

loadRootEnv();

import { SERVICE_NAMES } from "@cortexai-agent-hub/logging";
import { createRootLogger } from "@cortexai-agent-hub/logging/axiom";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import {
  parseProvisionArgs,
  provisionOwner,
  provisionUser,
  transferOwner,
} from "./cli/provision.js";
import { createDb } from "@cortexai-agent-hub/db";

const logger = createRootLogger(SERVICE_NAMES.api);

// Check for CLI mode (provision commands)
const cliArgs = parseProvisionArgs(process.argv.slice(2));
if (cliArgs) {
  try {
    const env = loadEnv();
    const prisma = await createDb(env.databaseUrl);

    let result: { success: boolean; message: string };
    
    if (cliArgs.command === "provision-owner") {
      if (!cliArgs.email || !cliArgs.name) {
        console.error("Usage: provision-owner --email <email> --name <name> [--secret-file <path>]");
        process.exit(1);
      }
      result = await provisionOwner(prisma, env, {
        email: cliArgs.email,
        name: cliArgs.name,
        secretFile: cliArgs.secretFile,
      });
    } else if (cliArgs.command === "provision-user") {
      if (!cliArgs.email || !cliArgs.name) {
        console.error("Usage: provision-user --email <email> --name <name> [--secret-file <path>]");
        process.exit(1);
      }
      result = await provisionUser(prisma, env, {
        email: cliArgs.email,
        name: cliArgs.name,
        secretFile: cliArgs.secretFile,
      });
    } else if (cliArgs.command === "transfer-owner") {
      if (!cliArgs.email) {
        console.error("Usage: transfer-owner --email <email>");
        process.exit(1);
      }
      result = await transferOwner(prisma, {
        email: cliArgs.email,
      });
    } else {
      console.error("Unknown command");
      process.exit(1);
    }

    console.log(result.message);
    await prisma.$disconnect();
    await logger.flush({ timeoutMs: 2_000 });
    process.exit(result.success ? 0 : 1);
  } catch (error) {
    console.error("Provision command failed:", error);
    await logger.flush({ timeoutMs: 2_000 });
    process.exit(1);
  }
}

try {
  const env = loadEnv();
  const { app, stop } = await createApp({ ...env, logger });
  const server = serve({ fetch: app.fetch, port: env.port, hostname: env.apiHost }, () => {
    logger.info("api listening", { "http.host": env.apiHost, "http.port": env.port });
  });

  // Long-lived connections (threads.subscribe SSE streams) never end on their
  // own, so server.close() alone waits forever for them. Track sockets and
  // force-close any still open after a short grace period for in-flight
  // requests, or every restart/shutdown hangs until something force-kills it.
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    const grace = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, 2_000);
    await closed;
    clearTimeout(grace);
    await stop();
    await logger.flush({ timeoutMs: 2_000 });
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
} catch (error) {
  logger.error("api startup failed", error);
  await logger.flush({ timeoutMs: 2_000 });
  process.exit(1);
}
