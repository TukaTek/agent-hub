import { createServer, type Server } from "node:http";
import type { CortexAiAgentHubDesktopOAuthCallback } from "@cortexai-agent-hub/contracts";
import { LOOPBACK_HOSTS } from "./oauth-callback.js";

/** A callback `error=` value that looks like a code; anything else is rejected unread. */
const CALLBACK_ERROR = /^[a-z_]{1,64}$/;

/** Native transport only: providers still own PKCE, token exchange and persistence. */
export async function openBrowserAuth(
  authorizationUrl: string,
  options: {
    signal: AbortSignal;
    openExternal: (url: string) => Promise<unknown>;
    onCallback: (callback: CortexAiAgentHubDesktopOAuthCallback) => void;
    onClose?: () => void;
    /**
     * The loopback URL and state to wait for when the authorize URL's own
     * redirect_uri is not this app (Hub SSO redirects to the API first).
     * Only 127.0.0.1 and [::1] are accepted.
     */
    callback?: { url: string; state: string };
    /** Consumes a matching `error=` callback instead of rejecting it. */
    onError?: (error: string) => void;
  },
): Promise<void> {
  const url = new URL(authorizationUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Sign-in requires an HTTPS URL.");
  }
  const redirect = options.callback ? options.callback.url : url.searchParams.get("redirect_uri");
  const servers: Server[] = [];
  let closed = false;
  const close = () => {
    options.signal.removeEventListener("abort", close);
    for (const server of servers) {
      server.close();
      server.closeAllConnections();
    }
    if (!closed) {
      closed = true;
      options.onClose?.();
    }
  };
  options.signal.throwIfAborted();
  options.signal.addEventListener("abort", close, { once: true });
  try {
    if (redirect) {
      const callback = new URL(redirect);
      const state = options.callback ? options.callback.state : url.searchParams.get("state");
      if (
        callback.protocol !== "http:" ||
        !LOOPBACK_HOSTS.has(callback.hostname) ||
        (options.callback && callback.hostname === "localhost") ||
        callback.username ||
        callback.password ||
        callback.search ||
        callback.hash ||
        !callback.port ||
        Number(callback.port) < 1024 ||
        !state
      ) {
        throw new Error("Sign-in requires a loopback redirect and state.");
      }
      let consumed = false;
      // localhost may resolve to either family; bind whichever is available.
      const hosts =
        callback.hostname === "localhost"
          ? ["127.0.0.1", "::1"]
          : [callback.hostname === "[::1]" ? "::1" : callback.hostname];
      for (const host of hosts) {
        options.signal.throwIfAborted();
        const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("Content-Type", "text/plain; charset=utf-8");
          response.setHeader("Referrer-Policy", "no-referrer");
          response.setHeader(
            "Content-Security-Policy",
            "default-src 'none'; frame-ancestors 'none'",
          );
          if (!URL.canParse(request.url ?? "/", callback.origin)) {
            response.writeHead(400).end();
            return;
          }
          const target = new URL(request.url ?? "/", callback.origin);
          const params = target.searchParams;
          const code = params.get("code");
          const error = params.get("error");
          const isCode = params.getAll("code").length === 1 && !!code && !params.has("error");
          const isError =
            options.onError !== undefined &&
            params.getAll("error").length === 1 &&
            CALLBACK_ERROR.test(error ?? "") &&
            !params.has("code");
          if (
            consumed ||
            request.method !== "GET" ||
            request.headers.host !== callback.host ||
            target.origin !== callback.origin ||
            target.pathname !== callback.pathname ||
            params.getAll("state").length !== 1 ||
            params.get("state") !== state ||
            !(isCode || isError)
          ) {
            response
              .writeHead(400)
              .end("Sign-in callback rejected. Return to CortexAI Agent Hub to retry.");
            return;
          }
          consumed = true;
          response.end("You can close this tab and return to CortexAI Agent Hub.", close);
          if (isCode && code) options.onCallback({ code, state });
          else if (error) options.onError?.(error);
        });
        server.requestTimeout = 10_000;
        server.headersTimeout = 10_000;
        try {
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(Number(callback.port), host, () => {
              // Cancellation may have happened while listen was resolving.
              if (options.signal.aborted) {
                close();
                reject(new Error("Sign-in cancelled."));
              } else resolve();
            });
          });
          servers.push(server);
        } catch (error) {
          server.close();
          server.closeAllConnections();
          const code = (error as NodeJS.ErrnoException).code;
          // Skip a disabled address family; still fail on conflicts like EADDRINUSE
          // so a localhost redirect cannot land on another process's listener.
          if (
            callback.hostname !== "localhost" ||
            (code !== "EAFNOSUPPORT" && code !== "EADDRNOTAVAIL")
          )
            throw error;
        }
      }
      if (servers.length === 0) {
        throw new Error("No loopback address is available.");
      }
    }
    options.signal.throwIfAborted();
    await options.openExternal(url.href);
    if (!redirect) close();
  } catch (error) {
    close();
    throw error;
  }
}
