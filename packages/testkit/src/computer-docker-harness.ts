import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { AdapterContext, ComputerRef } from "@cortexai-agent-hub/adapter-kit";
import { DockerSandboxProvider } from "@cortexai-agent-hub/adapters";
import { serve } from "@hono/node-server";
import { computerReplayContext } from "./computer-replay.js";

export interface DockerComputer {
  sandbox: DockerSandboxProvider;
  computer: ComputerRef;
  context: AdapterContext;
}

/**
 * Runs `fn` against a real computer container provisioned through an in-process supervisor,
 * the same path bots use. Requires the isolated environment the computer-replay CLI creates.
 */
export async function withDockerComputer(
  botPrefix: string,
  fn: (computer: DockerComputer) => Promise<void>,
) {
  if (!process.env.DATA_DIR || !process.env.SANDBOX_SUPERVISOR_TOKEN) {
    throw new Error(
      "Run through the computer-replay CLI to create an isolated supervisor environment",
    );
  }
  const { supervisorApp } = await import("../../../infra/sandboxes/supervisor/src/index.js");
  const server = serve({ fetch: supervisorApp.fetch, hostname: "127.0.0.1", port: 0 });
  try {
    if (!server.listening)
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.once("listening", () => {
          server.off("error", reject);
          resolve();
        });
      });
    const port = (server.address() as AddressInfo).port;
    const sandbox = new DockerSandboxProvider(
      `http://127.0.0.1:${port}`,
      process.env.SANDBOX_SUPERVISOR_TOKEN,
    );
    const context = {
      ...computerReplayContext(),
      botId: `${botPrefix}-${randomUUID()}`,
      signal: AbortSignal.timeout(240_000),
    };
    const homePath = path.join(process.env.DATA_DIR, "homes", context.botId);
    await mkdir(homePath, { recursive: true });
    let computer: ComputerRef | undefined;
    let ownedNetwork: string | undefined;
    try {
      // Optional escape hatch for a daemon whose automatic address pool is full.
      // Docker rejects overlapping subnets; only this test's unique network is touched.
      if (process.env.COMPUTER_REPLAY_SUBNET) {
        const { computerNetworkNameFor } = await import(
          "../../../infra/sandboxes/supervisor/src/computer-spec.js"
        );
        const name = computerNetworkNameFor(context.botId);
        execFileSync(
          "docker",
          ["network", "create", "--subnet", process.env.COMPUTER_REPLAY_SUBNET, name],
          { stdio: "pipe" },
        );
        ownedNetwork = name;
      }
      computer = await sandbox.provision({ botId: context.botId, homePath }, context);
      await sandbox.prepare(computer, context);
      await fn({ sandbox, computer, context });
    } finally {
      try {
        if (computer)
          await sandbox.destroy(computer, { ...context, signal: AbortSignal.timeout(30_000) });
      } finally {
        if (ownedNetwork) {
          // Successful destroy already removes it. A failed provision may leave it behind.
          execFileSync("docker", ["network", "rm", "--force", ownedNetwork], {
            stdio: "pipe",
            timeout: 30_000,
          });
        }
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error && (!("code" in error) || error.code !== "ERR_SERVER_NOT_RUNNING")
          ? reject(error)
          : resolve(),
      );
      (server as Server).closeAllConnections();
    });
  }
}
