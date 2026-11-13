import type { Server } from "node:http";
import { unwrapEnvFromKeyManager } from "@cortexai-agent-hub/adapters";
import { loadRootEnv } from "@cortexai-agent-hub/core/node/load-root-env";
import { stopOnShutdownSignals } from "@cortexai-agent-hub/core/node/shutdown-signals";

loadRootEnv();
await unwrapEnvFromKeyManager();

import { SERVICE_NAMES } from "@cortexai-agent-hub/logging";
import { createRootLogger } from "@cortexai-agent-hub/logging/axiom";
import { watchEventLoopStalls } from "@cortexai-agent-hub/logging/event-loop";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { trackConnections } from "./drain.js";
import { loadEnv } from "./env.js";
import { HUB_POLICY_RESTART_EXIT_CODE, startApiHubPolicy } from "./hub-policy.js";

const logger = await createRootLogger(SERVICE_NAMES.api);
const stopStallWatch = watchEventLoopStalls("api.event_loop_stalled");

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
  const { app, stop, handleUpgrade } = await createApp({
    ...env,
    logger,
    hubPolicy: hubPolicy?.policy,
  });
  const server = serve({ fetch: app.fetch, port: env.port, hostname: env.apiHost }, () => {
    logger.info("api listening", { "http.host": env.apiHost, "http.port": env.port });
  });
  // Desktop apps hold an outbound socket so bots can reach the user's own computer.
  if (handleUpgrade) server.on("upgrade", handleUpgrade);

  // The deploy allows 30 seconds after the stop signal; leave time for stop() and the log flush.
  const drain = trackConnections(server as Server);
  // Outlive the proxy's 2-minute idle reuse, or a request can hit a socket Node just closed.
  (server as Server).keepAliveTimeout = 125_000;

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    stopStallWatch();
    await drain(20_000);
    await stop();
    await hubPolicy?.close();
    await logger.flush({ timeoutMs: 2_000 });
  };
  stopOnShutdownSignals(shutdown);
  // F3: drain, then exit non-zero so Compose or systemd restarts onto Hub's revision.
  restartForHubPolicy = () =>
    void shutdown().finally(() => process.exit(HUB_POLICY_RESTART_EXIT_CODE));
} catch (error) {
  logger.error("api startup failed", error);
  await logger.flush({ timeoutMs: 2_000 });
  process.exit(1);
}
