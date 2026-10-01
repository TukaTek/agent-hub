import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioConnector } from "@cortexai-agent-hub/adapters";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";

type AppHandles = Awaited<ReturnType<typeof createApp>>;

vi.mock("@cortexai-agent-hub/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cortexai-agent-hub/adapters")>()),
  isComposioEnabled: (apiKey: string | undefined) => Boolean(apiKey),
}));

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;

describeWithDatabase("Composio in the API connector stack", () => {
  let handles: AppHandles | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await handles?.stop();
    handles = undefined;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function start(composioApiKey: string | undefined) {
    vi.spyOn(ComposioConnector.prototype, "warmDirectory").mockResolvedValue(undefined);
    dataDir = mkdtempSync(path.join(tmpdir(), "cortexai-agent-hub-composio-health-"));
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      composioApiKey,
    });
    const publicHealth = await (await handles.app.request("/health")).json();
    const health = await (await handles.app.request("/internal/health")).json();
    const composioEntries = handles.connectors
      .managedProviders()
      .filter((provider) => provider.describe().id === "composio");
    return { handles, publicHealth, health, composioEntries };
  }

  it("registers the env-key Composio connector once and reports it internally", async () => {
    const { handles, publicHealth, health, composioEntries } = await start("ck_fake");
    expect(publicHealth).toEqual({ ok: true });
    expect(handles.composio).toBeInstanceOf(ComposioConnector);
    expect(composioEntries).toEqual([handles.composio]);
    expect(health).toMatchObject({ composio: true });
  });

  it("reports no Composio connector without the env key", async () => {
    const { handles, publicHealth, health, composioEntries } = await start(undefined);
    expect(publicHealth).toEqual({ ok: true });
    expect(handles.composio).toBeUndefined();
    expect(composioEntries).toHaveLength(1);
    expect(composioEntries[0]).not.toBeInstanceOf(ComposioConnector);
    expect(health).toMatchObject({ composio: false });
  });
});
