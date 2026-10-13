# CAAH-88: Upstream Catch-Up Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Plan only. No conflicts are resolved until the PM approves this plan and the decisions in "Decisions for the PM".

**Goal:** Bring 166 upstream commits (`elie222/rakazo` `main` at `afa31774`) into `TukaTek/agent-hub` `main` in one real merge commit. Our CortexAI Agent Hub branding, Hub auth and policy, Microsoft SSO through Hub, Office attachments, modern computer desktop, Composio fix and bot-file download fix must all survive.

**Architecture:** Run `git merge --no-ff upstream/main` on this branch. Then resolve conflicts one area at a time, and apply a scripted rebrand to upstream code that merged without conflicts but still carries upstream names. Make the deliberate behavior reconciliations (auth capabilities, secret store, attachment links) as separate follow-up commits on top of the merge commit, each with its own tests, so a reviewer can approve them one at a time. The merge commit keeps both parents, so the next sync starts from this one.

**Tech Stack:** git (`merge-tree`, `merge --no-ff`), pnpm workspaces, Turbo, Biome, TypeScript, Vitest, Prisma migrations on Postgres, Playwright (web), Lingui, Expo, Docker images (computer, supervisor, app, updater).

## Global Constraints

- Ours wins on branding: `@cortexai-agent-hub/*` package names, `CortexAI Agent Hub` product name, `cortexai-agent-hub` user, paths, headers, labels, scheme and image names (`ghcr.io/tukatek/agent-hub/{app,computer,updater}`), mobile id `com.tukatek.cortexai.agenthub`. `LICENSE` and `NOTICE` keep their upstream attribution unchanged.
- Hub mode stays fail closed (CAAH-36). `HUB_POLICY_ENFORCEMENT=on|off` (CAAH-83) and its health output keep working exactly as today.
- Upstream OIDC SSO is off by default and can never create a session in Hub mode.
- CAAH-72: macro-enabled Office types stay blocked, Office and zip files stay download-only with `X-Content-Type-Options: nosniff`, and non-web links render as text.
- CAAH-87 desktop (xfwm4, Arc-Dark, picom, tint2 dock, `cortexai-agent-hub-desktop-session`, Chromium `libnss_wrapper` fix) stays byte-identical unless a test forces a change.
- PR #28 (Composio connector stack) and PR #27 (bot-file download onto the computer, 100 MB default limit) behavior is preserved.
- Real merge commit: no squash, no rebase. **When this PR is merged into `main`, use "Create a merge commit". Squash or rebase would drop the upstream parent, and the next sync would conflict on all 166 commits again.**
- The PR stays a draft and is never merged by the agent.
- Public repo: no secrets, personal emails, hostnames or account names in commits, logs or the PR. Upstream's Expo `owner` account is not carried over.
- Tests stay deterministic and offline. The desktop Electron Playwright suite runs only in CI.

---

## Inventory (taken Oct 13, 2026)

