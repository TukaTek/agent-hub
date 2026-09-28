import type { AdapterContext, ComputerRef } from "@cortexai-agent-hub/adapter-kit";
import { describe, expect, it } from "vitest";
import { BrowserStoppedReleaseError } from "./computer-screens.js";
import { LinuxDesktop } from "./linux-desktop.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "workspace-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
} as AdapterContext;

const computer = {
  id: "sandbox-1",
  botId: "team-workspace-1",
  kind: "e2b",
  providerRef: "sandbox-1",
} as ComputerRef;

function host(result: { code: number; stdout: string; stderr?: string }) {
  return {
    environment: async () => ({
      homeDir: "/home/cortexai-agent-hub",
      workspaceDir: "/home/cortexai-agent-hub",
      browserProfilesDir: "/home/cortexai-agent-hub/.browser-profiles",
      displayStart: 1,
    }),
    run: async () => result,
    screenUrl: async () => "http://screen.example",
  };
}

describe("LinuxDesktop.releaseScreen", () => {
  it("reports the browser stopped when slot cleanup fails after the release marker", async () => {
    const desktop = new LinuxDesktop(
      host({
        code: 1,
        stdout: "CORTEXAI_AGENT_HUB_DESKTOP_RELEASED=0\n",
        stderr: "slot lock failed",
      }),
    );

    await expect(desktop.releaseScreen(computer, context)).rejects.toBeInstanceOf(
      BrowserStoppedReleaseError,
    );
  });

  it("keeps a release that never stops the browser as a failure", async () => {
    const desktop = new LinuxDesktop(
      host({ code: 1, stdout: "", stderr: "browser still running" }),
    );

    await expect(desktop.releaseScreen(computer, context)).rejects.toThrow("browser still running");
  });
});
