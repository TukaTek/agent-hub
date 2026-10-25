# CAAH-102: Mobile Hub Microsoft SSO sign-in

## Why

In Hub mode mobile has only email and password. Entra users can't sign in on mobile at all, although CAAH-136 gave the API a native SSO handoff (`/api/auth/hub/sso/native/*`, capability `hubSsoNative`). This adopts it in the Expo app.

## Design

`continueWithHubSso(email)` in `apps/mobile/lib/hub-sso.ts`, next to `sso.ts` (Better Auth OIDC, which is a different flow and stays as is):

1. Capture `currentApiBase()` and `currentSessionGeneration()`. A second call while one is in flight returns `"busy"` and does nothing.
2. Generate the app PKCE pair with `expo-crypto`: 32 secure random bytes as a base64url verifier (43 characters), and its S256 challenge. The verifier lives only in this call's scope and leaves the device only in the complete request body.
3. `POST <apiBase>/api/auth/hub/sso/native/start` with `{ email, client: "mobile", returnTo: "cortexai-agent-hub://hub-sso", appChallenge }` and `origin: cortexai-agent-hub://`.
   - `{ next: "password" }` and `{ next: "other_sso_unavailable" }` are returned to the screen.
   - `{ next: "redirect", authorizeUrl, state }` continues; `authorizeUrl` must be HTTPS.
   - `403` with `HUB_SSO_ACCESS_DENIED` or `HUB_ACCESS_DENIED` is the access message; other failures use the existing auth error text (rate limit, unreachable, the server's own refusal message).
4. `openAuthSessionAsync(authorizeUrl, "cortexai-agent-hub://hub-sso", { preferEphemeralSession: true })`. `cancel`/`dismiss` returns `"cancelled"`.
5. Validate the returned URL: scheme `cortexai-agent-hub:`, host `hub-sso`, no path, userinfo or fragment, exactly one `state` equal to ours. Then `error=`: `sso_cancelled` returns `"cancelled"`, `hub_access_denied` is "You don't have access to Agent Hub. Ask your admin.", anything else (including unknown values) "Sign-in failed. Try again.". Otherwise exactly one non-empty `code`.
6. `POST native/complete` with `{ code, state, appVerifier }`. A `403` access refusal is the access message; any other failure (including "Your sign-in expired") is "Sign-in failed. Try again.". The token is read with `tokenFromAuthResponse`, like password sign-in.
7. Store exactly as SSO and password sign-in do: `clearSpace()` then `replaceSessionTokenIfCurrent(generation, token)` (SecureStore). The server and session are re-checked after start, after the browser, and before storing; a change returns `"cancelled"` and stores nothing, so a token from the previous server is never saved.

Nothing in this module logs. Breadcrumbs are already off (`maxBreadcrumbs: 0`).

Android delivers `cortexai-agent-hub://hub-sso?…` to the router too. `+native-intent` rewrites it to `/sign-in` without the query, so the code never reaches router state or an unmatched route.

### Sign-in screen

Hub mode with `hubSsoNative: true` asks for the email first, like web: Email and Continue. Continue calls `continueWithHubSso`:

- signed in: open the app;
- `password`: reveal the password field and Sign in (editing the email returns to the email step);
- `other_sso_unavailable`: the web copy, "Single sign-on for your organization isn't available in Agent Hub yet. Ask your admin to enable password sign-in for your account.";
- `cancelled`/`busy`: stay on the email step with no error;
- an error: show it under the email.

Microsoft opens directly from Continue, as on web; there is no separate "Continue with Microsoft" button, because the email already decided the method and iOS shows its own sign-in confirmation. Hub mode without `hubSsoNative` keeps today's email and password form unchanged.

### Sign-out and organization

Sign-out already revokes the session and clears SecureStore without touching the saved server URL; a test pins that.

The custom server entry ("Use a custom server") is shown only when `EXPO_PUBLIC_ALLOW_CUSTOM_SERVER` is `true`, or in development (`__DEV__`) unless it is `false`. Release builds (production, preview, OTA updates) hide it by default. The Android screenshot workflow sets it to `true`, because its Maestro flows open the server sheet. A build that hides the entry but still has a saved non-default server (from an earlier version) shows a quiet "Switch organization" action that resets to the build's default server (`resetApiBase`). That is the only path that clears a saved server besides the server sheet itself. Discovery (CAAH-101) is out of scope.

## Files

- `apps/mobile/package.json`, `pnpm-lock.yaml`: `expo-crypto` (SDK 57)
- `apps/mobile/lib/hub-sso.ts`, `hub-sso.test.ts`
- `apps/mobile/lib/custom-server.ts`, `custom-server.test.ts`
- `apps/mobile/app/sign-in.tsx`, `lib/sign-in.test.tsx`
- `apps/mobile/app/+native-intent.tsx`, `lib/settings-sheet.test.ts`
- `apps/mobile/lib/locales/{de,ru,zh}.ts`
- `apps/mobile/.maestro/hub-sso.yaml`
- `.github/workflows/mobile-android-screenshots.yml`
- `docs/hub-auth.md`

## Tests (vitest, offline)

- `hub-sso.test.ts` (expo-web-browser, expo-crypto, `./api`, `./session` mocked as in `sso.test.ts`): success stores the token through `replaceSessionTokenIfCurrent`; the start body carries the challenge and never the verifier, and the complete body carries the verifier; the challenge is the S256 of the verifier; wrong scheme, host, path, missing, wrong or duplicate state, missing or duplicate code store nothing; each `error=` value and an unknown one map as above; cancel and dismiss store nothing; `password` and `other_sso_unavailable` pass through; start and complete access refusals; concurrent calls start one attempt; a server or session change during start, the browser or complete stores nothing; no `console` call ever sees the token, code, verifier, state or callback URL.
- `sign-in.test.tsx`: hub mode with `hubSsoNative` shows the email step and routes each result; without it the password form is unchanged; the custom server entry and "Switch organization".
- `settings-sheet.test.ts`: `+native-intent` drops the handoff query.
- `custom-server.test.ts`: the flag's defaults.

Maestro `hub-sso.yaml` (not run here): against a Hub server with native SSO, Continue after an email opens the Microsoft sheet.