- `origin/main` = `c67a7e37` (CAAH-87). `upstream/main` = `afa31774` (#1355). Merge base = `c7736142`.
- `main` is **166 commits behind** upstream and **61 ahead** (162 non-merge upstream commits; 955 files changed upstream).
- Trial merge: `git merge-tree --write-tree --name-only origin/main upstream/main` reports **193 conflicting files**: 186 content, 6 modify/delete, 1 add/add. These contain **362 conflict hunks**, and **228** of those hunks involve branding on at least one side.
- **A further 269 files merge cleanly but still contain upstream names**, mostly `@rakazo/*` imports in new upstream code, plus `Rakazo` copy, `RAKAZO_*` env names, `x-rakazo-*` headers, `rakazo.*` Docker labels and `com.rakazo.app`. Without a rebrand sweep they would break the build (the `@rakazo/*` packages don't exist in our workspace) and leak upstream branding.
- Upstream also has two large features the ticket didn't list: **Stripe seat billing with a web paywall (#1227)** and an **optional Infisical secret store behind an async `SecretStore` contract (#1259)**. The second one rewrites code under PR #27 and PR #28.

Reproduce the inventory:

```bash
git remote add upstream https://github.com/elie222/rakazo.git
git fetch upstream main
git rev-list --count origin/main..upstream/main   # 166
git rev-list --count upstream/main..origin/main   # 61
git merge-tree --write-tree --name-only origin/main upstream/main
```

### Conflicts by area

Each entry reads as total hunks / hunks involving branding. A zero means a binary file or a modify/delete conflict.

| Area | Files | Hunks (total / branding) |
|---|---|---|
| Branding assets (icons, favicons, OG image, hero) | 24 | 2 / 2 |
| Auth and Hub sign-in | 12 | 44 / 18 |
| Voice | 1 | 1 / 1 |
| Computer, supervisor, desktop app, updater | 17 | 21 / 21 |
| Attachments and chat markdown | 13 | 20 / 11 |
| Secrets, integrations, MCP, model connections | 15 | 22 / 18 |
| Mobile (other) | 17 | 24 / 18 |
| Marketing site (`apps/www`) | 16 | 47 / 35 |
| Web (other, including 10 Lingui catalogs) | 27 | 111 / 47 |
| API and worker (other) | 10 | 18 / 17 |
| Packages (other: adapters, db, testkit, ui-tokens, ui-web) | 27 | 34 / 25 |
| CI and Compose | 3 | 4 / 3 |
| Docs | 4 | 5 / 5 |
| Lockfile and manifests | 7 | 9 / 7 |

Full file lists:

- **Branding assets:** `apps/desktop/assets/{icon.ico,icon.png,README.md}`, `apps/mobile/assets/{favicon,notification-icon,splash-icon}.png`, `apps/web/public/{apple-touch-icon.png,favicon-16x16.png,favicon-32x32.png,favicon.ico,favicon.svg,icon-192.png,icon-512.png}`, `apps/www/public/{apple-touch-icon.png,favicon-16x16.png,favicon-32x32.png,favicon.ico,favicon.svg,icon-192.png,icon-512.png,og-image.png,avatars/bot-avatar-coordinator.svg}`, `docs/readme-hero.png`, `packages/ui-tokens/assets/README.md`.
- **Auth and Hub:** `packages/auth/src/index.ts`, `apps/api/src/{app.ts,env.ts,health.test.ts}`, `apps/web/src/pages/{Auth.tsx,Auth.test.tsx,Welcome.tsx}`, `apps/web/src/lib/bootstrap.ts`, `apps/mobile/app/sign-in.tsx`, `apps/mobile/lib/session.ts`, `apps/desktop/src/oauth-callback.ts`, `packages/testkit/src/authorization.test.ts`.
- **Voice:** `apps/api/src/voice.ts`.
- **Computer and desktop:** `infra/sandboxes/supervisor/src/index.ts`, `infra/updater/src/index.ts`, `packages/adapters/src/{computer-idle,computer-workspace}.ts` and their tests, `packages/adapters/src/{box,daytona,docker}-sandbox.test.ts`, `packages/adapters/src/sandbox-conformance.test.ts`, `apps/web/src/lib/computer-sandbox.ts`, `apps/mobile/components/computer-{maintenance-actions,mode-picker,update-progress}.tsx`, `apps/desktop/src/{main.ts,window-open.ts,window-open.test.ts}`.
- **Attachments and markdown:** `packages/core/src/{attachments.ts,attachments.test.ts,message-quote.ts}`, `packages/contracts/src/attachments.ts`, `packages/testkit/src/attachments.test.ts`, `packages/chat-ui/src/{markdown.web.tsx,markdown.web.css,markdown.native.tsx,markdown.native.test.tsx}`, `apps/web/src/components/AskCard.tsx`, `apps/web/src/lib/chat-markdown.test.tsx`, `apps/web/e2e/markdown-images.spec.ts`, `apps/mobile/lib/pick-attachments.test.ts`.
- **Secrets and integrations:** `packages/adapters/src/{secrets,bot-secrets,run-secret,integration-provider-settings,integration-provider-settings.test,installed-connectors,mcp-connector,mcp-oauth,model-connect,pi-oauth,pi-codex-catalog,pi-runtime,pi-openai-compatible-provider.test}.ts`, `apps/api/src/agent-secrets.ts`, `apps/mobile/app/(settings)/integrations.tsx`.
- **Mobile:** `apps/mobile/app/{account,ai-data-sharing}.tsx` (modify/delete), `apps/mobile/app/{_layout,index,thread,bot-settings}.tsx`, `apps/mobile/app/(settings)/models.tsx`, `apps/mobile/components/bot-member-picker.tsx`, `apps/mobile/lib/{api.ts,api.test.ts,ai-consent.test.ts,bot-lifecycle.ts,i18n.test.ts,inbox.test.ts}`, `apps/mobile/lib/locales/{de,ru,zh}.ts`.
- **Marketing site:** `apps/www/e2e/marketing-homepage.spec.ts` (modify/delete), `apps/www/src/{agent-content.ts,agent-content.test.ts,demo.ts,site.ts,middleware.test.ts}`, `apps/www/src/i18n/{home,demo}.ts`, `apps/www/src/components/{Footer,HomePage,Logo}.astro`, `apps/www/src/components/ProductDemo.tsx`, `apps/www/src/layouts/BaseLayout.astro`, `apps/www/src/pages/{404,about,support}.astro`.
- **Web:** `apps/web/src/locales/{de,en,es,fr,hi,ko,pt-BR,ru,tr,zh-CN}/messages.po`, `apps/web/src/{App.tsx,lib/model-catalog.ts,lib/thread-events.ts}`, `apps/web/src/pages/{AccountSettingsOverlay,ActivityList,RoutineEditor,RoutineSchedule,SettingsOverlay,Shell}.tsx`, `apps/web/src/pages/shell/{bot-credentials,bot-panel,dialogs}.tsx`, `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/e2e/{avatar-motion.spec.ts,fixtures/avatar-motion.tsx,routine-crud.spec.ts}`.
- **API and worker:** `apps/api/src/{router.ts,router.test.ts,runs.ts,team-chat-judge.ts,thread-message-pages.ts,thread-target.ts,webhook.ts,webhook.test.ts,webhook-inbound.ts}`, `apps/worker/src/index.ts`.
- **Packages:** `packages/adapter-kit/src/types.ts`, `packages/adapters/src/{agent-environment,auto-review,background-job-handlers,builtin-tools,child-bots,executor,executor.test,expo-push,history-compaction,memory-provider-factory,model-selection,model-selection.test,shell-command-stream,tool-loop}.ts`, `packages/db/src/{repos,thread-listing}.ts`, `packages/testkit/src/{connections.test,journeys.test}.ts`, `packages/testkit/src/cli/{evals,harness}.ts`, `packages/testkit/src/evals/runner.ts`, `packages/ui-tokens/src/{index.ts,tokens.css,appearance.test.ts}`, `packages/ui-web/src/{bot-avatar.tsx,styles.css}`.
- **CI and Compose:** `infra/compose/docker-compose{,.images,.prod}.yml`. No workflow file conflicts. Upstream's changes to `ci.yml` (4 lines) and `playwright.yml` merge cleanly, and upstream adds `release-android-apk.yml`.
- **Docs:** `AGENTS.md`, `README.md`, `CHANGELOG.md`, `docs/agent-verification.md`.
- **Lockfile and manifests:** `pnpm-lock.yaml`, `package.json`, `apps/{desktop,mobile,web}/package.json`, `packages/auth/package.json`, `apps/mobile/app.json`.

### Migrations

Upstream adds 10 Prisma migrations. Our 3 Hub migrations interleave with them by timestamp:

| Migration | Side | Effect |
|---|---|---|
| `20260907000000_hub_auth` | ours | `hub_identity`, `hub_session` |
| `20260907010000_hub_tenant_auth` | ours | `hub_session` columns |
| `20261002080000_routine_model` | upstream | `routines` and `runs` model columns |
| `20261002120000_run_model_pinned` | upstream | `runs.modelPinned` |
| `20261002130000_steering_model_pin` | upstream | `steering_messages` model columns |
| `20261002150000_hub_policy_snapshot` | ours | `hub_policy_snapshot` |
| `20261007010000_history_search` | upstream | `CREATE INDEX CONCURRENTLY` on `messages` |
| `20261007100000_complete_usage_accounting` | upstream | `usage_records` columns and a unique `callId` index |
| `20261007120000_billing_accounts` | upstream | `billing_accounts` (FK to organizations) |
| `20261008120000_bot_disabled_builtin_tools` | upstream | `bots.disabledBuiltinTools` |
| `20261008190000_model_backup_list` | upstream | `space_backup_models` |
| `20261009120000_add_boards` | upstream | `boards`, `tickets`, `ticket_comments` |
| `20261010120000_artifact_client_nonce` | upstream | `artifacts.clientNonce` and a unique index |

None of them touch the same table or column, and `packages/db/prisma/schema.prisma` merges cleanly. The risk is ordering. A deployed database has `20261002150000_hub_policy_snapshot` applied but not the three upstream migrations dated earlier. `prisma migrate deploy` applies any unapplied migration regardless of order, so this works, but `prisma migrate dev` flags the history as diverged on developer databases. Upstream migrations are never renamed, because renaming them would break the next sync. Two more risks get explicit checks: `history_search` uses `CONCURRENTLY`, so it must run outside a transaction, and the `usage_records_callId_key` unique index fails if a deployed database already has duplicate `callId` values.

### New and changed env flags (for DevOps)

Every new flag defaults to "off" or to today's behavior. A deployment that changes nothing keeps working, as long as Task 3's guard is in place.

| Flag | Default | Notes |
|---|---|---|
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | unset | Upstream OIDC SSO. All three must be set together, and the issuer must be HTTPS. **Leave them unset in Hub mode**; Task 3 makes them a startup error there. |
| `OIDC_NAME` | `SSO` | Button label. |
| `OIDC_SCOPES` | `openid email profile` | |
| `OIDC_ALLOW_SIGNUP_BYPASS` | `false` | Lets OIDC sign-ups skip the signup allowlist. |
| `AUTH_PASSWORD_ENABLED` | `true` | `false` requires OIDC. Has no effect in Hub mode, where password sign-in is already off. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` | unset | Upstream seat billing and web paywall. **Leave them unset** (see decision D3). |
| `TICKET_BOARD_ENABLED` | `false` | Read by both the API and the worker. Set it on both or neither. |
| `SECRET_STORE` | `encrypted` | `infisical` switches to Infisical. Switching back needs upstream's reverse migration. |
| `INFISICAL_URL`, `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`, `INFISICAL_PROJECT_ID`, `INFISICAL_ENVIRONMENT`, `INFISICAL_FOLDER`, `INFISICAL_ALLOW_INSECURE_HTTP` | unset / `false` | Used only with `SECRET_STORE=infisical`. |
| `SANDBOX_IDLE_MS` | `600000` | Existing flag. `0` now means "never put the computer to sleep" (#1115). |
| `CORTEXAI_AGENT_HUB_ALLOWED_HOSTS` | unset | Web dev server only (upstream `RAKAZO_ALLOWED_HOSTS`, #1365). Not used in production. |

Existing flags that must not change: `HUB_*` (including `HUB_POLICY_ENFORCEMENT` and `HUB_SSO_ENABLED`), `ENCRYPTION_KEY`, and the PR #27 file-download limit and timeout variables in `packages/adapters/src/bot-secrets.ts`.

---

## How upstream OIDC SSO and Hub interact

There are three sign-in configurations. Hub mode is on when the `HUB_*` connection settings are present (`hubAuthFromEnv`).

1. **Hub mode** (our deployments). `packages/auth/src/hub.ts` already rejects every Better Auth path that isn't on an allowlist (`rejectHubAccountMutation`). Upstream's OIDC paths (`/sign-in/social` with provider `oidc`, `/oauth2/callback/oidc`) and its new `/request-account-deletion` are not on that list, so they return `403 Sign in through CortexAI Hub` even before this plan changes anything. On top of that, Task 3:
   - makes `OIDC_ISSUER` (or any `OIDC_*`) together with Hub mode a **startup configuration error**, so the conflict fails loudly at boot instead of quietly at sign-in;
   - registers no OIDC provider in Better Auth while Hub mode is on;
   - sends `sso: null`, `passwordAuth: false` and `billing: false` from `/api/auth/capabilities` in Hub mode, so no client ever shows the OIDC button.

   Microsoft SSO through Hub (CAAH-58, `HUB_SSO_ENABLED`) keeps its own path (`/hub/sign-in`, the Hub SSO callback with PKCE). It is reported to clients as `hubSso` (see decision D2). With `HUB_POLICY_ENFORCEMENT=off` (CAAH-83), Hub is still the only way to sign in. Only the Hub registration and policy gate becomes optional, and the guard above still applies.
2. **Local mode, no OIDC** (default self-host). Exactly as upstream: password sign-in, no SSO button.
3. **Local mode with OIDC** (upstream feature, opt-in). Upstream behavior, rebranded: the trusted mobile origin becomes `cortexai-agent-hub://`, and so on.

The negative test, "Hub mode plus OIDC configuration never creates a session", lives in `packages/auth/src/hub.postgres.test.ts` and runs in the Postgres journeys.

---

## Decisions for the PM

These are the defaults this plan uses. Approving the plan approves them, unless you mark one otherwise.

- **D1. OIDC in Hub mode is a startup error**, not silently ignored. This fails closed and is consistent with CAAH-36.
- **D2. Auth capabilities contract.** Upstream's `AuthCapabilities.sso` is an object (`{ name, availability } | null`) for OIDC, while ours is a boolean meaning Hub Microsoft SSO. Keep upstream's `sso` meaning (fewer conflicts on every future sync), and add `mode: "hub" | "local"` and `hubSso: boolean` to the shared `AuthCapabilities` contract. Web and mobile read `hubSso`. Risk: a mobile build released before this merge reads `sso` as a boolean and would hide the Microsoft button in Hub mode. Email-first Hub sign-in still works on those builds. If that's not acceptable, the alternative is to keep `sso: boolean` and move OIDC to `oidc`, at the cost of editing upstream code on every sync.
- **D3. Billing stays off.** Hub owns tenant licensing, so setting `STRIPE_SECRET_KEY` in Hub mode is a startup error, and the paywall can never block a Hub user.
- **D4. Upstream marketing content is not carried over.** Upstream added a blog, competitor comparison and "alternatives" pages, Discord testimonials, App Store and APK links, and a Terms of Service with upstream's billing and refund terms (#1221, #1224–#1252, #1305, #1308, #1310). These describe upstream's product and company, and a mechanical rebrand would misrepresent us. The merge removes those added pages and assets from `apps/www`, while keeping upstream's site fixes (404 indexing, hreflang, legal page styles). Reviving any of it is a separate ticket.
- **D5. Android APK workflow.** Keep `.github/workflows/release-android-apk.yml`, rebranded to our package id and APK name. It only runs on manual dispatch, so it stays inert until the signing secrets it reads are added.
- **D6. Mobile version.** Keep our `apps/mobile/app.json` `version: 1.0.4` release line, our name, slug and scheme, and our notification color. Upstream's Expo `owner` is dropped.
- **D7. Product copy.** Our rebrand renamed some user-facing "bot" text to "Assistant". Where upstream changed a string we had already renamed, use our wording. New upstream strings keep upstream wording. A separate copy ticket can decide on a global rename.

---

## Files created or modified outside conflict resolution

- Create: `scripts/upstream-rebrand.mjs`, the deterministic rename sweep (reusable for future syncs).
- Create: `scripts/upstream-rebrand.test.mjs`, a Vitest unit test for the mapping.
- Modify: `packages/contracts/src/auth.ts` (`authCapabilitiesSchema`: add `mode`, `hubSso`).
- Create: `apps/api/src/auth-capabilities.ts` and its test (one pure function behind `/api/auth/capabilities`).
- Modify: `apps/api/src/env.ts` (the Hub, OIDC and Stripe guard).
- Modify: `packages/auth/src/index.ts`, `packages/auth/src/hub.postgres.test.ts`.
- Modify: `packages/adapters/src/bot-secrets.ts` (PR #27 on the async `SecretStore`), `packages/adapters/src/integration-provider-settings.ts` (PR #28 on the async `SecretStore`).
- Modify: `packages/chat-ui/src/markdown.web.tsx` (upstream `MarkdownAnchor` plus CAAH-72 text-only links).
- Modify: `.env.example`, `infra/compose/.env.images.example`, `docs/hub-auth.md` (the new flags and the Hub/OIDC rule).

---

### Task 1: Rebrand sweep script, written test-first

**Files:**
- Create: `scripts/upstream-rebrand.mjs`
- Test: `scripts/upstream-rebrand.test.mjs`
- Modify: `vitest.config.ts` (add `"scripts/**/*.test.mjs"` to `test.include`, so `pnpm test` runs it in CI)

**Interfaces:**
- Produces: `rebrand(text: string): { text: string; unresolved: string[] }` and a CLI `node scripts/upstream-rebrand.mjs [--check] <files…>`. `--check` exits 1 and lists files that still contain `rakazo` (any case) outside `LICENSE` and `NOTICE`.

The mapping is ordered, so the longer forms win. Every rule comes from what our tree already uses:

| Upstream | Ours |
|---|---|
| `com.rakazo.app` | `com.tukatek.cortexai.agenthub` |
| `github.com/elie222/rakazo` | `github.com/TukaTek/agent-hub` |
| `RAKAZO_` / `RAKAZO` | `CORTEXAI_AGENT_HUB_` / `CORTEXAI_AGENT_HUB` |
| `rakazo` + capital letter (`rakazoBotId`) | `cortexAiAgentHub` + the same letter |
| `Rakazo` + capital letter (`RakazoNetworkCache`) | `CortexAiAgentHub` + the same letter |
| `Rakazo` (prose) | `CortexAI Agent Hub` |
| `rakazo` (`@rakazo/core`, `x-rakazo-space-id`, `rakazo.botId`, `rakazo://`, `@rakazo.test`) | `cortexai-agent-hub` |

`rakazo.com` addresses and URLs (`hello@`, `security@`, `support@`, a personal address, sitemap and privacy URLs) are **not** rewritten mechanically. Our tree replaced them with the CortexAI contact URL or `example.com`. The script reports them as `unresolved` so each one is fixed by hand.

- [ ] **Step 1: Write the failing test** (add `"scripts/**/*.test.mjs"` to `test.include` in `vitest.config.ts` first, or Vitest won't find the file)

```js
import { describe, expect, it } from "vitest";
import { rebrand } from "./upstream-rebrand.mjs";

describe("rebrand", () => {
  it.each([
    ['import { a } from "@rakazo/core";', 'import { a } from "@cortexai-agent-hub/core";'],
    ['headers["x-rakazo-space-id"]', 'headers["x-cortexai-agent-hub-space-id"]'],
    ['labels["rakazo.botId"]', 'labels["cortexai-agent-hub.botId"]'],
    ["process.env.RAKAZO_ALLOWED_HOSTS", "process.env.CORTEXAI_AGENT_HUB_ALLOWED_HOSTS"],
    ["window.rakazoComputerKeyboard", "window.cortexAiAgentHubComputerKeyboard"],
    ["class RakazoNetworkCache {}", "class CortexAiAgentHubNetworkCache {}"],
    ['appName: "Rakazo"', 'appName: "CortexAI Agent Hub"'],
    ['"rakazo://"', '"cortexai-agent-hub://"'],
    ["com.rakazo.app", "com.tukatek.cortexai.agenthub"],
    ["user@rakazo.test", "user@cortexai-agent-hub.test"],
    ["https://github.com/elie222/rakazo/releases", "https://github.com/TukaTek/agent-hub/releases"],
  ])("maps %s", (input, output) => {
    expect(rebrand(input)).toEqual({ text: output, unresolved: [] });
  });

  it("leaves rakazo.com addresses for a person to resolve", () => {
    expect(rebrand("mailto:security@rakazo.com").unresolved).toEqual(["security@rakazo.com"]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run scripts/upstream-rebrand.test.mjs`
Expected: FAIL, because the module `./upstream-rebrand.mjs` does not exist yet.

- [ ] **Step 3: Implement the script**

```js
#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const RULES = [
  [/com\.rakazo\.app/g, "com.tukatek.cortexai.agenthub"],
  [/github\.com\/elie222\/rakazo/g, "github.com/TukaTek/agent-hub"],
  [/RAKAZO/g, "CORTEXAI_AGENT_HUB"],
  [/\brakazo(?=[A-Z])/g, "cortexAiAgentHub"],
  [/\bRakazo(?=[A-Z])/g, "CortexAiAgentHub"],
  [/Rakazo/g, "CortexAI Agent Hub"],
  [/rakazo(?!\.com)/g, "cortexai-agent-hub"],
];
const UNRESOLVED = /[\w.+-]*@?rakazo\.com[\w./-]*/g;
const KEEP = new Set(["LICENSE", "NOTICE"]);

export function rebrand(input) {
  const unresolved = [...new Set(input.match(UNRESOLVED) ?? [])];
  const text = RULES.reduce((out, [pattern, value]) => out.replace(pattern, value), input);
  return { text, unresolved };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv[2] === "--check";
  const files = process.argv.slice(check ? 3 : 2).filter((file) => !KEEP.has(file));
  let failed = false;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (check) {
      if (/rakazo/i.test(source)) {
        console.log(file);
        failed = true;
      }
      continue;
    }
    const { text, unresolved } = rebrand(source);
    if (text !== source) writeFileSync(file, text);
    for (const value of unresolved) {
      console.log(`${file}: resolve by hand: ${value}`);
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm exec vitest run scripts/upstream-rebrand.test.mjs`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/upstream-rebrand.mjs scripts/upstream-rebrand.test.mjs vitest.config.ts
git commit -m "CAAH-88: add a deterministic upstream rebrand sweep"
```

### Task 2: Merge commit with every conflict resolved, and the build compiles

This task is one commit: the merge commit itself. Inside it, resolve by area in this order, and record each file's resolution in the conflict-resolution log (`/tmp/caah-88-resolution.md`, copied into the PR description).

**Files:** all 193 conflicting files listed above, plus the 269 files the sweep touches.

- [ ] **Step 1: Start the merge**

```bash
git fetch upstream main
git merge --no-ff --no-commit upstream/main
```

Expected: `Automatic merge failed`, with 193 unmerged paths (`git diff --name-only --diff-filter=U | wc -l`). If the count is different, upstream has moved. Stop and redo the inventory.

- [ ] **Step 2: Branding assets (24 files), ours wins**

```bash
git checkout --ours -- apps/desktop/assets apps/mobile/assets apps/web/public apps/www/public/{apple-touch-icon.png,favicon-16x16.png,favicon-32x32.png,favicon.ico,icon-192.png,icon-512.png,og-image.png} docs/readme-hero.png packages/ui-tokens/assets/README.md
git add apps/web/public/favicon.svg apps/www/public/favicon.svg apps/www/public/avatars/bot-avatar-coordinator.svg
git rm -q --cached apps/www/public/brand/rakazo-mark.png apps/www/public/favicon.png 2>/dev/null; rm -f apps/www/public/brand/rakazo-mark.png apps/www/public/favicon.png
pnpm brand:generate && git diff --exit-code -- apps/*/public apps/*/assets
```

For the modify/delete favicons and the coordinator avatar, keep ours, then confirm every `index.html` and layout still points at them: `rg -n 'favicon|bot-avatar-coordinator' apps/web/index.html apps/www/src`. Risk: upstream code that now references the new orange `favicon.png` or `rakazo-mark.png`. Point those references at our assets.

- [ ] **Step 3: Manifests and lockfile (7 files)**

Package names, `name`, `slug`, `scheme`, the notification color and the version come from ours. Dependency versions are the union, taking the newer version, including `better-auth` 1.7.7 (#1307), `@better-auth/expo` and the Expo SDK 57 alignment (#1364). Drop upstream's Expo `owner`. Then regenerate the lockfile instead of hand-merging it:

```bash
git checkout --theirs pnpm-lock.yaml
pnpm install --no-frozen-lockfile
pnpm install --frozen-lockfile   # must succeed with no changes
```

Risk: our Hub plugin depends on Better Auth internals, and 1.7.7 is a security release. Never downgrade it. Fix the Hub code instead (Task 3 covers the tests).

- [ ] **Step 4: Branding-only hunks in code**

For every hunk where the only difference is naming, take upstream's code, then run the sweep over it. Most of the computer, voice, API/worker, packages and www hunks are like this (for example the supervisor's `x-…-bot-id` header hunk, which takes upstream's `botId` variable plus our header name).

```bash
git diff --name-only --diff-filter=U > /tmp/unmerged.txt
# Resolve each hunk in an editor, then:
node scripts/upstream-rebrand.mjs $(git diff --cached --name-only --diff-filter=AM; cat /tmp/unmerged.txt)
```

- [ ] **Step 5: Area-specific resolutions** (the behavior is reconciled in Tasks 3 to 6, but it has to compile here)

| Area | Resolution |
|---|---|
| Auth (`packages/auth/src/index.ts`) | Keep all our Hub exports, options (`hub`, `hubPolicy`, `tokenEncryptionKey`, `onHubSsoError`) and plugin selection (`hub ? hub.plugin : localSignInPlugin`), together with upstream's `afterDeleteSession`, `afterReplaceSession`, `passwordAuth`, `oidc`, `expo()`, `accountSecurity` and account linking. `emailAndPassword.enabled = !hub && env.passwordAuth !== false`. The rate-limit rules are upstream's database storage, plus `/request-account-deletion`, plus our `HUB_SIGN_IN_RATE_LIMITS`. The before-hook runs `if (hub) rejectHubAccountMutation(ctx.path)` **before** upstream's OIDC re-authentication branch. `appName` is ours, and the trusted origin is `cortexai-agent-hub://`. |
| API (`app.ts`, `env.ts`) | Keep both sides' fields (`hubAuth` and `passwordAuth`, `oidc`, the secret store options). Keep our `createUserWorkAuthorizer` wiring with upstream's `contextStrategy` and `runtime`, and upstream's `no-store` cache header middleware. Use upstream's `requestSession` and `actorFromMembership` refactor with our header name. Capabilities are merged in Task 4. |
| Web `Auth.tsx`, `Welcome.tsx`, `bootstrap.ts`, mobile `sign-in.tsx`, `session.ts`, desktop `oauth-callback.ts` | Our email-first Hub flow and Hub SSO button stay. Upstream's OIDC option ("single sign-on below the form", #1277) renders only when `capabilities.sso` is non-null. `Auth.test.tsx` (add/add): keep both sets of tests in one file. |
| Mobile `account.tsx`, `ai-data-sharing.tsx` (deleted upstream, moved to `app/(settings)/`) | Accept the deletion. Port our only edits (our "Assistant" wording, 6 lines) into `app/(settings)/account.tsx` and `app/(settings)/ai-data-sharing.tsx`. |
| www `marketing-homepage.spec.ts` (deleted upstream) | Accept the deletion. Our edits there were branding only. |
| `ui-tokens` | Union: keep our `brand*` tokens, and take upstream's `statusWorking` and its updated `overlay` and `scrollbar` values. Regenerate `tokens.css` with the package's generator, and don't hand-merge it. |
| Lingui `.po` (10 files) | Resolve hunks (ours wins on branding), then run `pnpm --filter @cortexai-agent-hub/web intl:extract` and `intl:compile`. Check that no msgid lost its translation. |
| Compose (3 files) | Our database user, image names and `HUB_*` blocks stay. Add upstream's `SECRET_STORE`/`INFISICAL_*` and `OIDC_*`/`AUTH_PASSWORD_ENABLED` entries, with empty defaults. |
| Docs | `README.md`, `AGENTS.md` and `docs/agent-verification.md` keep ours. Add any new upstream rule to `AGENTS.md` only if it applies to us. `CHANGELOG.md`: keep ours on top, and add upstream entries rebranded. |
| www (D4) | Remove the upstream-only pages and assets listed in D4, and resolve the remaining hunks in favor of ours. |

- [ ] **Step 6: No upstream names left**

```bash
node scripts/upstream-rebrand.mjs --check $(git ls-files | grep -vE '^(LICENSE|NOTICE|pnpm-lock.yaml)$' | grep -vE '\.(png|ico|webp|jpg)$')
```

Expected: exit 0, no files listed. `rg -n '<<<<<<<|>>>>>>>' $(git ls-files)` must also print nothing.

- [ ] **Step 7: Compile**

```bash
pnpm db:generate && pnpm lint && pnpm check
```

Expected: all three pass. Fix only what the merge broke.

- [ ] **Step 8: Commit the merge**

```bash
git commit --no-edit -m "Merge upstream elie222/rakazo main (afa31774) into CortexAI Agent Hub (CAAH-88)"
git log -1 --format=%P | wc -w   # must be 2
```

### Task 3: Hub mode stays closed with upstream OIDC and billing

**Files:**
- Modify: `apps/api/src/env.ts`
- Test: `apps/api/src/env.test.ts`, `packages/auth/src/hub.postgres.test.ts`

**Interfaces:**
- Consumes: `loadEnv(source)` and upstream's OIDC and Stripe parsing in `apps/api/src/env.ts`, and `createAuth(prisma, env)` plus `hubPolicyForTests` in `packages/auth`.
- Produces: startup errors `"OIDC sign-in can't be combined with Hub sign-in"` and `"Billing can't be combined with Hub sign-in"`.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/env.test.ts`, the Hub SSO cases build an inline `sso` env object (`HUB_AUTH_ORIGIN`, `HUB_SSO_ENABLED`, `HUB_AUTH_TENANT_ID`, `HUB_DEPLOYMENT_ID`, `HUB_SERVICE_API_ID`, `HUB_SERVICE_SECRET_FILE` on top of `base`). Add these cases inside that same `it` block, where `sso` is in scope:

```ts
const oidc = {
  OIDC_ISSUER: "https://idp.example.test",
  OIDC_CLIENT_ID: "fixture-client",
  OIDC_CLIENT_SECRET: "fixture-secret",
};
expect(() => loadEnv({ ...sso, ...oidc })).toThrow("OIDC sign-in can't be combined with Hub sign-in");
expect(() => loadEnv({ ...sso, STRIPE_SECRET_KEY: "sk_test_placeholder" })).toThrow(
  "Billing can't be combined with Hub sign-in",
);
expect(loadEnv({ ...sso, HUB_POLICY_ENFORCEMENT: "off" }).oidc).toBeUndefined();
expect(loadEnv({ ...base, ...oidc }).oidc?.issuer).toBe("https://idp.example.test");
```

In `packages/auth/src/hub.postgres.test.ts`, add a case to the first `describePostgres` block. It reuses that block's `config`, `fetch` stub and `createAuth` call, and adds an `oidc` option so the OIDC provider would be registered if the Hub guard were missing:

```ts
it("rejects upstream OIDC, sign-up and account-deletion paths in Hub mode", async () => {
  const db = createDb(process.env.DATABASE_URL!);
  try {
    const auth = createAuth(db.prisma, {
      secret: "offline-auth-secret-at-least-32-characters",
      tokenEncryptionKey: "offline-test-encryption-key",
      baseURL: "http://web.example.test",
      webOrigin: "http://web.example.test",
      hub: config,
      hubPolicy: hubPolicyForTests(config.tenantId, []).policy,
      oidc: {
        issuer: "https://idp.example.test",
        clientId: "fixture-client",
        clientSecret: "fixture-secret",
        name: "SSO",
        scopes: ["openid", "email", "profile"],
        allowSignupBypass: false,
      },
      signupsEnabled: "false",
      signupAllowlist: "",
    });
    for (const path of ["/sign-in/social", "/sign-up/email", "/request-account-deletion"]) {
      const response = await auth.handler(
        new Request(`http://web.example.test/api/auth${path}`, {
          method: "POST",
          headers: { origin: "http://web.example.test", "content-type": "application/json" },
          body: JSON.stringify({ provider: "oidc", email: "user@example.test", password: "x" }),
        }),
      );
      expect(response.status, path).toBe(403);
    }
    expect(await db.prisma.session.count({ where: { user: { email: "user@example.test" } } })).toBe(0);
  } finally {
    await db.prisma.$disconnect();
    await db.pool.end();
  }
});
```

Here `config` is the first test's Hub config, lifted to the `describePostgres` scope so both tests share it. The `oidc` option fields follow upstream's `OidcConfig` in `packages/auth/src/oidc.ts`. Adjust the names to that type if they differ.

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm exec vitest run apps/api/src/env.test.ts` and `VERIFY_DATABASE=1 DATABASE_URL=postgres://… pnpm exec vitest run packages/auth/src/hub.postgres.test.ts`
Expected: the two `toThrow` assertions in `env.test.ts` FAIL (nothing is thrown). The Postgres case should already pass, which confirms the Hub allowlist holds. If it fails, that is a real hole: fix it in Step 3 before anything else.

- [ ] **Step 3: Implement the guard in `apps/api/src/env.ts`**, right after `hubAuth` and `oidc` are parsed:

```ts
if (hubAuth && oidc) throw new Error("OIDC sign-in can't be combined with Hub sign-in");
if (hubAuth && stripeSecretKey) throw new Error("Billing can't be combined with Hub sign-in");
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `pnpm exec vitest run apps/api/src packages/auth/src`, then `pnpm test:integration`
Expected: PASS, including the existing CAAH-36, CAAH-58 and CAAH-83 tests and the new Postgres case.

- [ ] **Step 5: Commit**

```bash
git commit -am "CAAH-88: keep Hub sign-in closed to upstream OIDC and billing"
```

### Task 4: One auth capabilities contract (D2)

**Files:**
- Modify: `packages/contracts/src/auth.ts` (upstream's `authCapabilitiesSchema`), `apps/api/src/app.ts` (`/api/auth/capabilities`), `apps/web/src/pages/Auth.tsx`, `apps/mobile/app/sign-in.tsx`
- Create: `apps/api/src/auth-capabilities.ts`
- Test: `apps/api/src/auth-capabilities.test.ts` (new), `apps/web/src/pages/Auth.test.tsx`, `apps/mobile/lib/api.test.ts`

**Interfaces:**
- Produces, in `packages/contracts/src/auth.ts`: `authCapabilitiesSchema` gains `mode: z.enum(["hub", "local"]).default("local")` and `hubSso: z.boolean().default(false)`. The defaults let a client parse a reply from a server that doesn't send these fields yet.
- Produces, in `apps/api/src/auth-capabilities.ts`: `authCapabilities(input: { hub: boolean; hubSso: boolean; passwordAuth: boolean; oidc?: { name: string; availability: "available" | "unavailable" | "checking" }; resetUrl: string | null; billing: boolean }): AuthCapabilities`

- [ ] **Step 1: Write the failing API test**

```ts
// apps/api/src/auth-capabilities.test.ts
import { authCapabilitiesSchema } from "@cortexai-agent-hub/contracts";
import { describe, expect, it } from "vitest";
import { authCapabilities } from "./auth-capabilities.js";

const reset = "https://web.example.test/reset-password";

describe("authCapabilities", () => {
  it("reports Hub mode without OIDC, password sign-in or billing", () => {
    const value = authCapabilities({
      hub: true,
      hubSso: true,
      passwordAuth: true,
      oidc: { name: "SSO", availability: "available" },
      resetUrl: reset,
      billing: true,
    });
    expect(value).toEqual({
      mode: "hub",
      hubSso: true,
      sso: null,
      passwordAuth: false,
      passwordReset: false,
      resetUrl: null,
      billing: false,
    });
    expect(authCapabilitiesSchema.parse(value)).toEqual(value);
  });

  it("keeps upstream local mode with OIDC unchanged", () => {
    expect(
      authCapabilities({
        hub: false,
        hubSso: false,
        passwordAuth: true,
        oidc: { name: "SSO", availability: "checking" },
        resetUrl: reset,
        billing: false,
      }),
    ).toEqual({
      mode: "local",
      hubSso: false,
      sso: { name: "SSO", availability: "checking" },
      passwordAuth: true,
      passwordReset: true,
      resetUrl: reset,
      billing: false,
    });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run apps/api/src/auth-capabilities.test.ts`
Expected: FAIL, because the module `./auth-capabilities.js` does not exist.

- [ ] **Step 3: Implement the function, extend the schema, and use it in `app.ts`**

```ts
// apps/api/src/auth-capabilities.ts
import type { AuthCapabilities } from "@cortexai-agent-hub/contracts";

export function authCapabilities(input: {
  hub: boolean;
  hubSso: boolean;
  passwordAuth: boolean;
  oidc?: { name: string; availability: "available" | "unavailable" | "checking" };
  resetUrl: string | null;
  billing: boolean;
}): AuthCapabilities {
  const passwordAuth = !input.hub && input.passwordAuth;
  return {
    mode: input.hub ? "hub" : "local",
    hubSso: input.hub && input.hubSso,
    sso: input.hub ? null : (input.oidc ?? null),
    passwordAuth,
    passwordReset: passwordAuth && input.resetUrl !== null,
    resetUrl: passwordAuth ? input.resetUrl : null,
    billing: !input.hub && input.billing,
  };
}
```

```ts
// packages/contracts/src/auth.ts, inside authCapabilitiesSchema
  mode: z.enum(["hub", "local"]).default("local"),
  hubSso: z.boolean().default(false),
```

```ts
// apps/api/src/app.ts
app.get("/api/auth/capabilities", (c) =>
  c.json(
    authCapabilities({
      hub: Boolean(env.hubAuth),
      hubSso: Boolean(env.hubAuth?.sso),
      passwordAuth: env.passwordAuth !== false,
      oidc: env.oidc
        ? { name: env.oidc.name, availability: auth.ssoAvailability() ?? "checking" }
        : undefined,
      resetUrl: email ? new URL("/reset-password", env.webOrigin).href : null,
      billing: Boolean(billing),
    }),
  ),
);
```

Then switch web `Auth.tsx` and mobile `sign-in.tsx` from our old `capabilities.sso` boolean to `capabilities.hubSso`. Both read the reply through `authCapabilitiesSchema`.

- [ ] **Step 4: Update the web test stub, add the Hub SSO case, and run everything**

In `apps/web/src/pages/Auth.test.tsx`, `stubServer(mode, …)` currently returns `{ mode, passwordReset: false, resetUrl: null }`. Make it return the full contract, with an optional `hubSso` argument:

```tsx
if (url === "/api/auth/capabilities")
  return Response.json({
    mode,
    hubSso,
    sso: null,
    passwordAuth: mode === "local",
    passwordReset: false,
    resetUrl: null,
    billing: false,
  });
```

Add one case next to the existing CAAH-58 Hub SSO test: with `stubServer("hub", …, { hubSso: true })` the Microsoft button renders and upstream's OIDC option does not. With `hubSso: false`, neither renders. Mirror both cases in `apps/mobile/lib/api.test.ts` for the mobile parser.

Run: `pnpm exec vitest run apps/api/src apps/web/src/pages apps/mobile/lib packages/contracts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "CAAH-88: report Hub and OIDC sign-in in one capabilities contract"
```

### Task 5: PR #27 and PR #28 on upstream's async SecretStore

Upstream turned the synchronous `EncryptedSecretStore` into an async `SecretStore` contract in `@cortexai-agent-hub/adapter-kit`, and added `secret-persistence.ts` and `secret-store-factory.ts`. Our two fixes sit on the old API.

**Files:**
- Modify: `packages/adapters/src/bot-secrets.ts`, `packages/adapters/src/integration-provider-settings.ts`, `apps/api/src/agent-secrets.ts`
- Test: `packages/adapters/src/bot-secrets.test.ts` (ours, already present), `packages/adapters/src/integration-provider-settings.test.ts`, `packages/testkit/src/connections.test.ts`

**Interfaces:**
- Consumes: `SecretStore` (async `get`, `put`, `delete`) from `@cortexai-agent-hub/adapter-kit`, and `persistPreparedSecret` from `./secret-persistence.js`.
- Produces: unchanged public behavior. `bot_secret_file` downloads stream to the computer with the 100 MB default cap and a 120 s default timeout. `createIntegrationConnectorStack(composio, settings, before, after)` still gives the registry exactly one `composio` provider.

- [ ] **Step 1: Run our existing tests against the merged code and confirm they fail**

Run: `pnpm exec vitest run packages/adapters/src/bot-secrets.test.ts packages/adapters/src/integration-provider-settings.test.ts packages/testkit/src/connections.test.ts`
Expected: FAIL or type errors wherever our code still calls the old synchronous store. These existing tests are the spec. In particular, `defaults to a 100 MB file cap` must exist and fail for the right reason, not be deleted.

- [ ] **Step 2: Port `bot-secrets.ts`.** Keep our streaming download (`open`, `link`, `unlink`, the SHA-256 hash, `getRequestTimeoutMs`, combined abort signals, redaction, `RemoteRedirectError` handling and the MIME/extension inference). Replace every `store.decrypt(...)` / `store.encrypt(...)` call with `await secretStore.get(...)` / `persistPreparedSecret(...)`, as upstream does. Take upstream's `withTransactionRetry`.

- [ ] **Step 3: Port `integration-provider-settings.ts`.** Keep our `createIntegrationConnectorStack` (PR #28) next to upstream's `prepareManagedConnectorForTransaction` and `credentialDigest`, with the store parameter typed as `SecretStore`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm exec vitest run packages/adapters/src packages/testkit/src/connections.test.ts`
Expected: PASS, including the 100 MB cap test, the Composio single-registry test, and upstream's new secret-store conformance tests.

- [ ] **Step 5: Commit**

```bash
git commit -am "CAAH-88: keep bot file downloads and the Composio stack on the async secret store"
```

### Task 6: Attachments, zip support and links (CAAH-72 with #1289 and #1206)

Upstream #1289 added zip, which we already allowed. Upstream also has no Office types, so the trial merge drops ours (the `.xlsx`/`.docx`/`.pptx`/`.xls`/`.doc`/`.ppt` hunks and `...ATTACHMENT_OFFICE_MIME_TYPES`). Upstream #1206 replaced the markdown `a` renderer with a `MarkdownAnchor` that asks for confirmation before opening an external link.

**Files:**
- Modify: `packages/core/src/attachments.ts`, `packages/contracts/src/attachments.ts`, `packages/chat-ui/src/markdown.web.tsx`, `packages/chat-ui/src/markdown.native.tsx`
- Test: `packages/core/src/attachments.test.ts`, `packages/testkit/src/attachments.test.ts`, `apps/web/src/lib/chat-markdown.test.tsx`, `packages/chat-ui/src/markdown.native.test.tsx`

- [ ] **Step 1: Run our CAAH-72 tests and confirm they fail if the Office lines were lost**

Run: `pnpm exec vitest run packages/core/src/attachments.test.ts packages/testkit/src/attachments.test.ts apps/web/src/lib/chat-markdown.test.tsx`
Expected: every CAAH-72 case exists and passes after Step 2: Office MIME types allowed, `.xlsm` `.docm` `.pptm` `.xlsb` `.ppsx` rejected, zip allowed, Office and zip responses `Content-Disposition: attachment` with `nosniff`, `file:`/`workspace:`/blank links rendered as `<span>`.

- [ ] **Step 2: Resolve.** Keep both sides in `attachments.ts`: our Office extension and MIME maps, our macro blocklist and `ATTACHMENT_OFFICE_MIME_TYPES`, and upstream's zip entries (deduplicated, not listed twice). In `MarkdownAnchor`, keep upstream's confirm dialog for `http(s)` links, and add our rule as its first branch:

```tsx
function MarkdownAnchor({ node: _node, ...props }: AnchorProps) {
  // urlTransform blanks unsafe URLs. Keep their text without a link that opens the app again.
  if (!props.href) return <InsideLinkContext.Provider value={true}><span>{props.children}</span></InsideLinkContext.Provider>;
  // ...upstream body unchanged...
}
```

- [ ] **Step 3: Add the regression test that ties them together**

In `apps/web/src/lib/chat-markdown.test.tsx`, which renders with `renderToStaticMarkup`:

```tsx
it("keeps workspace paths as text while web links stay links", () => {
  const html = renderToStaticMarkup(
    <ChatMarkdown source={"[report](workspace:/out.xlsx) and [site](https://example.test/)"} />,
  );
  expect(html).toContain("<span>report</span>");
  expect(html).not.toContain('href="workspace:');
  expect(html).toMatch(/<a [^>]*href="https:\/\/example\.test\/"/);
});
```

Upstream's `apps/web/e2e/external-link.spec.ts` already covers the confirm dialog for web links. Add one case to it: clicking the `workspace:` text opens no dialog and no new page.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm exec vitest run packages/core packages/contracts packages/chat-ui apps/web/src/lib packages/testkit/src/attachments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "CAAH-88: keep Office attachments and text-only workspace links next to upstream zip and link confirm"
```

### Task 7: Env documentation for DevOps

**Files:** `.env.example`, `infra/compose/.env.images.example`, `docs/hub-auth.md`, `docs/self-host.md`

- [ ] **Step 1:** Add every flag from "New and changed env flags" to the examples, with the defaults shown there. In `docs/hub-auth.md`, add the rule from "How upstream OIDC SSO and Hub interact" in two sentences.
- [ ] **Step 2:** Run `pnpm test -- apps/api/src/env` (env docs consistency tests, if present) and `pnpm lint`. Expected: PASS.
- [ ] **Step 3:** Commit: `git commit -am "CAAH-88: document upstream env flags for Hub deployments"`.

### Task 8: Full verification (this gates the push)

Run every step on the final branch head, and record the result in words in the PR (no pasted output).

- [ ] `pnpm install --frozen-lockfile`. Expected: no lockfile changes.
- [ ] `pnpm lint`, `pnpm db:generate && pnpm check`, `pnpm build`. Expected: PASS.
- [ ] `pnpm test` (unit). Expected: PASS.
- [ ] **Migrations on our current schema:** start Postgres, check out `origin/main`, run `pnpm db:migrate` (this is our production state), seed with `pnpm test:integration` fixtures, check out the branch, run `pnpm --filter @cortexai-agent-hub/db exec prisma migrate deploy`, then `prisma migrate status`. Expected: 10 migrations applied, "Database schema is up to date", and no drift (`prisma migrate diff --from-migrations --to-schema-datamodel` empty). Also seed two `usage_records` rows with the same `callId` on the old schema to confirm what the unique index does, and record the behavior.
- [ ] `pnpm test:integration` (Postgres journeys). Expected: PASS, including the Hub journeys.
- [ ] Web E2E: `pnpm --filter @cortexai-agent-hub/web e2e`. Expected: PASS. Desktop Electron e2e runs in CI only.
- [ ] Image validation: `pnpm sandbox:build`, then the computer smoke (`infra/sandboxes/computer/desktop_smoke.py` and `office_smoke.py` through `pnpm test:computer`), and `pnpm test:compose-smoke`. Expected: xfwm4, picom and tint2 are running, `cortexai-agent-hub-desktop-session` is present, Chromium launches with `libnss_wrapper`, the image runs as uid 1000, and the image size stays within +5 MB of `main`.
- [ ] Targeted checks (each one a test or a scripted request against a local stack):
  - Hub sign-in with `HUB_POLICY_ENFORCEMENT=off`: sign-in through the Hub fake succeeds, and `/health` reports the policy as disabled, same shape as CAAH-83. With `on` and Hub unreachable, sign-in fails closed.
  - `OIDC_ISSUER` set in Hub mode: the API refuses to start with the Task 3 message.
  - A bot run end to end (offline model emulator, `pnpm test:pi`).
  - Computer use: screenshot, click, type and upload through `pnpm test:computer-replay`, plus a check that the view opens view-only with the "Take control" button (#1314) and that the screen stays visible during a turn (#1287).
  - Office attachment: upload `.docx` (accepted, download-only, `nosniff`) and `.docm` (rejected).
  - PR #27: `bot_secret_file` download of a 101 MB fixture is rejected with the 104857600-byte message.
  - PR #28: the Composio health test passes.
  - Voice: call endpoints answer for an authorized user, refuse an unauthorized one, and ignore a hang-up without an utterance (#1323).
- [ ] `node scripts/upstream-rebrand.mjs --check …` (Task 2 Step 6) still exits 0.

### Task 9: Push and update the draft PR

- [ ] Push the branch: `git push -u origin cursor/caah-88-upstream-catch-up-82e9`.
- [ ] Update the PR description. It should cover why and what, the conflict-resolution log grouped by area (one line per file: ours, upstream, union or ported, and why), the migrations, the new env flags for DevOps, test results in words, and links to the CI E2E screenshots of the sign-in screen and the computer view.
- [ ] Put this at the top of the PR: **"Merge with 'Create a merge commit'. Do not squash or rebase."**
- [ ] Stay with CI and review bots, polling about every 60 s. Fix actionable feedback in new commits. Keep the PR a draft, and never merge it.

---

## Risks

| Risk | Where | Mitigation |
|---|---|---|
| Upstream branding leaks through files that merged cleanly | 269 files | Task 1 sweep plus the `--check` gate in Task 2 and Task 8 |
| OIDC or billing opens a path around Hub | `packages/auth`, `apps/api` | Allowlist (already there), Task 3 startup errors, Task 4 capabilities |
| Better Auth 1.7.7 breaks Hub plugin internals | `packages/auth/src/hub.ts` | Typecheck plus Hub unit tests and journeys. Fix Hub code, never downgrade. |
| PR #27 or PR #28 silently reverted by the async store refactor | `bot-secrets.ts`, `integration-provider-settings.ts` | Our existing tests are the gate (Task 5) |
| Office types dropped by a "take theirs" hunk | `core/attachments.ts`, `contracts/attachments.ts` | Task 6 tests |
| Migration order or unique index failure on deployed data | `usage_records_callId_key`, `history_search` | Task 8 migration run on our current schema with seeded duplicates |
| Desktop colors shift through token changes | `ui-tokens` and the CAAH-87 token test | CAAH-87 desktop test plus image smoke |
| Old mobile builds lose the Microsoft button | capabilities contract | D2, with email-first Hub sign-in as the fallback |
| PR merged with squash | GitHub merge button | Callout at the top of the PR, and in this plan |
| Upstream moves before implementation | `upstream/main` | Task 2 Step 1 checks the conflict count. If it moved, redo the inventory and get re-approval. |
