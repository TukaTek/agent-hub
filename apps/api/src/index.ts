import type { Socket } from "node:net";
import { loadRootEnv } from "@cortexai-agent-hub/core/node/load-root-env";

loadRootEnv();

import { SERVICE_NAMES } from "@cortexai-agent-hub/logging";
import { createRootLogger } from "@cortexai-agent-hub/logging/axiom";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { HUB_POLICY_RESTART_EXIT_CODE, startApiHubPolicy } from "./hub-policy.js";

const logger = createRootLogger(SERVICE_NAMES.api);

try {
  // Bound once shutdown exists; a restart before then simply exits.
  let restartForHubPolicy: () => void = () => process.exit(HUB_POLICY_RESTART_EXIT_CODE);
  // Before loadEnv: Hub-managed settings replace their local inputs (CAAH-36).
  const hubPolicy = await startApiHubPolicy(process.env, logger, {
    onRestartRequired: (restart) => {
      logger.warn("hub policy changed a startup-bound setting; restarting to apply it", {
        "hub.policy.applied_revision": restart.appliedRevision,
        "hub.policy.hub_revision": restart.hubRevision,
      });
      restartForHubPolicy();
    },
  });
  const env = loadEnv();
  const { app, stop, startBackgroundMaintenance } = await createApp({
    ...env,
    logger,
    hubPolicy: hubPolicy?.policy,
  });
  const server = serve({ fetch: app.fetch, port: env.port, hostname: env.apiHost }, () => {
    logger.info("api listening", { "http.host": env.apiHost, "http.port": env.port });
    // After listen, so one-time maintenance never delays readiness (CAAH-71).
    void startBackgroundMaintenance();
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
    await hubPolicy?.close();
    await logger.flush({ timeoutMs: 2_000 });
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  // F3: drain, then exit non-zero so Compose or systemd restarts onto Hub's revision.
  restartForHubPolicy = () =>
    void shutdown().finally(() => process.exit(HUB_POLICY_RESTART_EXIT_CODE));
} catch (error) {
  logger.error("api startup failed", error);
  await logger.flush({ timeoutMs: 2_000 });
  process.exit(1);
}
