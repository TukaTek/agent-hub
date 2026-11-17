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
import { RUN_DRAIN_SIGNAL, trackConnections } from "./drain.js";
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

  // A stop that hands runs back is killed 30 seconds after the signal; leave time for stop().
  const drain = trackConnections(server as Server);
  // Outlive the proxy's 2-minute idle reuse, or a request can hit a socket Node just closed.
  (server as Server).keepAliveTimeout = 125_000;

  let stopped: Promise<void> | undefined;
  const shutdown = (letRunsFinish: boolean) => {
    // Stopping at once claims no new run, even while ordinary requests finish. One without
    // letRunsFinish that arrives while the runs are draining ends the drain at once.
    if (stopped) {
      if (!letRunsFinish) void stop();
      return stopped;
    }
    stopStallWatch();
    stopped = (async () => {
      await stop({ letRunsFinish, connectionsClosed: drain(20_000) });
      await hubPolicy?.close();
      await logger.flush({ timeoutMs: 2_000 });
    })();
    return stopped;
  };
  stopOnShutdownSignals(() => shutdown(false));
  // Sent only by a deploy that has already started the next API and waits for this one to exit:
  // stop taking requests at once, but let the chat turns running here end first.
  process.on(RUN_DRAIN_SIGNAL, () => void shutdown(true));
  // F3: drain, then exit non-zero so Compose or systemd restarts onto Hub's revision.
  restartForHubPolicy = () =>
    void shutdown(false).finally(() => process.exit(HUB_POLICY_RESTART_EXIT_CODE));
} catch (error) {
  logger.error("api startup failed", error);
  await logger.flush({ timeoutMs: 2_000 });
  process.exit(1);
}
