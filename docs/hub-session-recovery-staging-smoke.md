# Hub session recovery: staging smoke (CAAH-108)

A manual check that a Hub outage keeps users signed in while a definitive Hub refusal still signs them out. Run it only against a staging Agent Hub and a staging Hub, with a test tenant and test users, after the release is approved. Never run it against production or real users. [Releasing and rolling back](hub-session-recovery-release.md) covers the deploy itself.

## Setup

- A staging Agent Hub in Hub mode ([Configuring Hub mode](hub-auth.md#configuring-hub-mode)) with `HUB_AUTH_TENANT_ID` pinned to a test tenant, and at least two API processes behind the load balancer plus one worker.
- A fault-injecting reverse proxy in front of the staging Hub, set as `HUB_AUTH_ORIGIN` **before** anyone signs in. Changing `HUB_AUTH_ORIGIN` afterwards does not simulate an outage: sessions are bound to the origin they signed in with, so they are refused instead. The proxy must be able to pass through, drop connections, delay past the client timeout, answer a fixed status and JSON body for one path, and log each request's method and path (never headers or bodies).
- Two test users in the test tenant, both assigned to Agent Hub, and a second test tenant with one assigned test user.
- Read access to the staging API logs and to the staging database (`session`, `hub_session`, `hub_identity`).

The verification cache serves a session for up to `HUB_VERIFY_CACHE_TTL_MS` (default 30 seconds) without calling Hub. After changing the proxy, wait longer than that before the next request, or the step passes without reaching Hub.

To force a refresh instead of a verify, expire the test session's access token:

```sql
UPDATE hub_session SET "accessUntil" = now() - interval '1 minute' WHERE "sessionId" = '<test session id>';
```

## 1. Hub outage mid-chat keeps the session

1. Sign in as test user A on web and start a chat with a bot that calls a tool.
2. Make the proxy unreachable for every Hub path: first drop connections, then repeat the step with `503` and with a request that hangs past the timeout.
3. Wait past the cache TTL and send another message.
4. Expect:
   - `GET /api/auth/get-session` answers `503` with `{ "code": "HUB_UNAVAILABLE" }`, and its response has no `set-cookie` that clears the session cookie.
   - The app does not show the sign-in page.
   - A run started now, or one reaching its next tool call, fails with "CortexAI Hub can't be reached" and never with "Sign in through CortexAI Hub to continue".
   - The `session` and `hub_session` rows for the user are unchanged, and the API logs `hub_session_unavailable` with no token, email or Hub body.
5. Repeat with the proxy answering each of these on `/api/tenant-auth/session` (and, with an expired access token, on `/api/tenant-auth/refresh`). Each must behave like step 4:
   - `401` and `403` with an empty body or an HTML page
   - `400 {"error":"invalid_request"}`, `400 {"error":"missing_product"}`, `404 {"error":"unknown_product"}`
   - `408`, `429`, `500`, `502`, `504`
6. Restore pass-through. Without signing in, send another message. Expect the same session to work and the run to complete.

## 2. Definitive rejection signs the user out

For each case, sign in as test user B fresh, wait past the cache TTL, apply the case, then make one request.

| Case                            | How to produce it                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `401 refresh_failed` on refresh | Expire the access token, then revoke the user's Hub session in Hub (or have the proxy answer `401 {"error":"refresh_failed"}` on `/api/tenant-auth/refresh`) |
| `400 invalid_grant` on refresh  | Expire the access token and have the proxy answer `400 {"error":"invalid_grant"}` on `/api/tenant-auth/refresh`                                              |
| `403 access_denied` on config   | Remove the user's Agent Hub entitlement in Hub, or have the proxy answer `403 {"error":"access_denied"}` on `/api/tenant-auth/config`                        |
| `valid: false` on session       | Disable the user in Hub, or have the proxy answer `200 {"valid":false}` on `/api/tenant-auth/session`                                                        |

Expect for each: the request is unauthenticated (no user, not `503`), the user's `session` and `hub_session` rows are deleted, the app returns to sign-in, and signing in again works once the case is undone.

## 3. Sign-out while Hub verification is down

1. Sign in as test user A and wait past the cache TTL.
2. Have the proxy drop `/api/tenant-auth/session` and `/api/tenant-auth/config` only, leaving `/api/tenant-auth/revoke` passing through.
3. Sign out from the app.
4. Expect sign-out to succeed, the user's `session` and `hub_session` rows to be deleted, and the proxy log to show one `POST /api/tenant-auth/revoke`. With revoke also dropped, sign-out must still succeed locally (revoke is best effort).

## 4. Concurrent refresh across processes

1. Sign in as test user A and expire the access token.
2. Send two `GET /api/auth/get-session` requests with the same cookie at the same moment, routed to different API processes (pin each to a process by its internal address, or send several in parallel through the load balancer).
3. Expect:
   - Both answer `200` with the user.
   - The proxy log shows exactly one `POST /api/tenant-auth/refresh`.
   - `hub_session.refreshToken` changed once, `accessUntil` is in the future and `refreshLeaseUntil` is null.
   - The next request after the cache TTL verifies with the new grant, and the user is not signed out.

## 5. Tenant isolation

1. Sign in as test user A (test tenant) and as the second tenant's test user in another browser.
2. In the database, set test user A's `hub_identity.tenant` to the second test tenant's id and wait past the cache TTL.
3. Expect user A's next request to be unauthenticated, the proxy log to show no Hub call for it, and user A's `session` row to remain (a policy refusal, not a revocation). The second tenant's user is unaffected and keeps working. No `hub_session` row is shared between the two users.
4. Restore user A's tenant and expect the session to work again.

## Recording the result

Record each step as pass or fail with the time, the staging build, and any deviation. Do not record tokens, cookies, emails, tenant ids or user ids; refer to "test user A", "test user B" and "second tenant".
