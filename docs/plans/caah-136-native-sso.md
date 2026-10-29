# CAAH-136: native Hub SSO handoff for desktop and mobile

## Why

Web Entra SSO works, but native apps can't use it. The callback requires the `__Host-ah_sso` cookie, which lives in the system browser that opened Microsoft, and success ends in a session cookie and a redirect to `/app` in that browser. Desktop shows `desktop_sso_unavailable`; mobile has only email and password in Hub mode.

## Design

Native apps reuse the same Hub channel (`agent-hub-web`) and redirect URI (`/api/auth/hub/sso/callback`). The API stays the confidential client: the Hub service credential, the Hub PKCE verifier, the Hub code exchange, the policy check and `completeHubGrant()` stay server-side. The app carries only a short-lived, single-use Agent Hub handoff code bound to a PKCE pair the app generated. No Hub token reaches the device, a URL, a log line or a response body.

```
app                      API                                   Hub / Entra
 | POST native/start ---> | gate + lookup (as Continue)          |
 |  {email, client,       | sso-start(state, S256(hubVerifier)) ->|
 |   returnTo,            | verification row (hashed state,       |
 |   appChallenge}        |   encrypted hubVerifier, 10 min)      |
 | <- {authorizeUrl,state}| hub_sso_native row (client, returnTo, |
 |                        |   appChallenge)          no cookie    |
 | system browser ------------------------------------------------>|
 |                        | <-- GET /hub/sso/callback?code&state  |
 |                        | native row found: app-PKCE binding    |
 |                        |   replaces the cookie check           |
 |                        | consume state, policy.check,          |
 |                        | ssoExchange, policy.admit             |
 |                        | grant encrypted on the native row     |
 |                        |   against SHA-256(handoff), TTL 60 s  |
 | <-- 302 returnTo?code=<handoff>&state=<state>                  |
 | POST native/complete ->| consume the row (one try), check      |
 |  {code,state,          |   state and S256(appVerifier) ==      |
 |   appVerifier}         |   appChallenge in constant time       |
 |                        | completeHubGrant -> session           |
 | <- desktop: cookie; mobile: {token (signed bearer), user}      |
```

### Start: `POST /api/auth/hub/sso/native/start`

Body `{ email, client: "desktop" | "mobile", returnTo, appChallenge }`. Registered only when `HUB_SSO_ENABLED` is on (like the callback).

- Trusted origin required (the desktop renderer runs on the instance origin; mobile sends `cortexai-agent-hub://`, already trusted).
- `returnTo` is matched against the raw string, never a normalized URL, so no parser leniency can widen it:
  - desktop: `^http://(127\.0\.0\.1|\[::1\]):<port>/hub-sso$`, port without leading zero and in 1024-65535. That rejects `localhost`, `127.0.0.2`, userinfo, query, fragment, backslashes, trailing slashes and anything else.
  - mobile: exactly `cortexai-agent-hub://hub-sso`.
  - Anything else, or a returnTo for the other client: `400`.
- `appChallenge`: exactly 43 base64url characters (an S256 digest).
- Then the same steps as Continue: Hub policy gate, Hub lookup, and for Entra the existing sso-start (same `agent-hub-web` channel, `HUB_DEPLOYMENT_ID`, `prompt=login` and `login_hint` added by the client). The shared part of Continue is extracted into one helper so web and native can't drift.
- Native and failed lookups and Always Native (`user_always_native` from sso-start) answer `{ next: "password" }`, Google answers `{ next: "other_sso_unavailable" }`; nothing is persisted.
- Entra answers `{ next: "redirect", authorizeUrl, state }` and sets no cookie. The `next` discriminant matches Continue's response, so clients branch the same way.
- Start-time Hub refusals keep Continue's codes (`403 HUB_SSO_ACCESS_DENIED`, `502`).

### Data model

New table `hub_sso_native` (additive migration; the previous release never reads it):

| column | meaning |
| --- | --- |
| `stateKey` (PK) | `hub-sso:<sha256(state)>`, the same key as the pending `verification` row |
| `client` | `desktop` or `mobile` |
| `returnTo` | the validated returnTo |
| `appChallenge` | the app's S256 challenge |
| `handoffHash` (unique, null until the callback succeeds) | SHA-256 hex of the handoff code |
| `grantCipher` (null until then) | the Hub grant, encrypted with the token encryption key |
| `expiresAt` | 10 minutes at start; 60 s from handoff issue |

The Hub PKCE verifier stays in the existing hashed, encrypted `verification` row. Better Auth owns that table, so the native fields live beside it rather than in it. Expired native rows are deleted (revoking any unredeemed grant at Hub, best effort) whenever a native sign-in starts, as expired web rows are.

During the side-by-side deploy window the previous release's callback finds no cookie for a native state and sends the browser to `/sign-in?error=sso_expired`, which is safe.

### Callback branch

Same path. If the query's state is well formed and a live native row exists for it, the native branch runs; otherwise the web branch runs unchanged, including the cookie check.

