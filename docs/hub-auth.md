# CortexAI Hub authentication

Set `AUTH_MODE=hub` and `HUB_AUTH_ORIGIN=https://hub.example.test`. The origin is server configuration, never a login input. `HUB_AUTH_TENANT_ID` is an optional deployment restriction; tenant discovery works without it. OAuth client credentials, audience and callback registration are not required.

Web, the shared desktop renderer, and mobile present the same email/password form used by Workbench. Agent Hub's server discovers the tenant with `/api/tenant-auth/lookup`, signs in through `/api/tenant-auth/login`, and verifies the authenticated identity and Agent Hub product entitlement. Non-native tenant IdPs are currently unsupported, matching Workbench. Local signup/password operations stay disabled in Hub mode. Passwords are forwarded only for login and never persisted.

The v2 contract fixture is `packages/auth/src/fixtures/agent-hub-auth.v2.json`. All fixture values are synthetic. Users must be active, their tenant and the CAIA product must be active, the tenant must enable it, and the user must have an explicit Agent Hub assignment. Stable ownership uses the trusted Hub origin plus tenant ID and user ID. Existing local users are never linked by email and Hub users do not automatically become deployment owners.

Opaque Hub access and refresh tokens are encrypted in server-side `hub_session` rows. Web clients use Agent Hub's own HTTP-only session cookie; mobile stores its own app session in secure storage. Hub configuration may contain provider credentials and is consumed only server-side for authorization. It is never returned as login state.

Every protected session/work authorization checks current identity and `/api/tenant-auth/config?product=cortexai-agent-hub`, even before token expiry. Failures deny access. Expired tokens refresh through `/api/tenant-auth/refresh` under a database row lock; refresh must preserve user and tenant identity. Session deletion attempts `/api/tenant-auth/revoke` and always removes the local session. Hub access tokens currently last 24 hours and rotating refresh tokens 30 days; these lifetimes do not grant cached permission.

## Migrating the earlier OAuth implementation

Run the normal database migrations before starting API/worker processes. The additive migration stores encrypted opaque access tokens and retains nullable legacy OAuth metadata. Existing OAuth sessions must sign in again. User ownership remains stable because native `user.id` matches the previous JWT subject. Keep `ENCRYPTION_KEY` stable. Update both API and workers to the corrected implementation; neither accepts a legacy grant without a native access token.

## Verification

Run the auth unit suite and PostgreSQL integration tests against a disposable migrated database. Coverage includes native login, assignment denial before token expiry, identity continuity, concurrent refresh, encrypted persistence, local-account isolation, and shared web/desktop form behavior. Browser tests use a headless web renderer; they do not launch the desktop application.
