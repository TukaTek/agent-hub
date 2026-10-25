# CAAH-44: desktop Hub Microsoft (Entra) SSO through the system browser

## Why

On desktop, an Entra user on the email-first page gets `desktop_sso_unavailable`. Electron sends off-origin navigation to the system browser, and the web SSO flow finishes in that browser's cookie jar, not in the app. CAAH-136 added a native handoff on the API (`/api/auth/hub/sso/native/start` and `/complete`, capability `hubSsoNative`). This change adopts it on desktop with the system browser and a loopback redirect (RFC 8252). It doesn't use an Electron popup or a custom URL scheme.

## Flow

```
renderer (instance origin)        main                          system browser / API
 | Continue -> next: redirect     |                              |
 | (bridge has hubSso and         |                              |
 |  hubSsoNative) shows           |                              |
 |  "Continue with Microsoft"     |                              |
 | click: hubSso.start() -------> | new attempt: verifier,       |
 |                                |  S256 challenge, free port   |
 | <- { returnTo, appChallenge }  |  (memory only, 5 min timer)  |
 | POST native/start (same origin) ----------------------------> |
 | <- { next: redirect, authorizeUrl, state }                    |
 | hubSso.open(authorizeUrl, state) -> listen 127.0.0.1:<port>   |
 |                                |  /hub-sso, then openExternal |
 |                                | <- GET /hub-sso?code&state --|
 |                                |  (or ?error&state) once,     |
 |                                |  fixed "close this tab" page |
 | <- { code, state, appVerifier }|  listener closed             |
 | POST native/complete (same origin, cookie lands in partition) |
 | location.assign("/app")                                       |
```

## Design decisions

- **The renderer calls the API, main is only the transport.** The renderer already runs on the instance origin inside the instance's session partition, so its `fetch` carries the trusted `Origin`, and the session cookie from `native/complete` lands in the right partition with no cookie copying. Main would otherwise have to forge an `Origin` header and re-implement the bounded JSON handling and refusal codes the renderer already has. So the ticket's `desktop.hubSso.start(email)` becomes three IPC calls: `start()` (returns `returnTo` and `appChallenge`; main doesn't need the email), `open(authorizeUrl, state)` (resolves with the outcome), and `cancel()`.
- **The verifier only reaches the attempt's renderer.** The outcome is the return value of the `open` invoke, so it goes back only to the `webContents` that started the attempt. No broadcast `send`. `open` and `cancel` from any other sender are refused.
- **Sender check.** Every `desktop.hubSso.*` call must come from the main window's main frame, and the frame's origin must equal the origin of the instance that window loaded.
- **One attempt at a time.** A new `start` cancels the previous attempt, and its pending `open` resolves `cancelled`. The attempt ends on callback, cancel, a 5 minute timeout, renderer navigation, renderer destruction or app quit. Any of those closes the listener.
- **Loopback.** `openBrowserAuth` takes an explicit `callback: { url, state }` instead of reading `redirect_uri` from the authorize URL (Hub's authorize URL redirects to the API callback, not to us). The listener binds `127.0.0.1` only, accepts exactly one `GET /hub-sso` with the matching `Host`, a single `state` and either a single `code` or a single `error`, answers with `Cache-Control: no-store` and the fixed text "You can close this tab and return to CortexAI Agent Hub.", then closes. Wrong host, path, method, state or duplicates get a 400 and don't consume the attempt. The port is picked by binding `127.0.0.1:0` and releasing it, then bound again in `open`. If something takes it in between, `open` fails and the user retries.
- **PKCE.** The verifier is 32 random bytes in base64url (43 characters), and the challenge is its S256 digest. Both stay in main's memory for the attempt's lifetime. Codes, verifiers and states are never logged.
- **Errors.** The listener forwards `error=` values only when they look like a code (`[a-z_]{1,64}`). The renderer maps `hub_access_denied` to "You don't have access to Agent Hub — ask your admin", `sso_cancelled` to "Microsoft sign-in was cancelled.", and other known callback codes to the existing copy. Anything else gets the generic `sso_failed` copy. A timeout reports `sso_expired`. A user cancel shows no error. After an error, the Microsoft button reads "Retry", and "Use a different email" is the way back.
- **Degrades safely.** Without `hubSsoNative`, or with an older desktop build whose bridge has no `hubSso`, the page keeps today's `desktop_sso_unavailable` message. The browser path is unchanged.
- **Continue still runs first.** The Entra step comes from Continue, which on the web path also runs Hub's sso-start and sets the `__Host-ah_sso` cookie. That pending row just expires. Skipping Continue on desktop would need the API to answer Entra without starting, which is a server change outside this ticket.

## Locked product decisions

- *Saved server resets only on an explicit switch.* Already true. Signing out of the web UI never touches `setup.json`. Only the "Change CortexAI Agent Hub Server…" menu action opens setup to pick another server. No change.
- *Hide the advanced or self-hosted entry in managed builds.* There is no managed build yet: `CORTEXAI_AGENT_HUB_CLOUD_URL` is `null`, so every build is a dev or self-host build and setup must keep both entries. Adding the flag now would be an unused switch, so it lands with the managed build that sets the cloud URL. This needs confirming.

## Sign-out

The web sign-out deletes the Agent Hub session, and that revokes the Hub refresh token (`docs/hub-auth.md`, "Sign-out and fresh credentials"). Desktop uses the same web sign-out, so there's no change. Every native start adds `prompt=login`, so the next person at the machine is asked for credentials.

## Files

- `packages/contracts/src/desktop.ts`: optional `hubSso` bridge and result type
- `apps/desktop/src/browser-auth.ts`: explicit callback and `error=` forwarding
- `apps/desktop/src/hub-sso.ts`: attempt controller (PKCE, port, timeout, single attempt) and sender check
- `apps/desktop/src/main.ts`, `apps/desktop/src/preload.cjs`: IPC wiring
- `apps/web/src/pages/Auth.tsx`: Microsoft step, start, complete, error copy
- `docs/hub-auth.md`: desktop paragraph

## Tests

Desktop (`apps/desktop/src/*.test.ts`, vitest, real loopback sockets):

- `browser-auth.test.ts`: explicit callback URL used instead of `redirect_uri`; matching `error=` forwarded once; error and code together rejected; unsafe explicit callbacks rejected.
- `hub-sso.test.ts`: start returns a valid `returnTo` and a challenge that is the S256 of the verifier later returned; the listener accepts only the active state once and rejects wrong host, path, method and duplicate; a stale attempt's callback is ignored after a new start; cancel, timeout (fake timers) and sender destruction or navigation close the listener and resolve `cancelled` or `sso_expired`; `open` and `cancel` from another sender are refused; the sender check rejects a non-main-frame, another window and another origin.
- `preload.test.ts`: the bridge exposes `hubSso.start/open/cancel` on the right channels.

Web (`apps/web/src/pages/Auth.test.tsx`, jsdom):

- With the bridge and `hubSsoNative`, Continue's Entra answer shows "Continue with Microsoft" instead of `desktop_sso_unavailable`. A click runs start, `native/start`, open and `native/complete`, then navigates to `/app`.
- Without `hubSsoNative`, or with a bridge without `hubSso`, the unavailable message stays. The browser path still redirects.
- The three callback errors (`hub_access_denied`, `sso_cancelled`, `sso_failed`) show their copy and offer Retry. Cancel calls the bridge and shows no error.

The desktop Playwright suite is left to CI (AGENTS.md). The end-to-end check against a staging Hub needs a person and a GUI.