Native branch: a Hub error burns the state (verification and native rows) and redirects to `returnTo?error=<code>&state=<state>`, with Hub's reason mapped to a code the app can tell apart: `access_denied` (no Agent Hub assignment) is `hub_access_denied`, `login_cancelled` (the user cancelled Microsoft sign-in; proposed by Hub PM) is the new `sso_cancelled`, and anything else is `sso_failed`. The native codes are `NativeSsoCallbackError` in `packages/core/src/sign-in.ts`, which is `SsoCallbackError` plus `sso_cancelled`; `SsoCallbackError` itself is unchanged so web's copy table needs no new entry. The web branch keeps `/sign-in?error=sso_failed` for every Hub error. The log reason is `callback:idp_error:<mapped code>`, never Hub's raw value. Otherwise it consumes the verification row, runs `policy.check()`, exchanges once, then runs `policy.admit()` on the grant so an unassigned user is refused here and the grant is revoked at Hub. Only then is a 32-byte handoff code generated, its SHA-256 and the encrypted grant written to the row (conditional on no handoff yet), and the browser sent to `returnTo?code=<handoff>&state=<state>`. Every failure with a live native row redirects to `returnTo?error=<SsoCallbackError>&state=<state>`; failures without one keep `/sign-in?error=`. No user or session is created in the callback.

### Complete: `POST /api/auth/hub/sso/native/complete`

Body `{ code, state, appVerifier }` (code: 43 base64url; state: 16-256 base64url; verifier: RFC 7636, 43-128 unreserved characters). Trusted origin required.

1. Find the row by `SHA-256(code)` and delete it by key and hash; only the request whose delete removed it continues. So every handoff gets one try and a wrong verifier burns it.
2. Reject (400, same message for every case) when expired, when `SHA-256(state)` doesn't match the row's key, or when `S256(appVerifier)` doesn't equal `appChallenge` (both compared with `timingSafeEqual` on digests). A burned grant is revoked at Hub.
3. `policy.check()` and `completeHubGrant()` (which admits again, creates the user, session and encrypted `hub_session`, and sets the session cookie). Any failure revokes the grant; policy refusals keep their stable codes.
4. Desktop answers `{ user }` and relies on the HTTP-only cookie. Mobile answers `{ token, user }`; the existing after-hook swaps the raw token for the signed bearer, exactly as `/hub/sign-in` does today.

