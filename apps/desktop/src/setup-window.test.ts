// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  CortexAiAgentHubSetup,
  DesktopDiscoveryReply,
  DesktopSetupState,
} from "@cortexai-agent-hub/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const html = readFileSync(path.join(import.meta.dirname, "setup.html"), "utf8");
const script = readFileSync(path.join(import.meta.dirname, "setup.js"), "utf8");

function state(overrides: Partial<DesktopSetupState> = {}): DesktopSetupState {
  return {
    defaultLocalUrl: "http://127.0.0.1:45173",
    cloudUrl: null,
    showServerEntry: true,
    orgDiscovery: false,
    saved: null,
    ...overrides,
  };
}

async function openSetup(
  setupState: DesktopSetupState,
  discover: (email: string) => Promise<DesktopDiscoveryReply> = async () => ({ ok: true }),
) {
  document.documentElement.innerHTML = new DOMParser()
    .parseFromString(html, "text/html")
    .documentElement.innerHTML.replace(/<script[^>]*><\/script>/g, "");
  const bridge = {
    platform: "linux",
    state: vi.fn(async () => setupState),
    discover: vi.fn(discover),
    test: vi.fn(),
    save: vi.fn(async () => ({ ok: true })),
    quit: vi.fn(),
    openLink: vi.fn(),
    stack: {
      state: vi.fn(async () => ({ phase: "idle", message: null, output: [] })),
      start: vi.fn(),
      onChange: vi.fn(),
    },
  };
  (window as unknown as { cortexAiAgentHubSetup: CortexAiAgentHubSetup }).cortexAiAgentHubSetup =
    bridge as unknown as CortexAiAgentHubSetup;
  new Function(script)();
  await vi.waitFor(() => expect(bridge.state).toHaveBeenCalled());
  await flush();
  return bridge;
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const visible = (id: string) => {
  for (let node: HTMLElement | null = byId(id); node; node = node.parentElement)
    if (node.hidden) return false;
  return true;
};

async function submitEmail(email: string) {
  byId<HTMLInputElement>("work-email").value = email;
  byId<HTMLFormElement>("setup").dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("managed setup", () => {
  it("asks only for a work email", async () => {
    await openSetup(state({ showServerEntry: false, orgDiscovery: true }));
    expect(visible("work-email")).toBe(true);
    expect(visible("mode-new")).toBe(false);
    expect(visible("server-url")).toBe(false);
    expect(visible("check")).toBe(false);
    expect(document.activeElement?.id).toBe("work-email");
  });

  it("hands the email to main, which picks and opens the server", async () => {
    const bridge = await openSetup(state({ showServerEntry: false, orgDiscovery: true }));
    await submitEmail("  alice@acme.example ");
    expect(bridge.discover).toHaveBeenCalledWith("alice@acme.example");
    expect(bridge.save).not.toHaveBeenCalled();
  });

  it("shows the neutral not-found message", async () => {
    const error = "We couldn't find an Agent Hub for that email. Check with your admin.";
    await openSetup(state({ showServerEntry: false, orgDiscovery: true }), async () => ({
      ok: false,
      error,
    }));
    await submitEmail("alice@acme.example");
    expect(byId("status").textContent).toBe(error);
    expect(byId<HTMLButtonElement>("continue").disabled).toBe(false);
  });

  it("marks the email field invalid when the address is rejected", async () => {
    await openSetup(state({ showServerEntry: false, orgDiscovery: true }), async () => ({
      ok: false,
      field: "email",
      error: "Enter a valid email address.",
    }));
    await submitEmail("alice@acme.example");
    expect(byId("work-email").getAttribute("aria-invalid")).toBe("true");
    expect(byId("status").textContent).toBe("Enter a valid email address.");
  });

  it("rejects an empty email without calling main", async () => {
    const bridge = await openSetup(state({ showServerEntry: false, orgDiscovery: true }));
    await submitEmail("   ");
    expect(bridge.discover).not.toHaveBeenCalled();
    expect(byId("work-email").getAttribute("aria-invalid")).toBe("true");
  });

  it("holds Continue until Retry-After has passed", async () => {
    const bridge = await openSetup(
      state({ showServerEntry: false, orgDiscovery: true }),
      async () => ({
        ok: false,
        error: "Too many attempts. Try again in 30 seconds.",
        retryAfterSeconds: 30,
      }),
    );
    await submitEmail("alice@acme.example");
    expect(byId<HTMLButtonElement>("continue").disabled).toBe(true);
    await submitEmail("alice@acme.example");
    expect(bridge.discover).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(29_000);
    expect(byId<HTMLButtonElement>("continue").disabled).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(byId<HTMLButtonElement>("continue").disabled).toBe(false);
  });

  it("offers a retry when the sign-in service cannot be reached", async () => {
    const bridge = await openSetup(
      state({ showServerEntry: false, orgDiscovery: true }),
      async () => {
        throw new Error("ipc failed");
      },
    );
    await submitEmail("alice@acme.example");
    expect(byId("status").textContent).toBe("Can't reach the sign-in service. Try again.");
    expect(byId<HTMLButtonElement>("continue").disabled).toBe(false);
    await submitEmail("alice@acme.example");
    expect(bridge.discover).toHaveBeenCalledTimes(2);
  });

  it("shows why a saved organization could not be reopened", async () => {
    await openSetup(
      state({
        showServerEntry: false,
        orgDiscovery: true,
        error: "Could not reconnect to the saved server. Could not reach that address.",
      }),
    );
    expect(byId("status").textContent).toContain("Could not reconnect");
  });
});

describe("self-host setup", () => {
  it("keeps its server choices and never shows the email step", async () => {
    const bridge = await openSetup(state());
    expect(visible("work-email")).toBe(false);
    expect(visible("mode-new")).toBe(true);
    byId<HTMLInputElement>("mode-existing").checked = true;
    byId("mode-existing").dispatchEvent(new Event("change", { bubbles: true }));
    byId<HTMLInputElement>("server-url").value = "https://hub.acme.example";
    byId<HTMLFormElement>("setup").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(bridge.save).toHaveBeenCalledWith({
      mode: "existing",
      serverUrl: "https://hub.acme.example",
    });
    expect(bridge.discover).not.toHaveBeenCalled();
  });
});
