# CortexAI Hub authentication

Set `AUTH_MODE=hub` and `HUB_AUTH_ORIGIN=https://hub.example.test`. The origin is server configuration, never a login input. `HUB_AUTH_TENANT_ID` is an optional deployment restriction; tenant discovery works without it. OAuth client credentials, audience and callback registration are not required.

Web, the shared desktop renderer, and mobile present the same email/password form used by Workbench. Agent Hub's server discovers the tenant with `/api/tenant-auth/lookup`, signs in through `/api/tenant-auth/login`, and verifies the authenticated identity and Agent Hub product entitlement. Non-native tenant IdPs are currently unsupported, matching Workbench. Local signup/password operations stay disabled in Hub mode. Passwords are forwarded only for login and never persisted.

The v2 contract fixture is `packages/auth/src/fixtures/agent-hub-auth.v2.json`. All fixture values are synthetic. Users must be active, their tenant and the CAIA product must be active, the tenant must enable it, and the user must have an explicit Agent Hub assignment. Stable ownership uses the trusted Hub origin plus tenant ID and user ID. Existing local users are never linked by email and Hub users do not automatically become deployment owners.

Opaque Hub access and refresh tokens are encrypted in server-side `hub_session` rows. Web clients use Agent Hub's own HTTP-only session cookie; mobile stores its own app session in secure storage. Hub configuration may contain provider credentials and is consumed only server-side for authorization. It is never returned as login state.

Every protected session/work authorization checks current identity and `/api/tenant-auth/config?product=cortexai-agent-hub`. Successful verifications are cached for a short TTL (default 30 seconds, configurable via `HUB_VERIFY_CACHE_TTL_MS`) to avoid Hub round-trips on every protected RPC while preserving fail-closed semantics. The cache keys by access token and respects both the configured TTL and the token's actual expiry time. Cache entries are invalidated when tokens are refreshed or rotated. Failures always deny access and are never cached. Expired tokens refresh through `/api/tenant-auth/refresh` under a database row lock; refresh must preserve user and tenant identity. Session deletion attempts `/api/tenant-auth/revoke` and always removes the local session. Hub access tokens currently last 24 hours and rotating refresh tokens 30 days.

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
