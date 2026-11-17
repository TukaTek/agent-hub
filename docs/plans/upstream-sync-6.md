# Upstream Sync #6 (v0.12.0, through upstream main de2a3da5)

**Status:** Merged on the branch. Not deployed.

**Goal:** Bring `TukaTek/agent-hub` from upstream `fdf3b2b3` ([sync #5](upstream-sync-5.md)) to upstream `main` at `de2a3da5`, which contains release v0.12.0 (`8b3dcd59`): 454 commits. Skips and Hub rules are the same as sync #5, plus new flags for upstream's organization and invitation features.

**Architecture:** One batch. `git merge --no-ff --no-commit de2a3da5`, then `scripts/upstream-remerge.mjs`, then the remaining 320 conflicted files by hand (three helpers took adapters/core, web/catalogs and mobile/www/docs). Two tool fixes went in as their own commits: the rebrand tool keeps hyphens after the upper-case old name, and the remerge tool skips symlinks (upstream added `.depot/actions`).

Notation: `<old>` is upstream's retired product name. Upstream PRs are written "#N".

## Merges

| Step             | Range                | Merge       |
| ---------------- | -------------------- | ----------- |
| Upstream v0.12.0 | `fdf3b2b3..de2a3da5` | `5f1095c2a` |

## Flags added

Both are read by the API, default off, and are forced off when Hub sign-in is on.

| Variable                                        | Default | Gates                                                                                                                                                                                                                        |
| ----------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CORTEXAI_AGENT_HUB_ENABLE_ORGANIZATIONS`       | off     | Creating organizations, inviting people, previewing and accepting invitations, and changing or removing members (#4944, #4919, #5003). When off, the members list is read-only and the apps hide create and invite controls. |
| `CORTEXAI_AGENT_HUB_ENABLE_SPACE_EMAIL_INVITES` | off     | Emailing a Space invitation to anyone, who joins as a guest (#5005). Invite links and adding organization members are unchanged.                                                                                             |

Existing upstream switches that cover the rest: Google and Apple sign-in need `GOOGLE_*`/`APPLE_*`, and the demo sign-in button needs `DEMO_ACCOUNT_EMAIL`/`DEMO_ACCOUNT_PASSWORD`. All are unset by default.

## Must stay intact

| Area                 | Resolution                                                                                                                                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hub sign-in          | `rejectHubAccountMutation` still runs first, so upstream's new auth paths are refused under Hub. The fork's web sign-in page and mobile sign-in screen are kept, with upstream's "Create your account" heading, the unsent-message warning (#4772) and the shared-hook refactor.                         |
| Google/Apple (#4084) | Taken. Startup refuses `GOOGLE_*`/`APPLE_*` with Hub sign-in, and Hub capabilities list no sign-in providers. Passkeys stay off under Hub.                                                                                                                                                               |
| Demo sign-in (#4965) | Taken. `DEMO_ACCOUNT_*` is ignored under Hub, and the fork's sign-in page has no demo button.                                                                                                                                                                                                            |
| Organizations        | Behind `CORTEXAI_AGENT_HUB_ENABLE_ORGANIZATIONS`. Under Hub, organizations are also not renamed or deleted, and the apps hide those controls.                                                                                                                                                            |
| Billing              | `BILLING_EMULATOR` (new) is refused with Hub sign-in, like Stripe. Partner-program clicks and signup attribution are not recorded for Hub accounts.                                                                                                                                                      |
| Composio             | Upstream dropped the router's Composio dependency (#5053). It is passed again, and the deployment key provider stays the first choice for Composio connections. The fork's test moved to `router-connections-begin.test.ts`.                                                                             |
| Runtime              | Upstream split the executor into `run-attempt`, `run-assembly-*` and `run-model-turn`. The fork's Hub user-work refusal, workspace delivery instruction, workspace root and tool-result spill moved with it. Upstream removed in-process subagents, so the fork's per-subagent fallback logging is gone. |
| API shutdown         | Upstream's run-drain shutdown, plus the fork's Hub policy restart and policy close.                                                                                                                                                                                                                      |
| Desktop              | The Cloud choice stays hidden and This computer stays the default after upstream moved the code to `src/main`.                                                                                                                                                                                           |
| Fork names           | `cortexai_agent_hub_app` (no new upstream migration grants it), `cah-c`, the Compose env allowlist, the mobile app version (1.0.4), and the fork's computer uptime cap of 0 (none) in production Compose.                                                                                                |

## Skips

Same as sync #5: Honcho, Dutch (`nl`), `README.zh-CN.md`/`README.th-TH.md`, the upstream www redesign, the desktop hosted first launch, and the LAN cleartext mobile plugin. Upstream moved Honcho to `providers/memory/honcho`, so it came back and was removed again, with its strings and checks.

- **#5116 (marketing pages in a private repo):** not taken. The fork's www keeps its pages in-tree. The clone script, marketing stubs, build check, IndexNow workflow and key, and the upstream-branded assets are removed.
- **#5006 (CI for the upstream organization move):** generic changes taken (release feed check, Trivy image scans). The image mirror to upstream's old packages and its `LEGACY_GHCR_TOKEN` are removed, as is the alias for upstream's new repository in self-update.
- Upstream's single-route www homepage (#4951) and typed demo copy (#4952) belong to the skipped redesign.

## Translations

Catalog conflicts were merged as a union, preferring the fork's translations. Honcho entries were dropped. No catalogs were re-extracted.

## Database migrations

19 new migrations, all from upstream. None grants a role.

- **Deferred** (`-- deferred`, applied one deploy later):
  - `20261222120000_drop_legacy_run_retry_wake` drops a trigger and its function.
  - `20261223120000_drop_signup_settings_columns` drops `deployment_settings.signupAllowlist`, `signupPolicyInitialized` and `signupsEnabled`. The signup policy now comes only from `SIGNUPS_ENABLED`/`SIGNUP_ALLOWLIST`.
  - `20261225140000_drop_computer_execution_columns` drops `computers.executionRunId`, `executionBotId`, `executionLeaseExpiresAt` and `executionFence`. Ownership moved to `computer_execution_leases`.
  - `20261226120100_drop_push_tokens` drops `push_tokens` and its mirror trigger function.
- **Push registrations (two deploys):** `20261226120000_push_registrations` creates `push_registrations` (one row per device), copies every `push_tokens` row into it while holding writes, and mirrors the previous release's writes until the deferred drop. No push token is lost if both migrations run in order. Rolling back to a release older than this one after the drop loses push registration for every device until each app registers again.
- **Time zone:** `20261225130000_database_time_zone_utc` sets the database default time zone to UTC. Without the right to alter the database, it warns and the owner must run the printed command.
- **Secrets:** `20261224140000_expire_waiting_run_secrets` queues a `run.forget-secrets` job for every run waiting on an answer.
- **Security:** `20261220120000_security_definer_search_path` pins `search_path` on four billing trigger functions and revokes their public execute.
- **Connections:** `20261227120000_connection_connector_no_default` drops the column default on `connections.connectorId`; the API always records the connector.
- **Additive:** `run_computer_use`, `subagent_request_origin`, `subagent_reply_delivery` (trigger now also covers delegated results), `messaging_cap_release_handle`, `user_labs`, `computers_execution_run_idx_concurrent` (concurrent index), `model_credit_disputed_micros`, `partner_sales` (plus `user.signupPartnerClickId`), `leases` and `lease_fence_sequence`.
- **One-way:** the four deferred drops. The UTC default stays if rolled back.

## Deploy impact

- Run `migrate` on two consecutive deploys so the four deferred drops apply. The push token copy needs both.
- The database must be able to take `ALTER DATABASE ... SET timezone TO 'UTC'`; otherwise run it as the owner when the migration warns, and remove any runtime-role time zone setting.
- Node 24.22.3 everywhere: Dockerfiles, CI, and now EAS builds. Engines are unchanged (`^24.15.0 || >=26`).
- **New settings (all optional):** `CORTEXAI_AGENT_HUB_ENABLE_ORGANIZATIONS`, `CORTEXAI_AGENT_HUB_ENABLE_SPACE_EMAIL_INVITES` (fork), `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `APPLE_CLIENT_ID`/`APPLE_TEAM_ID`/`APPLE_KEY_ID`/`APPLE_PRIVATE_KEY`/`APPLE_PRIVATE_KEY_FILE` (refused with Hub), `DEMO_ACCOUNT_EMAIL`/`DEMO_ACCOUNT_PASSWORD` (ignored with Hub), `BILLING_EMULATOR` (refused with Hub), `DUB_API_KEY`, `EXPERIMENTS`, `RUN_DRAIN_ENABLED`, `CHAT_HISTORY_RETENTION_DAYS`, `OBJECT_STORAGE_PROTOCOL` (Azure Blob), `COMPUTER_DEFAULT_MODE`, `SANDBOX_COMPUTER_COMPUTE_GPUS`, `CORTEXAI_AGENT_HUB_COMPUTER_PROXY`.
- `TICKET_BOARD_ENABLED` now turns the board on for everyone; otherwise each person enables it in Settings → Labs.
- Production Compose now passes `COMPUTER_DEFAULT_MODE` (default `team`).
- Plain HTTP `SENTRY_DSN` collectors are refused.

## Fork commits

Before the merge: `82db52074` the rebrand tool keeps hyphens after the upper-case old name.

After the merge:

- `a2a5f8af2` the remerge tool skips symlinks. `bee8d9b9a` EAS builds use Node 24.22.3 like everything else.
- `8cd97dbc0` Biome formatting of the merge. The fork's Hub test doubles opt out of the explicit-any rule, which upstream now enforces.
- `3284d957c` fork code fixed for upstream moves and signature changes (Space bootstrap, the encryption key module, stream rechecks under Hub, moved provider imports).
- `b39dbaee5` the rebrand tool brackets hyphenated property names; it had broken the Claude Code fake CLI.
- `d089da6a9` the new flags are passed by Compose, documented and tested. The e2e harness, iOS screenshot backend and upstream's Postgres suites turn them on.
- `a83336189` upstream tests aligned with fork behavior.

## Judgment calls

- **Grok Bot agent import:** upstream's import of a Grok Bot self-export is kept. The fork's identity test now skips the import feature's files when it checks for that product name.
- **Organizations under Hub:** creation, members and invitations are off. Renaming and deleting organizations, which the fork allowed before, are also refused under Hub.
- **Fork sign-in screens:** kept whole, so upstream's provider chooser and demo button are not shown even outside Hub mode. The API still offers them when configured.
- **Subagents:** upstream runs helpers as background runs now, so the fork's in-process subagent fallback and its tests are gone.

## Verification

- `pnpm install --frozen-lockfile` passes; the merged lockfile was already consistent.
- Lint has 0 errors. `db:generate` passes. Typecheck passes in all 24 packages, including `astro check`.
- Vitest, final run: 30,426 passed and 8 failed. Seven are the Linux desktop screen-session tests in `desktop-runtime.test.ts` (the same host-specific group as syncs #4 and #5). The eighth, `database-outage-errors.test.ts`, is an unchanged upstream test that passes alone and passed in the first run.
- The eight CI Python suites and the two standalone computer tests pass.
- Postgres tests, image builds and e2e run in CI.
