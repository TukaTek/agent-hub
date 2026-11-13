# Upstream Sync #5 (v0.11.0, through #4587)

**Status:** Merged on the branch. Not deployed.

**Goal:** Bring `TukaTek/agent-hub` from upstream `943dd52b` ([sync #4](upstream-sync-4.md)) to upstream `main` at `fdf3b2b3` (release v0.11.0 at `013bc8c8` plus three adapter fixes): 167 commits. Skips and Hub rules are the same as sync #4.

**Architecture:** One batch. Fork main (#77, dependency overrides) was merged first, then `git merge --no-ff --no-commit fdf3b2b3`, then `scripts/upstream-remerge.mjs` (140 files resolved after rebrand and formatting, 12 kept deleted), then the remaining 119 conflicted files by hand.

Notation: `<old>` is upstream's retired product name. Upstream PRs are written "#N".

## Merges

| Step                       | Range                | Merge       |
| -------------------------- | -------------------- | ----------- |
| Fork main (#77 Snyk fixes) | `5b4a1f15..9988f06d` | `6bfe363fe` |
| Upstream v0.11.0           | `943dd52b..fdf3b2b3` | `3c5405a68` |

#77's overrides moved into `pnpm-workspace.yaml` (pnpm 12) in the shape upstream #4290 uses. Its Expo 57 patch bumps are superseded by Expo 58.

## Must stay intact

| Area                       | Resolution                                                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hub sign-in                | No new upstream sign-in paths. The Hub account-mutation guard runs before upstream's new hook code. The signup allowlist fix (#4534, #4544) lands in the shared `emailAllowed` that the Hub signup policy uses. |
| Signup attribution (#4421) | Columns and code taken; nothing is recorded for Hub-managed accounts. The fork's www does not set the attribution cookie or describe it on the privacy page.                                                    |
| Billing and credits        | Upstream's credit changes (#4411, #4431, #4433) taken; still unreachable because Stripe is refused under Hub.                                                                                                   |
| Composio                   | Upstream's toolkit-prefix fix (#4471) taken; the deployment key stays one direct provider, chosen first.                                                                                                        |
| Vault (#4243, #4244)       | The fork's `secret_request` and file download now read values through upstream's content keys and per-bot access, and record use. The fork's error messages, timeout and size caps stay.                        |
| Runtime and messaging      | The fork's Hub user-work authorizer is passed alongside upstream's single delivery path (#4436). `team-chat-ambient.ts` and `team-chat-delivery.ts` moved upstream; the fork had only rebrand changes in them.  |
| Desktop                    | Cloud stays hidden and This computer stays the default, with upstream's new choice layout. Docker-free This computer on Apple silicon (#4324) taken.                                                            |
| Computer image             | The fork's desktop session is kept; upstream's wallpaper-dialog fix (#4425) goes into the fluxbox fallback.                                                                                                     |
| xAI voice                  | Still API key only under Hub.                                                                                                                                                                                   |

## Skips

Same as sync #4: Honcho, Dutch (`nl`), `README.zh-CN.md`/`README.th-TH.md`, the upstream www redesign, the desktop hosted first launch, and the LAN cleartext mobile plugin.

#4253 (optional conversation memory) is taken without Honcho. Its generic plumbing runs through the executor, run tools and background jobs, and later commits build on it. It also adds a Hindsight memory provider, which is taken. Honcho stays out of the registry, factory, tests, docs and catalogs.

## Translations

Catalog conflicts were merged as a union, preferring the fork's translations. Honcho and `nl` entries were dropped. The fork's "Assistant screen" strings replace upstream's "Bot screen" ones.

## Database migrations

25 new migrations, all from upstream.

- **Deferred** (`-- deferred`, applied one deploy later): `20261214120100_drop_hand_rolled_delivery_state` (drops delivery attempt columns on `messaging_outbound` and `external_messages`, and `runs.teamChatMirroredAt`), `20261214120101_drop_messaging_mirror_recovery_idx_concurrent`, `20261215120000_drop_computer_control_run` (drops `computers.controlRunId`).
- **Concurrent indexes:** nine `*_idx_concurrent` migrations.
- **Vault:** `shred_vault_keys` (a user delete removes their vault keys), `vault_item_access` (two migrations: `vault_credential_limits` and `vault_credential_bots` with tenant RLS), `vault_login_also_on`, and `vault_legacy_guard`. The guard adds restrictive policies so the previous release cannot read restricted items during the overlap. Its function grants name `cortexai_agent_hub_app`.
- **Messaging:** `run_reply_delivery_job` (trigger), `queue_unsent_run_replies` (queues replies the previous release left for its recovery scan, run 10 minutes later), and `messaging_outbound_claimed_at`.
- **Other additive:** `bot_email_policy`, `preserve_active_screen_generation`, `model_oauth_session_outcome`, `signup_attribution`, `run_prompt_version`, `message_tool_history`.

## Deploy impact

- Run `migrate` on two consecutive deploys so the three deferred drops apply.
- **Bot email** now has its own transport: `BOT_EMAIL_SMTP_URL`. Without it, bots stop sending email after this deploy; account email is unaffected. Each account starts at 10 bot emails a day (`apps/api/src/cli/bot-email-policy.ts` adjusts it).
- **New settings (all optional):** `BOT_EMAIL_SMTP_URL`, `STUCK_WORK_NOTIFY_AFTER_MS`, `STUCK_WORK_EXPIRE_AFTER_MS`, `CORTEXAI_AGENT_HUB_LOCAL_TOKENS_PER_MINUTE`, `CORTEXAI_AGENT_HUB_LOCAL_PROMPT_CACHE`, `TEAMS_APP_ID`/`TEAMS_APP_PASSWORD`/`TEAMS_APP_TENANT_ID`, `CORTEXAI_AGENT_HUB_API_REPLICAS`/`CORTEXAI_AGENT_HUB_WORKER_REPLICAS`.
- **Production Compose** can run several API and worker containers (#4402). Caddy now balances across API containers. Each container uses its own Postgres connections (see `docs/self-host-*`).
- The mobile AI disclosure version changes to `2026-11-12` (Hindsight is a new recipient), so mobile users are asked for AI data-sharing permission again.

## Fork commits after the merge

- Biome formatting of the merge.
- Secret download helpers moved into `secret-downloads.ts`. Upstream's vault changes had closed an import cycle from the computer lifecycle through `bot-secrets` to the routine watch.
- Upstream tests aligned with fork behavior: the truncation notice after clipped tool results, `secret_request` error results, memory tool fakes, and one rebranded test string.

## Verification

- `pnpm install --frozen-lockfile`, lint, `db:generate` and every package typecheck pass, including `astro check`.
- Vitest passes apart from eight Linux desktop screen-session tests in `desktop-runtime.test.ts`. They are the same host-specific failures sync #4 recorded, and they pass in CI.
- The CI Python suites pass.
- Postgres tests, image builds and e2e run in CI.
