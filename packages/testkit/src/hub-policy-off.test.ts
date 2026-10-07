import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import contract from "../../auth/src/fixtures/agent-hub-auth.v2.json" with { type: "json" };
import { hubAuthFromEnv } from "../../auth/src/hub-client.js";

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe : describe.skip;

const HUB = "https://hub.example.test";
// Hub sign-in only accepts the configured web origin.
const WEB = process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173";
const TERMINAL = ["completed", "failed", "cancelled"];

/** CAAH-83: Hub mode with HUB_POLICY_ENFORCEMENT=off and no Hub registration at all. */
describeIntegration("Hub mode without Hub registration (CAAH-83)", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let close: (() => Promise<void>) | undefined;
  const dataDir = mkdtempSync(path.join(tmpdir(), "cortexai-agent-hub-hub-policy-off-"));
  const subject = `policy-off-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const hubPaths: string[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== HUB) return realFetch(input, init);
      hubPaths.push(url.pathname);
      const tenantId = contract.sessionResponse.user.tenantId;
      if (url.pathname === "/api/tenant-auth/lookup")
        return Response.json({ tenantId, idpType: "native" });
      if (url.pathname === "/api/tenant-auth/session")
        return Response.json({ valid: true, userId: subject, tenantId });
      if (url.pathname === "/api/tenant-auth/config")
        return Response.json({
          product: "cortexai-agent-hub",
          products: contract.sessionResponse.products,
        });
      if (url.pathname === "/api/tenant-auth/login")
        return Response.json({
          ...contract.sessionResponse,
          // Hub access tokens last a day; the request signal times out at expiry.
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          user: { ...contract.sessionResponse.user, id: subject },
        });
      return Response.json({ error: "not_found" }, { status: 404 });
    });
    const source = {
      AUTH_MODE: "hub",
      HUB_AUTH_ORIGIN: HUB,
      HUB_POLICY_ENFORCEMENT: "off",
      DATABASE_URL: process.env.DATABASE_URL,
    };
    const { startApiHubPolicy } = await import("../../../apps/api/src/hub-policy.ts");
    const runtime = await startApiHubPolicy(source, logger);
    close = runtime?.close;
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      defaultProvider: "scripted",
      defaultModel: "scripted",
      hubAuth: hubAuthFromEnv(source),
      hubPolicy: runtime?.policy,
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await handles?.stop();
    await close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("starts with a warning and reports the disabled policy on health", async () => {
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("HUB_POLICY_ENFORCEMENT=off"),
      expect.objectContaining({ "hub.policy": "disabled" }),
    );
    expect(logger.error).not.toHaveBeenCalled();
    const health = await (await handles.app.request("/internal/health")).json();
    expect(health).toMatchObject({ ok: true, status: "ok", hubPolicy: { state: "disabled" } });
  });

  it("signs a Hub user in and runs their bot without reading Hub policy", async () => {
    const continued = await handles.app.request("/api/auth/hub/sign-in/continue", {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB },
      body: JSON.stringify({ email: "user@example.test" }),
    });
    expect(await continued.json()).toEqual({ next: "password" });
    const signIn = await handles.app.request("/api/auth/hub/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB },
      body: JSON.stringify({ email: "user@example.test", password: "synthetic-password" }),
    });
    expect(signIn.status).toBe(200);
    const token = /better-auth\.session_token=([^;]+)/.exec(
      signIn.headers.get("set-cookie") ?? "",
    )?.[1];
    expect(token).toBeTruthy();
    const cookie = `better-auth.session_token=${token}`;

    const bot = await rpc<{ id: string }>(cookie, "bots/create", {
      name: "Policy off",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    await waitForRuns(bot.id);
    const { runId } = await rpc<{ runId: string }>(cookie, "threads/send", {
      botId: bot.id,
      text: "hello",
    });
    await waitForRuns(bot.id);
    const run = await handles.prisma.run.findUniqueOrThrow({
      where: { id: runId },
      select: { status: true, error: true },
    });
    expect(run).toEqual({ status: "completed", error: null });
    expect(hubPaths).toContain("/api/tenant-auth/login");
    expect(hubPaths).toContain("/api/tenant-auth/session");
    expect(hubPaths.some((p) => p.startsWith("/api/agent-hub/"))).toBe(false);
  });

  async function waitForRuns(botId: string) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const runs = await handles.prisma.run.findMany({
        where: { botId },
        select: { status: true },
      });
      if (runs.every((run) => TERMINAL.includes(run.status))) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("timeout waiting for bot runs to finish");
  }

  async function rpc<T>(cookie: string, procedure: string, body: unknown = {}): Promise<T> {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB, cookie },
      body: JSON.stringify({ json: body }),
    });
    const payload = (await response.json()) as { json?: T; error?: { message?: string } };
    if (!response.ok || payload.error)
      throw new Error(payload.error?.message ?? `${procedure} failed (${response.status})`);
    return payload.json as T;
  }
});
