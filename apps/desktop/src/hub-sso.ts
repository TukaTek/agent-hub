import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { DesktopHubSsoResult } from "@cortexai-agent-hub/contracts";
import { openBrowserAuth } from "./browser-auth.js";

export const HUB_SSO_TIMEOUT_MS = 5 * 60_000;

type SenderEvent = "destroyed" | "did-navigate";
/** The slice of `WebContents` an attempt is bound to. */
export interface HubSsoSender {
  once(event: SenderEvent, listener: () => void): unknown;
  removeListener(event: SenderEvent, listener: () => void): unknown;
}

interface Attempt {
  sender: HubSsoSender;
  verifier: string;
  returnTo: string;
  controller: AbortController;
  opened: boolean;
  outcome: Promise<DesktopHubSsoResult>;
  settle: (result: DesktopHubSsoResult) => void;
}

/** A free port on 127.0.0.1; the listener binds it again when the browser opens. */
async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string" || address.port < 1024)
    throw new Error("No loopback port is available.");
  return address.port;
}

/**
 * Native transport for Hub SSO (CAAH-44): the renderer calls the API on its own
 * origin, main holds the app PKCE verifier and the loopback listener. One attempt
 * is active at a time; its outcome, including the verifier, is only ever returned
 * to the sender that started it. Codes and verifiers are never logged.
 */
export function createHubSso(options: {
  openExternal: (url: string) => Promise<unknown>;
  timeoutMs?: number;
}) {
  let active: Attempt | undefined;

  const end = (attempt: Attempt, result: DesktopHubSsoResult) => {
    attempt.settle(result);
    attempt.controller.abort();
  };

  return {
    async start(sender: HubSsoSender): Promise<{ returnTo: string; appChallenge: string }> {
      if (active) end(active, { error: "cancelled" });
      const port = await freeLoopbackPort();
      const verifier = randomBytes(32).toString("base64url");
      const controller = new AbortController();
      let settle!: (result: DesktopHubSsoResult) => void;
      const outcome = new Promise<DesktopHubSsoResult>((resolve) => {
        settle = resolve;
      });
      const attempt: Attempt = {
        sender,
        verifier,
        returnTo: `http://127.0.0.1:${port}/hub-sso`,
        controller,
        opened: false,
        outcome,
        settle,
      };
      // A start racing this one may already have replaced it.
      if (active) end(active, { error: "cancelled" });
      active = attempt;
      const cancel = () => end(attempt, { error: "cancelled" });
      const expiry = setTimeout(
        () => end(attempt, { error: "sso_expired" }),
        options.timeoutMs ?? HUB_SSO_TIMEOUT_MS,
      );
      expiry.unref?.();
      sender.once("destroyed", cancel);
      sender.once("did-navigate", cancel);
      controller.signal.addEventListener(
        "abort",
        () => {
          attempt.settle({ error: "cancelled" });
          clearTimeout(expiry);
          sender.removeListener("destroyed", cancel);
          sender.removeListener("did-navigate", cancel);
          if (active === attempt) active = undefined;
        },
        { once: true },
      );
      return {
        returnTo: attempt.returnTo,
        appChallenge: createHash("sha256").update(verifier).digest("base64url"),
      };
    },

    async open(
      sender: HubSsoSender,
      authorizeUrl: unknown,
      state: unknown,
    ): Promise<DesktopHubSsoResult> {
      const attempt = active;
      if (
        !attempt ||
        attempt.sender !== sender ||
        attempt.opened ||
        typeof authorizeUrl !== "string" ||
        authorizeUrl.length > 16_384 ||
        typeof state !== "string" ||
        state.length === 0 ||
        state.length > 512
      )
        throw new Error("No sign-in attempt is active.");
      attempt.opened = true;
      try {
        await openBrowserAuth(authorizeUrl, {
          signal: attempt.controller.signal,
          callback: { url: attempt.returnTo, state },
          openExternal: options.openExternal,
          onCallback: ({ code }) => end(attempt, { code, state, appVerifier: attempt.verifier }),
          onError: (error) => end(attempt, { error }),
        });
      } catch {
        end(attempt, { error: "cancelled" });
        throw new Error("Could not open browser sign-in.");
      }
      return attempt.outcome;
    },

    cancel(sender: HubSsoSender) {
      if (active?.sender === sender) end(active, { error: "cancelled" });
    },

    dispose() {
      if (active) end(active, { error: "cancelled" });
    },
  };
}

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Hub SSO IPC answers only the app window's main frame, on the origin of the
 * instance that window loaded. `appUrl` is undefined for any other window.
 */
export function isTrustedAppFrame(
  event: { sender: { mainFrame: unknown }; senderFrame: { url: string } | null },
  appUrl: string | undefined,
): boolean {
  if (appUrl === undefined || !event.senderFrame || event.senderFrame !== event.sender.mainFrame)
    return false;
  const origin = originOf(event.senderFrame.url);
  return origin !== null && origin === originOf(appUrl);
}
