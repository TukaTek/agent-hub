# Upstream Sync #3 (through #1998)

**Status:** Merged on the branch, draft PR open. Not deployed.

**Goal:** Merge all of upstream `main` (`2362e07b`, #1997/#1998, 364 commits past our `08ee8cfb` merge base) into `TukaTek/agent-hub` in one real merge commit. Only the Honcho memory provider and the Dutch locale are skipped by policy. Every other upstream change comes in unless it technically conflicts with a fork feature.

**Architecture:** Same as [CAAH-107](caah-107-upstream-sync-2.md). `git merge --no-ff upstream/main`, then `scripts/upstream-remerge.mjs` re-merges each conflicted file after rebranding and formatting the base and upstream sides. The remaining hunks are resolved by hand inside the merge commit. Skips and fork fallout land as separate commits on top. **Merge the PR with "Create a merge commit"**; squash or rebase drops the upstream parent and the next sync would replay all 364 commits.

Notation: `<old>` is upstream's retired product name. Upstream PRs are written "#N".

## Inventory

- Merge base `08ee8cfb` (#1535). Upstream is 364 commits ahead; the fork is 95 ahead.
- Trial merge: 487 conflicted paths. The re-merge script resolved 299 and kept 24 fork deletions. That left 105 content conflicts (361 hunks), about 45 modify/delete conflicts, and binary assets.

## Commits on the branch

1. Merge commit (two parents).
2. Keep the Honcho memory provider out of the fork (#1641, #1717, #1766, the Honcho half of #1645).
3. Keep the Dutch locale out of the fork.
4. Pass Hub and fork settings through the Compose env allowlist.
5. Keep stall retries out of the provider retry window.
6. Align fork tests and the computer desktop theme with upstream.
7. Use a valid SQL identifier for the runtime database role.

## Must stay intact

| Fork feature | Resolution | Proof |
|---|---|---|
| Hub sign-in, SSO, email-first sign-in | `packages/auth` keeps the Hub plugin; signup policy is upstream's env policy wrapped in `withHubSignupPolicy`, so Hub wins. Upstream's email codes and passkeys are disabled in Hub mode, and `authCapabilities` reports `emailCode: false`, `passkeyRpId: null`, `billing: false`. Upstream #1757 signed bearers apply to Hub sessions too, and the Hub sign-in response returns the signed token that mobile uses. Web `Auth.tsx` keeps email-first: Continue sends a code in local mode, with "Use password" on the code step. | `packages/auth/src/hub.test.ts` (signed bearer, client IP header, rate limit), `Auth.test.tsx`, `Auth.sso.test.tsx`, `auth-capabilities.test.ts`, e2e `auth-lifecycle`, `golden`, `hub-auth` |
| Hub policy enforcement and entitlement | Kept `createUserWorkAuthorizer` wiring and Hub health next to upstream's telemetry health. `env.ts` still refuses Stripe together with Hub. | `health.test.ts`, `env.test.ts`, `hub-policy*.test.ts` |
| Composio central management, `hub_` user IDs | `composio-connector.ts` kept ours (full allowlist); worker and API keep the Hub-scoped stack with the new `{ apiKey }` constructor. | `composio-*.test.ts`, `integration-provider-settings.test.ts` |
| Branding | Rebrand sweep plus manual fixes: Stripe metadata key `cortexai_agent_hub_credit_cents`, OpenRouter referer, Kotlin notification package, bridge prefix `cah-c`, database role `cortexai_agent_hub_app`. Expo slug stays `agent-hub`, mobile version stays ours. | `product-identity.test.ts`, `upstream-rebrand.test.mjs` |
| Office attachments, PDF download to the computer | Re-applied inside upstream's `Shell.tsx` refactor and the lazy run computer in `executor.ts`. | `artifacts.test.ts`, `attachments.test.ts`, `executor-secret-pi.test.ts` |
| Open work section (CAAH-114) | Upstream's card layout, add button and hide-when-empty, with our collapsible header (count, collapsed above 5, internal scroll, per-bot `localStorage`). Upstream's "Show more" is not used. | `ScratchpadSection.test.tsx` |
| Model stream stall retries (CAAH-96) | Our stall budget and sticky switch now cover every provider. Upstream's sizing, context-limit, output-cap and idle-recovery paths are taken. Upstream bounds same-model retries with one window, so a stall retry renews it. Upstream's silent-stream test now expects an immediate retry instead of a 2 s backoff. | `pi-runtime-stall-retry.test.ts`, `pi-runtime-fallback.test.ts` |

## Skips

| Item | Reason |
|---|---|
| Honcho memory provider | Policy. |
| Dutch (`nl`) locale | Policy. |
| `README.zh-CN.md` | Upstream-only install and store links; the fork has no translated README. |
| Upstream `www` redesign | CAAH-88 D4: the fork owns its trimmed site. Only the Astro bump and two shared components were taken. |
| README comparison section | The fork removed it earlier. |
| Desktop "Cloud" setup choice | There is no hosted CortexAI Agent Hub service, so `CORTEXAI_AGENT_HUB_CLOUD_URL` is `null` and setup hides the choice. "This computer" is the default. |

## Database migrations

25 new migrations, all from upstream. They run in order with `prisma migrate deploy`:

`cloud_agent_followup_dispatched_at`, `team_computer_per_user`, `passkeys`, `security_events`, `row_level_security`, `content_encryption`, `message_search_tokens_idx`, `mcp_server_credential_files`, `mcp_server_health`, `row_level_security_tenant_tables`, `bot_fleet_management_default_on`, `model_credits`, `thread_read_cursor`, `managed_model_settings`, `credit_funding_choice`, `billing_audit`, `billing_audit_access`, `credit_expiration`, `credit_expiration_index`, `credit_projection_indexes`, `home_object_storage`, `signup_survey`, `bot_cross_space_communication`, `external_messages_bot_sender_idx_concurrent`, `run_dispatch_timing`.

`row_level_security` creates the NOLOGIN role `cortexai_agent_hub_app`. The migration login needs `CREATEROLE`, or an operator creates the role first.

## Deploy impact

- **Postgres 16 → 18 (#1912).** `docker-compose.yml` and `docker-compose.prod.yml` run Postgres 18. An existing 16 volume must be copied with `infra/compose/upgrade-postgres.sh` with the stack stopped; production deploy stops with a pointer if it finds an un-upgraded volume. The published-images stack stays on 16.
- **Runtime database login and row-level security.** The app now connects as a separate login that is a member of `cortexai_agent_hub_app`; migrations use `DATABASE_MIGRATION_URL` as the owner. Compose needs `POSTGRES_APP_PASSWORD`.
- **Content encryption.** `CONTENT_ENCRYPTION` defaults to `on` in Compose; new content is encrypted at rest with `ENCRYPTION_KEY`/`ENCRYPTION_MASTER_KEYS`.
- **Encrypted S3 homes (#1917).** Optional: `OBJECT_STORAGE_*`. Unset keeps homes on local disk.
- **CI deploy pulls the CI-built image (#1892).** Deploy pulls `ghcr.io/<owner>/<repo>/app:sha-<commit>` and falls back to a host build, loudly. The image must be published by CI first.
- **No app-level deployment administrators (#1915).** The `ADMINS` list, deployment owner claim and in-app server update are gone; updates and logs are server tooling only. The Hub bootstrap no longer passes `claimDeploymentOwner`.
- **Billing and credits (#1878, #1901, #1908).** Off unless `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are set. Hub deployments must leave them unset: startup refuses Stripe with Hub, and Hub capabilities report `billing: false`, so Hub entitlement stays the only gate.
- **Cross-space bot communication blocked by default (#1943).** Every existing bot gets `crossSpaceCommunication = false`. Bots that message bots in other spaces need it turned on.
- **Client/server build handshake and kill switch (#1849).** Web and mobile send their build; open tabs reload after a deploy. `CORTEXAI_AGENT_HUB_MIN_CLIENT_BUILD` (unset by default) refuses older clients with 426.
- **Compose env allowlist.** The API and worker no longer get the whole `.env`; they get the `x-app-environment` list. This sync adds the Hub keys (`AUTH_MODE`, `HUB_*`), secret-request limits, stream timeouts and `TOOL_RESULT_TEXT_LIMIT`. Any setting outside the list is not passed through.
- **Sign-in changes in local mode.** Email-code sign-in and passkeys (`PASSKEY_APPLE_APP_IDS`, `PASSKEY_ANDROID_CERT_SHA256`, iOS `webcredentials`) are new and off in Hub mode. Only signed bearer tokens are accepted (#1757), so a client holding an unsigned token must sign in again.
- **Client IP.** `TRUSTED_PROXIES` and `CLIENT_IP_HEADER`; Caddy forwards `x-cortexai-agent-hub-client-ip`.
- **Other new settings.** MCP stdio (`MCP_STDIO_*`, `MCP_PACKAGES_DIR`, `MCP_DISCOVERY_TIMEOUT_MS`), `CORTEXAI_AGENT_HUB_OPENAI_COMPAT_PRIVATE_HOSTS`, `SECURITY_EVENT_RETENTION_DAYS`, `ANALYTICS_*`, `AUTH_BREACHED_PASSWORD_CHECK_ENABLED`. `SANDBOX_COMPUTER_EGRESS` is removed; the supervisor probes egress automatically.

## Open tickets

- **CAAH-111 (provider errors swallowed, run marked ok, UI stuck "Working…"):** partly addressed. #1946 makes a 402 a non-transient, user-fixable error; #1914 fails a run without credentials before calling the provider; #1969 names overloaded, too-long and dropped-connection errors; #1952 logs provider and model. Nothing upstream changes the worker path that recorded the job as ok, and there is no worker-level 402/401/5xx outcome test. Keep the ticket open and reproduce with a 402 fixture.
- **CAAH-113 (chat empty with `SANDBOX_PROVIDER=none`):** not fixed. Bot creation still upserts a team computer with the deployment's kind, and `SandboxKind` in `packages/contracts/src/ids.ts` still has no `none`.

## Verification

- `pnpm check`, `pnpm lint`, the Vitest suite and `npx expo install --check` locally.
- Postgres tests, web e2e and desktop e2e run in CI (no Docker on the agent VM).
