import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { get } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHubSso, HUB_SSO_TIMEOUT_MS, isTrustedAppFrame } from "./hub-sso.js";

const AUTHORIZE = "https://hub.example.test/authorize?redirect_uri=https%3A%2F%2Fapi.example.test";
const RETURN_TO = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})\/hub-sso$/;

class Sender extends EventEmitter {
  destroyed = false;
  isDestroyed() {
    return this.destroyed;
  }
}

const controllers: Array<ReturnType<typeof createHubSso>> = [];
afterEach(() => {
  for (const controller of controllers) controller.dispose();
  controllers.length = 0;
});

function setup() {
  const openExternal = vi.fn(async (_url: string) => undefined);
  const hubSso = createHubSso({ openExternal });
  controllers.push(hubSso);
  return { hubSso, openExternal, sender: new Sender() };
}

function status(url: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<number | undefined>((resolve, reject) => {
    get(url, { headers, method }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
}

describe("desktop Hub SSO attempts", () => {
  it("returns a loopback returnTo and the S256 challenge of the verifier it hands back", async () => {
    const { hubSso, openExternal, sender } = setup();
    const { returnTo, appChallenge } = await hubSso.start(sender);
    expect(returnTo).toMatch(RETURN_TO);
    expect(appChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const outcome = hubSso.open(sender, AUTHORIZE, "attempt-state");
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith(AUTHORIZE));
    expect(await status(`${returnTo}?code=handoff&state=attempt-state`)).toBe(200);
    const result = await outcome;
    expect(result).toMatchObject({ code: "handoff", state: "attempt-state" });
    const { appVerifier } = result as { appVerifier: string };
    expect(appVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createHash("sha256").update(appVerifier).digest("base64url")).toBe(appChallenge);
  });

  it("accepts only the active state once and rejects wrong host, path, method and duplicates", async () => {
    const { hubSso, sender } = setup();
    const { returnTo } = await hubSso.start(sender);
    const outcome = hubSso.open(sender, AUTHORIZE, "attempt-state");
    await vi.waitFor(async () => expect(await status(`${returnTo}?state=x`)).toBe(400));
    const host = new URL(returnTo).host;
    expect(await status(`${returnTo}?code=x&state=other`)).toBe(400);
    expect(await status(`${returnTo}?code=x&state=attempt-state`, { Host: "evil.example" })).toBe(
      400,
    );
    expect(
      await status(`${returnTo}?code=x&state=attempt-state`, {
        Host: `localhost:${new URL(returnTo).port}`,
      }),
    ).toBe(400);
    expect(
      await status(`${returnTo.replace("/hub-sso", "/other")}?code=x&state=attempt-state`),
    ).toBe(400);
    expect(await status(`${returnTo}?code=x&state=attempt-state`, { Host: host }, "POST")).toBe(
      400,
    );
    expect(await status(`${returnTo}?code=x&code=y&state=attempt-state`)).toBe(400);
    expect(await status(`${returnTo}?code=x&state=attempt-state`)).toBe(200);
    await expect(outcome).resolves.toMatchObject({ code: "x" });
    await expect(status(`${returnTo}?code=x&state=attempt-state`)).rejects.toThrow();
  });

  it.each(["hub_access_denied", "sso_cancelled", "sso_failed"])(
    "resolves the callback's %s error without a verifier",
    async (error) => {
      const { hubSso, sender } = setup();
      const { returnTo } = await hubSso.start(sender);
      const outcome = hubSso.open(sender, AUTHORIZE, "attempt-state");
      await vi.waitFor(async () =>
        expect(await status(`${returnTo}?error=${error}&state=attempt-state`)).toBe(200),
      );
      expect(await outcome).toEqual({ error });
    },
  );

  it("ignores a stale attempt's callback once a new attempt starts", async () => {
    const { hubSso, sender } = setup();
    const first = await hubSso.start(sender);
    const firstOutcome = hubSso.open(sender, AUTHORIZE, "first-state");
    await vi.waitFor(async () => expect(await status(`${first.returnTo}?state=x`)).toBe(400));
    const second = await hubSso.start(sender);
    await expect(firstOutcome).resolves.toEqual({ error: "cancelled" });
    await expect(status(`${first.returnTo}?code=x&state=first-state`)).rejects.toThrow();
    expect(second.appChallenge).not.toBe(first.appChallenge);
  });

  it("closes the listener on cancel", async () => {
    const { hubSso, sender } = setup();
    const { returnTo } = await hubSso.start(sender);
    const outcome = hubSso.open(sender, AUTHORIZE, "attempt-state");
    await vi.waitFor(async () => expect(await status(`${returnTo}?state=x`)).toBe(400));
    hubSso.cancel(sender);
    await expect(outcome).resolves.toEqual({ error: "cancelled" });
    await expect(status(`${returnTo}?code=x&state=attempt-state`)).rejects.toThrow();
  });

  it.each(["destroyed", "did-navigate"])(
    "closes the listener when the renderer is %s",
    async (event) => {
      const { hubSso, sender } = setup();
      const { returnTo } = await hubSso.start(sender);
      const outcome = hubSso.open(sender, AUTHORIZE, "attempt-state");
      await vi.waitFor(async () => expect(await status(`${returnTo}?state=x`)).toBe(400));
      sender.emit(event);
      await expect(outcome).resolves.toEqual({ error: "cancelled" });
      await expect(status(`${returnTo}?code=x&state=attempt-state`)).rejects.toThrow();
      expect(sender.listenerCount("destroyed") + sender.listenerCount("did-navigate")).toBe(0);
    },
  );

  it("times out and closes the listener", async () => {
    // Fake timers would also drive Node's HTTP server timers, so use a short real one.
    const hubSso = createHubSso({ openExternal: vi.fn(async () => undefined), timeoutMs: 300 });
    controllers.push(hubSso);
    const sender = new Sender();
    const started = Date.now();
    const { returnTo } = await hubSso.start(sender);
    const outcome = hubSso.open(sender, AUTHORIZE, "attempt-state");
    await vi.waitFor(async () => expect(await status(`${returnTo}?state=x`)).toBe(400));
    await expect(outcome).resolves.toEqual({ error: "sso_expired" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    await expect(status(`${returnTo}?code=x&state=attempt-state`)).rejects.toThrow();
    expect(HUB_SSO_TIMEOUT_MS).toBe(5 * 60_000);
  });

  it("gives the verifier only to the renderer that started the attempt", async () => {
    const { hubSso, openExternal, sender } = setup();
    const other = new Sender();
    await hubSso.start(sender);
    await expect(hubSso.open(other, AUTHORIZE, "attempt-state")).rejects.toThrow();
    hubSso.cancel(other);
    expect(openExternal).not.toHaveBeenCalled();
    const { returnTo } = await hubSso.start(sender);
    const outcome = hubSso.open(sender, AUTHORIZE, "attempt-state");
    await expect(hubSso.open(sender, AUTHORIZE, "attempt-state")).rejects.toThrow();
    await vi.waitFor(async () =>
      expect(await status(`${returnTo}?code=x&state=attempt-state`)).toBe(200),
    );
    await expect(outcome).resolves.toMatchObject({ code: "x" });
  });

  it("refuses to open without a started attempt or with a bad authorize URL", async () => {
    const { hubSso, openExternal, sender } = setup();
    await expect(hubSso.open(sender, AUTHORIZE, "attempt-state")).rejects.toThrow();
    await hubSso.start(sender);
    await expect(hubSso.open(sender, "http://hub.example.test/authorize", "s")).rejects.toThrow();
    await hubSso.start(sender);
    await expect(hubSso.open(sender, AUTHORIZE, "")).rejects.toThrow();
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe("Hub SSO sender check", () => {
  const mainFrame = { url: "https://agent-hub.example.test/sign-in" };
  const appUrl = "https://agent-hub.example.test/";

  it("accepts the main frame on the instance origin", () => {
    expect(isTrustedAppFrame({ sender: { mainFrame }, senderFrame: mainFrame }, appUrl)).toBe(true);
  });

  it.each([
    ["a subframe", { url: "https://agent-hub.example.test/frame" }, appUrl],
    ["a missing frame", null, appUrl],
    ["another window", mainFrame, undefined],
  ])("rejects %s", (_name, senderFrame, target) => {
    expect(isTrustedAppFrame({ sender: { mainFrame }, senderFrame }, target)).toBe(false);
  });

  it.each([
    "https://evil.example.test/sign-in",
    "http://agent-hub.example.test/sign-in",
    "https://agent-hub.example.test:8443/sign-in",
    "file:///sign-in",
  ])("rejects a main frame on another origin: %s", (url) => {
    const frame = { url };
    expect(isTrustedAppFrame({ sender: { mainFrame: frame }, senderFrame: frame }, appUrl)).toBe(
      false,
    );
  });
});
