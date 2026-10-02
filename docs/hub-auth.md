# CortexAI Hub authentication

Set `AUTH_MODE=hub`, `HUB_AUTH_ORIGIN=https://hub.example.test` and `HUB_AUTH_TENANT_ID`. The origin is server configuration, never a login input. The tenant pins the deployment to the one tenant whose Agent Hub policy it uses (see [Hub policy](#hub-policy)). The API also needs `HUB_SERVICE_API_ID` and `HUB_SERVICE_SECRET_FILE` to read that policy, whether or not SSO is enabled. OAuth client credentials, audience and callback registration are not required.

Web and the shared desktop renderer ask for the email first, like Workbench. `POST /api/auth/hub/sign-in/continue` runs the same `/api/tenant-auth/lookup` that password sign-in uses. It answers `{ "next": "password" }` for native sign-in, `{ "next": "sso_unavailable" }` for Entra, and `{ "next": "other_sso_unavailable" }` for Google. Hub resolves an unprovisioned email by its domain when the domain belongs to a configured tenant, so that email follows the tenant's IdP. Other-tenant, invalid and failed lookups get the same password response as native users. The response can reveal an Always Native override within an SSO tenant. Mobile keeps its single email/password form. Agent Hub's server signs in through `/api/tenant-auth/login` and verifies the authenticated identity and Agent Hub product entitlement. Non-native tenant IdPs are currently unsupported, matching Workbench; Always Native users sign in with their password.

Hub's lookup resolves a tenant's SSO setting together with each user's native override: an Always Native user in an Entra tenant is reported as `idpType: "native"`, so Agent Hub needs no flag of its own. Local signup/password operations stay disabled in Hub mode. Passwords are forwarded only for login and never persisted.

The v2 contract fixture is `packages/auth/src/fixtures/agent-hub-auth.v2.json`. All fixture values are synthetic. Users must be active, their tenant and the CAIA product must be active, the tenant must enable it, and the user must have an explicit Agent Hub assignment. Stable ownership uses the trusted Hub origin plus tenant ID and user ID. Existing local users are never linked by email and Hub users do not automatically become deployment owners.

Opaque Hub access and refresh tokens are encrypted in server-side `hub_session` rows. Web clients use Agent Hub's own HTTP-only session cookie; mobile stores its own app session in secure storage. Hub configuration may contain provider credentials and is consumed only server-side for authorization. It is never returned as login state.

Every protected session/work authorization checks current identity and `/api/tenant-auth/config?product=cortexai-agent-hub`. Successful verifications are cached for a short TTL (default 30 seconds, configurable via `HUB_VERIFY_CACHE_TTL_MS`) to avoid Hub round-trips on every protected RPC while preserving fail-closed semantics. The cache keys by access token and respects both the configured TTL and the token's actual expiry time. Cache entries are invalidated when tokens are refreshed or rotated. Failures always deny access and are never cached. Expired tokens refresh through `/api/tenant-auth/refresh` under a database row lock; refresh must preserve user and tenant identity. Session deletion attempts `/api/tenant-auth/revoke` and always removes the local session. Hub access tokens currently last 24 hours and rotating refresh tokens 30 days.

## Entra SSO

`HUB_SSO_ENABLED` defaults to `false`. When it is off, sign-in behaves as described above: Entra users see the unavailable message and Always Native users use their password.

With `HUB_SSO_ENABLED=true` the API refuses to start unless all of these are set:

| Variable | Value |
| --- | --- |
| `AUTH_MODE` | `hub` |
| `HUB_AUTH_ORIGIN` | Hub's HTTPS origin |
| `HUB_AUTH_TENANT_ID` | The one tenant this deployment serves (up to 256 characters) |
| `HUB_DEPLOYMENT_ID` | The deployment UUID Hub issued for this installation, registered against the same credential as `HUB_SERVICE_API_ID` |
| `HUB_SERVICE_API_ID` | The service credential's API id (up to 256 characters) |
| `HUB_SERVICE_SECRET_FILE` | Path to a file holding the service credential's secret (up to 4096 characters, trimmed) |
| `BETTER_AUTH_URL` | This deployment's HTTPS origin, the same origin as `WEB_ORIGIN` |

The secret is read from a file so it never sits in the process environment or `.env`. Hub must register `HUB_DEPLOYMENT_ID` against the same credential as `HUB_SERVICE_API_ID`: for the `agent-hub-web` channel, sso-start and sso-exchange reject any service token whose credential differs from the deployment's registered product credential with `401 invalid_service_token`, which shows up as a start failure at Continue. The callback URL registered with Hub for the deployment is `<BETTER_AUTH_URL>/api/auth/hub/sso/callback`.

The flow follows Hub's `agent-hub-web-sso.v1` contract, copied verbatim to `packages/auth/src/fixtures/agent-hub-web-sso.v1.json`:

1. The email step's lookup reports Entra. Agent Hub generates a random state and PKCE verifier, stores the verifier encrypted in a `verification` row keyed by the SHA-256 of the state (10 minutes), sets the state in an HttpOnly `__Host-ah_sso` cookie, and calls `POST /api/tenant-auth/sso-start` with its service token, the `agent-hub-web` return channel, the deployment id, the state and the S256 challenge. The browser follows the returned `authorizeUrl`.
2. Hub redirects to the callback with `code` and `state`. Agent Hub requires the cookie's state to match the query in constant time, deletes the verification row (so a state works once), and calls `POST /api/agent-hub/sso-exchange` once. Hub consumes the code on every attempt, so the exchange is never retried.
3. The grant must name the configured tenant and deployment. It then goes through the same entitlement check, `hub_<tenant>_<user>` identity and encrypted `hub_session` as password sign-in, so a user who signs in both ways has one account.

Failures land on `/sign-in?error=sso_expired` (a malformed callback, or a missing, mismatched, unknown or expired state) or `/sign-in?error=sso_failed` (a rejected exchange or grant), and the page shows a fixed message for each. Nothing else from the query is displayed. When Hub's sso-start refuses the user with `access_denied`, `product_not_enabled` or `tenant_mismatch`, Continue answers `403` with code `HUB_SSO_ACCESS_DENIED` and the email step shows the same `sso_failed` message; other start failures stay `502` "Could not continue". Logs carry a short reason code only; codes, state, verifiers, tokens, emails and the service secret are never logged. Errors Hub shows on its own `/tenant-sso-error` page stay there.

**Service token.** The API process sends `POST /api/agent-hub/service-token` with exactly `{ "apiId", "secret", "tenantId" }`, with `tenantId` set to `HUB_AUTH_TENANT_ID`. Hub's schema is strict, so any other field is `400 invalid_request`. Hub answers `{ "token", "tokenType": "Bearer", "expiresIn": 300 }`. Agent Hub treats the token as opaque and sends it as `Authorization: Bearer <token>` to sso-start and sso-exchange. The token is cached in memory for the pinned tenant and renewed 45 seconds before it expires. Concurrent renewals share one request, which keeps Agent Hub well under Hub's limit of 60 renewals a minute per credential and tenant.

When Hub returns `401 invalid_service_token`, the cached token is dropped. A start is retried once with a fresh token. An exchange is never retried, because Hub consumes the code on every attempt, so the callback fails with `sso_failed`. Token endpoint failures (`400 invalid_request`, `401 invalid_credentials`, a grant or binding denial for the tenant, `429` rate limits, or `503 configuration_unavailable`) fail the attempt and are logged only as a reason code such as `start:invalid_credentials`. Hub also rate limits failed attempts to 10 per 15 minutes, so a wrong secret soon starts returning `429` as well. The secret and the token are never logged.

**Rate limits.** `/hub/sign-in/continue` and `/hub/sign-in` each allow 30 requests a minute per client address; Hub keeps its own login lockout. Better Auth reads the address from `X-Forwarded-For` and trusts it only when it holds one value. `infra/compose/Caddyfile.prod` sends exactly one: the real client's address when a same-host front proxy such as Tailscale serve connects from loopback or the Docker bridge, and otherwise Caddy's peer. A front proxy that connects from another address, or the Cloudflare example (whose peer is a Cloudflare edge), makes users share that address's budget. The limit is loose so that this slows sign-in rather than locking a team out. Expired SSO rows are deleted whenever a new SSO sign-in starts.

**Break-glass.** If Entra or Hub SSO is unavailable, set the affected users to Always Native in Hub. The lookup then reports them as native and they sign in with their password, with or without `HUB_SSO_ENABLED`. Setting `HUB_SSO_ENABLED=false` returns everyone to the pre-SSO behaviour.

**Sessions and revocation.** SSO sessions are the same Hub sessions as password sign-in: 24-hour access tokens and 30-day rotating refresh tokens. Revoking a user or their assignment in Hub takes effect within the verification cache TTL plus one request, as described below. If Hub's session reports a product or deployment, it must be Agent Hub and this deployment; set `HUB_DEPLOYMENT_ID` whenever Hub has issued one, even with SSO off, or deployment-bound sessions are refused.

**Sign-out and fresh credentials.** Signing out deletes the Agent Hub session and revokes its Hub refresh token, so nothing in Agent Hub can resume it. The browser can still hold a Microsoft session, though, and Microsoft would otherwise sign the next person at a shared machine straight back in. Hub's sso-start has no field for this yet. When Hub's `authorizeUrl` is a direct OIDC authorization request (it carries `client_id` and `response_type`), Agent Hub sets two standard parameters on it before sending the browser on:

- `prompt=login` on every start, so Microsoft always asks for credentials. It replaces any weaker `prompt` Hub set.
- `login_hint=<email>`, using the email entered on the sign-in page, so Microsoft skips or pre-fills its email step. A `login_hint` that Hub already set is kept.

Forcing re-authentication on every start is simpler and safer than forcing it only after a sign-out: a marker cookie could be cleared, it wouldn't cover sessions that simply expired, and sign-ins are rare anyway (sessions last up to 30 days). The parameters are only in the URL, so someone at the browser could remove them. Hub must enforce re-authentication itself for this to hold against a deliberate attacker. The start request to Hub is unchanged, because Hub's schema rejects unknown fields. Other authorize URLs are passed through untouched.

**Desktop.** The Electron app does not support SSO yet because it hands off-origin navigation to the system browser, which cannot complete an app sign-in. Entra users see a message pointing them to this deployment in their browser. Always Native users sign in on desktop as before. Mobile keeps its password form.

### Staging check

This runs against a staging Hub, never production. Hub must first issue a deployment and service credential for the staging Agent Hub origin and register its callback URL.

```bash
AUTH_MODE=hub
HUB_AUTH_ORIGIN=<staging Hub origin>
HUB_AUTH_TENANT_ID=<staging tenant id>
HUB_DEPLOYMENT_ID=<deployment UUID from Hub>
HUB_SERVICE_API_ID=<service credential API id>
HUB_SERVICE_SECRET_FILE=<path to a file with the service secret>
HUB_SSO_ENABLED=true
BETTER_AUTH_URL=<staging Agent Hub HTTPS origin>
WEB_ORIGIN=<staging Agent Hub HTTPS origin>
```

Then, in a browser:

1. Sign in as an assigned Entra test user. Expect Microsoft to open with the email filled in, then `/app`.
2. Sign in as an Entra test user without an Agent Hub assignment. If Hub refuses at Continue, expect "Microsoft sign-in didn't finish. Try again, or ask your admin for access." on the email step. If Hub refuses after Microsoft, expect Hub's own `/tenant-sso-error` page. Either way, no Agent Hub session is created.
3. Reload the callback URL from step 1. Expect "Your sign-in expired".
4. Set the first user to Always Native in Hub and sign in with their password. Expect the same account and data as step 1.
5. Remove the first user's assignment in Hub while signed in. Expect access to stop within the verification cache TTL.
6. Sign in as another assigned Entra test user, sign out of Agent Hub, and continue with the same email. Expect Microsoft to ask for the password again, with the email already filled in.

## Hub policy

In Hub mode, CortexAI Hub is the source of truth for this deployment's Agent Hub settings (CAAH-36). The API reads `GET /api/agent-hub/service-config?schemaVersion=agent-hub-settings-v1` with its service token. It validates the schema version, the product (`cortexai-agent-hub`, the audience), the tenant (it must be `HUB_AUTH_TENANT_ID`), the revision and every field. Hub does not sign the document; it is bound by TLS to `HUB_AUTH_ORIGIN` and by the tenant-scoped service token. Anything outside the known catalog, including branding, surfaces and budget fields Hub does not manage yet, makes the document invalid rather than being ignored.

**Shared last-known-good.** The API stores the accepted document encrypted in the `hub_policy_snapshot` table with its revision, ETag, when it was fetched, when Hub was last reached, and whether it came from Hub or is being kept after a failed refresh (`source`: `hub` or `last_known_good`). It asks Hub at startup and every 60 seconds. The worker never contacts Hub: it applies the snapshot the API stored (waiting up to 60 seconds for the first one), so both processes run the same revision. A failed refresh keeps the last-known-good document. An older revision from Hub is accepted, because Hub wins, and logged as a rollback.

**Precedence.** Hub wins over the environment and over persisted deployment settings for every setting it manages. At startup each process replaces the environment inputs Hub manages, and Hub's model and signup defaults replace the persisted ones when they are read; the stored local values are kept but ignored. Local values still apply to settings Hub does not manage. Users' own model credentials and per-bot model choices are user data, not deployment settings, and are unchanged. Each override is logged as an operator signal that carries the setting path, Hub's revision and the overridden source, never a value:

```json
{ "event": "hub_policy_override", "key": "model.defaultProvider", "hubRevision": 7, "overriddenSource": "env:PI_DEFAULT_PROVIDER" }
```

The source is `env:<NAME>` or `deployment_settings.<field>`. Other signals are `hub_policy_rollback`, `hub_policy_refresh_failed` (a code and a fixed reason), `hub_policy_assignments_unknown` and `hub_policy_restart_required`.

**Restarts.** Hub's settings are applied when a process starts, as Hub's delivery contract requires. When Hub publishes a revision that changes them, a process still running the earlier one refuses new sign-ins with `HUB_CONFIG_RESTART_REQUIRED` and refuses new work until it restarts. Restart the API, then the worker. A revision that changes only product assignments or toolkit status needs no restart.

**Sign-in is fail-closed.** Every path that can create a session asks Hub first: email-first Continue (web and desktop), password sign-in (web, desktop and mobile), and the Microsoft SSO start and callback. There is no local or break-glass bypass. Refusals use stable codes:

| Code | When | HTTP |
| --- | --- | --- |
| `HUB_UNAVAILABLE` | Hub cannot be reached: timeout, DNS or connection failure, `408`, `429` or `5xx`, including during the password or SSO exchange | 503 |
| `HUB_CONFIG_INVALID` | Hub's document is malformed, for another tenant or product, or uses an unknown schema, field or value | 503 |
| `TENANT_DISABLED` | Hub refuses the service credential for the tenant (`401` or `403`) | 403 |
| `HUB_CONFIG_RESTART_REQUIRED` | The process has not applied Hub's current revision | 503 |
| `HUB_ACCESS_DENIED` | Hub's assignments do not include this user, or the grant is for another tenant | 403 |

The first four carry the message "Sign-in is temporarily unavailable, CortexAI Hub can't be reached"; `HUB_ACCESS_DENIED` carries "Ask your admin for access". The SSO callback redirects to `/sign-in?error=` with the code in lower case. No user, session or SSO state is created for a refused sign-in.

**Active sessions** keep working on last-known-good only within the verification cache window described below. On the next Hub verification after it, the stored policy must still admit the session like a new sign-in: the last refresh succeeded, the process runs Hub's revision and the user is still assigned. Otherwise the request is refused. The session is not deleted, so it resumes when Hub recovers. New work (runs and tool calls) needs the user to be assigned in the stored policy and stops at once when Hub disables the tenant, removes the assignment, or a restart is required.

**Assignments (CAH-204).** Hub marks its Agent Hub assignment projection with `access.contract: "agent-hub-assignments.v1"`, and the rows are `{ tenantUserId, productId: "cortexai-agent-hub", role }`. Under that marker the list is authoritative: only listed users may sign in or start work, and an empty list means nobody is assigned. Sign-in is then refused with `HUB_ACCESS_DENIED`, and active sessions lose work access at once and are refused once the CAAH-40 window ends. Last-known-good assignments are not kept in that case. A `contract` with any other value is rejected as `HUB_CONFIG_INVALID`, so it never grants access. Without the marker, an empty or unattributable `access.productAssignments` is treated as unknown, never as "no access". The last configured assignments are kept when there are any. With none, sign-in is allowed but no product or tool access is granted, and `/internal/health` reports `assignments: "pending"`. `role` is accepted but not used.

**Status.** `/internal/health` includes `hubPolicy` with the state, code, tenant, Hub revision, applied revision, fetch and check times, source, and assignment and toolkit status. It never includes a setting value.

## Verification cache and revoke semantics

**Worst-case revoke detection lag = cache TTL + one request round-trip.**

The verification cache reduces Hub API load and improves perceived latency for authenticated requests. When a user's Hub entitlement is revoked or their session is disabled on Hub, Agent Hub will detect the change after the cache TTL expires on the next request that requires verification. For the default 30-second TTL, this means a revoked user can continue accessing Agent Hub for up to 30 seconds plus one additional request (~0.5–2s depending on Hub latency) before being denied.

This is an intentional trade-off:
- **Without cache**: Every protected RPC hits Hub twice, adding 0.4–2.4s of non-LLM latency to the hot path
- **With cache**: Protected RPCs within the TTL window skip Hub verification, making the UI feel snappy; revokes are noticed within TTL + one request

The cache can be disabled by setting `HUB_VERIFY_CACHE_ENABLED=false` to restore immediate revoke detection at the cost of higher latency and Hub load. The TTL can be tuned via `HUB_VERIFY_CACHE_TTL_MS` (milliseconds) to balance latency vs revoke detection speed. Lower TTLs (e.g., 10–15 seconds) provide faster revoke detection; higher TTLs (e.g., 60 seconds) reduce Hub load further but extend the revoke lag.

Cache metrics (hits, misses, evictions, verify latency p50/p95) are logged every 5 minutes for observability.

## Migrating the earlier OAuth implementation

Run the normal database migrations before starting API/worker processes. The additive migration stores encrypted opaque access tokens and retains nullable legacy OAuth metadata. Existing OAuth sessions must sign in again. User ownership remains stable because native `user.id` matches the previous JWT subject. Keep `ENCRYPTION_KEY` stable. Update both API and workers to the corrected implementation; neither accepts a legacy grant without a native access token.

## Verification

Run the auth unit suite and PostgreSQL integration tests against a disposable migrated database. Coverage includes native login, assignment denial before token expiry, identity continuity, concurrent refresh, encrypted persistence, local-account isolation, and shared web/desktop form behavior. Browser tests use a headless web renderer; they do not launch the desktop application.