`/hub/sso/native/complete` joins `HUB_SESSION_PATHS` (it creates sessions); `/hub/sso/native/start` joins the `rejectHubAccountMutation` allowlist (it doesn't). Both share the Hub sign-in rate limit (30/min per address).

### Capabilities

`hubSso` stays a boolean, because today's mobile and web clients parse it strictly as one and would reject an object. The capability is a new optional sibling `hubSsoNative: boolean` (true when Hub SSO is on). This is the ticket's `hubSso.native` expressed without breaking older clients.

### Logging

Only fixed reason strings reach `onHubSsoError` (`native:start:…`, `callback:…`, `complete:…`). Handoff codes, app verifiers, state, Hub tokens and email are never logged; tests assert it.

## Files

- `packages/db/prisma/schema.prisma`, `packages/db/prisma/migrations/20261025120000_hub_sso_native/migration.sql`
- `packages/core/src/sign-in.ts`: `NativeSsoClient`, `NativeSsoStartResponse`, `NativeSsoCompleteResponse` types
- `packages/auth/src/hub.ts`: shared sso-start helper, native start, callback branch, complete, paths, rate limits
- `packages/auth/src/hub-native-sso.ts`: pure returnTo / challenge / verifier validation
- `packages/auth/src/fixtures/agent-hub-native-sso.v1.json`: synthetic start/complete contract
- `packages/contracts/src/auth.ts`, `apps/api/src/auth-capabilities.ts`: `hubSsoNative`
- `docs/hub-auth.md`: native section and staging check

## Tests

Unit (`packages/auth/src/hub-native-sso.test.ts`, in-memory adapter like `hub.test.ts`):

- returnTo allowlist: accepts both loopback forms at 1024 and 65535 and the mobile URI; rejects `localhost`, `127.0.0.2`, `0.0.0.0`, `[::2]`, ports 0/80/1023/65536/leading zero/none, userinfo, query, fragment, wrong path, trailing slash, backslash, encoded characters, whitespace, `https`, uppercase scheme/host variants, the other client's returnTo, non-strings.
- appChallenge: rejects 42/44 characters, non-base64url, padding.
- Start: Entra returns `{ next: "redirect", authorizeUrl, state }`, no cookie, verification + native rows, sso-start called with the S256 of the server verifier (not the app's challenge); native/Always Native/Google answers; untrusted origin; policy refusal; Hub start denial; 404 with SSO off.
- Callback: native success redirects to `returnTo?code&state`, no session or user yet, grant only encrypted; the web callback still requires its cookie; Hub's `access_denied`, `login_cancelled`, an unknown reason and an empty one map to `hub_access_denied`, `sso_cancelled` and `sso_failed` for both clients, burn the state and create nothing; the web callback keeps `sso_failed` for the same three reasons, with or without its cookie; rejected exchange, unassigned user (admit refusal, grant revoked) and policy refusal redirect to `returnTo?error=…&state=…` and create no user or session; unknown state stays on `/sign-in?error=`.
- Complete: desktop sets the cookie and returns no token; mobile returns a signed bearer that works; replay → 400 and no second session; wrong verifier burns the code (then the right one fails) and revokes the grant; wrong state → 400; expiry at 60 s (fake timers, 59 s ok / 60 s rejected); malformed bodies; untrusted origin; policy refusal at complete creates nothing.
- Logger: with a debug-level Better Auth `logger` in the fixture, native sign-ins through a wrong verifier, replays, session and handoff storage failures and an unexpected redeem error (which does reach the logger) never pass the handoff code, app verifier, Hub code, Hub tokens or service secret to it or to `onHubSsoError`.
- Contract fixture: `hubCallbackErrors` in `agent-hub-native-sso.v1.json` lists the Hub reason to native code mapping, checked for both clients.
- Secrets: handoff code, app verifier, state, Hub tokens and email never appear in logs, reason strings, Location headers (other than the handoff/state themselves) or response bodies.
- Contract fixture: the start and complete requests in `agent-hub-native-sso.v1.json` are accepted and their responses match the documented shape.
- Web flow: existing `hub.test.ts` SSO tests (CAAH-58) unchanged and green.

Postgres (`packages/auth/src/hub.postgres.test.ts`, skipped unless `VERIFY_DATABASE=1` and `DATABASE_URL`): native desktop and mobile flows against the real adapter and migration; replay and wrong-verifier burn leave one session; a denied exchange creates no user or session; Hub tokens are present only encrypted in `hub_session`, and the native row is gone after redemption.

API: `apps/api/src/auth-capabilities.test.ts` reports `hubSsoNative`.

## Verification

Run on a development machine without PostgreSQL:

- `pnpm --filter @cortexai-agent-hub/db generate`: regenerated the Prisma client for `hub_sso_native`.
- `pnpm --filter @cortexai-agent-hub/auth --filter @cortexai-agent-hub/core --filter @cortexai-agent-hub/contracts --filter @cortexai-agent-hub/db --filter ./apps/api check`: all five typecheck cleanly.
- `pnpm lint` (Biome over the repository): no errors. The six warnings it reports are in files this change doesn't touch (`apps/desktop/e2e/setup.spec.ts`, `infra/updater/src/compose-dev-proxy.test.ts`).
- `pnpm --filter @cortexai-agent-hub/auth test`: 15 files pass, with 743 tests passing and 16 skipped. The skipped tests are the PostgreSQL suites. All the CAAH-58 web SSO tests in `hub.test.ts` pass unchanged. The new native tests (88 validator cases in `hub-native-sso.test.ts`, plus 61 endpoint cases and two rate-limit cases in `hub.test.ts`) were run first against the unimplemented endpoints and failed, then passed once the endpoints were in.
- `pnpm exec vitest run packages/auth/src packages/contracts/src packages/core/src apps/api/src/auth-capabilities.test.ts apps/mobile/lib apps/web/src/pages`: 344 files pass, with 4780 tests passing and 18 skipped (the PostgreSQL suites). This includes the mobile capability parsing tests, which still accept the new optional `hubSsoNative` field.
- Follow-up (Hub callback errors and logger test): the native error-mapping tests were run first and failed for both clients and all four reasons while the web ones already passed; then the mapping went in. A mutation check (leaking the handoff code into a `complete:` reason) made the new logger test fail, and it passed again once reverted. Afterwards `pnpm lint` reported no errors (the same six warnings in untouched files). `check` typechecked auth, core, contracts, api and web cleanly. `pnpm exec vitest run packages/auth/src` passed 15 files with 760 tests passing and 17 skipped, the PostgreSQL suites. The broader run above passed 344 files with 4797 tests passing and 18 skipped. `pnpm --filter @cortexai-agent-hub/auth test` passed too, but it ran only 13 of the 16 files it found (631 tests passing). That's how the package script resolves its root, and this change doesn't affect it; the root-level run is the complete one.
- PostgreSQL: the new case in `packages/auth/src/hub.postgres.test.ts` ("finishes native desktop and mobile SSO through a single-use handoff") was **skipped**. No PostgreSQL server is available here, and the suite only runs with `VERIFY_DATABASE=1` and `DATABASE_URL`. To run it, apply the migrations first (`pnpm --filter @cortexai-agent-hub/db migrate`), then run `VERIFY_DATABASE=1 DATABASE_URL=<postgres url> pnpm exec vitest run packages/auth/src/hub.postgres.test.ts`. CI's database job runs it.
- The desktop Playwright e2e suite was not run (it isn't affected, and AGENTS.md says to leave it to CI).
- The staging check is still to do, by a person, against a staging Hub. The steps are in `docs/hub-auth.md` under "Staging check".
