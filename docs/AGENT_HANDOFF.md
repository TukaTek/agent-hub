# Agent Handoff: CortexAI Agent Hub

> Historical snapshot of the reviewed commit below. Later branding, authentication, and upstream changes supersede statements about current implementation. Consult the current code and documentation before acting on this snapshot.
_Last updated: 2026-09-02_
_Reviewed target: `0f5c4cefd59cdbe440deb7e05fd3f503164a6068`_

## Read This First

1. Read root `AGENTS.md`; this public repository has strict secret/public-data rules and one-product/cross-surface conventions.
2. Read `docs/CODEBASE_MAP.md` for the current architecture and risk map.
3. Treat the code's names (`Rakazo`, `Bot`, `Space`) separately from the accepted CortexAI product language (`CortexAI Agent Hub`, `Assistant`, personal Assistant workspace).
4. Check current `origin/main` and `upstream/main`; at the last review they matched exactly.
5. Do not infer CortexAI Hub integration from the local Organization/Space model. Hub OAuth/JWT/JWKS, entitlement, policy delivery, and deployment registration are not implemented.
6. Never read, print, stage, or commit `.env`, credentials, private URLs, customer data, or real production data.

## Safe-Change Rules

- Use a clean isolated worktree for implementation. Never overwrite unrelated local work.
- TDD is required: capture a failing test, make the smallest coherent change, then run targeted and full gates.
- Keep shared behavior/contracts/API/UI in packages or web/shared layers. Platform-specific code should be limited to navigation, native storage, permissions, packaging, and truly native interactions.
- Backend owns authorization, orchestration, retries, recovery, validation, provider translation, and durable state. Clients express intent and render state.
- Keep providers optional behind `packages/adapter-kit`; concrete SDKs/config belong in `packages/adapters` or composition roots.
- Treat auth, secrets, connectors, MCP, sandbox/computer, screen capabilities, shell/file access, messaging webhooks, migrations, updater, and deployment as security-sensitive.
- Do not equate `ExternalEffect` with a complete platform audit log.
- Do not merge or deploy without explicit approval. Every security/tenant/computer/release change needs independent exact-head review.
- For UI changes, add/adjust Playwright coverage and provide the matching E2E screenshot evidence in the PR.

## Product Boundary Rules

- Agent Hub owns persistent personal Assistants, teams/groups, runs, delegation, routines, Assistant computers, human takeover, and ongoing Assistant operations.
- Hub must become the control plane for customer/deployment identity, product entitlement, policy/config, approved providers/models/connectors/skills, and lifecycle. That integration is planned, not current.
- Workbench remains the governed user-driven project/file execution workspace. Agent Hub computers are dedicated persistent Assistant environments, not the user's Workbench or physical device.
- Run remains CortexAI's cross-system automation/orchestration product. Agent Hub has internal durable execution and routines, but do not expand it into the whole platform workflow engine without an explicit product decision.
- SeaweedFS is CortexAI's durable storage standard; current local home/artifact stores are implementation foundations, not the final platform storage contract.
- Phase 1 personal Assistants must remain private to their owner. Future organization-owned shared Assistants require a first-class organization ownership principal; do not fake this by assigning them to an employee user ID.

## Where to Change Things

### Contracts and domain rules

- `packages/contracts/src/rpc.ts` — public typed RPC shape.
- `packages/contracts/src/domain.ts` — domain DTO/Zod schemas.
- `packages/contracts/src/events.ts` — live product-event contract.
- `packages/core/src/*` — deterministic rules and utilities.

Change the contract first when API/client behavior changes, then update server and every applicable client. Keep contract tests current.

### API

- `apps/api/src/app.ts` — composition root, HTTP middleware/mounting, auth/session-to-actor bridge, health.
- `apps/api/src/router.ts` — oRPC implementation; very large and high-risk.
- Focused modules: `thread-target.ts`, `runs.ts`, `artifacts.ts`, `screen-proxy.ts`, `voice.ts`, `webhook.ts`, `messaging-inbound.ts`, `messaging-webhook.ts`, `agent-skills.ts`, `taught-skills.ts`.
- `apps/api/src/env.ts` — environment contract and secure defaults.

All resource operations must derive Space/user ownership from the authenticated actor, not trust IDs from the client.

### Worker and durable execution

- `apps/worker/src/index.ts` — production worker composition.
- `packages/adapters/src/background-job-handlers.ts` — registered job handlers.
- `packages/adapters/src/job-reconciler.ts` — recovery scans and leader election.
- `packages/adapters/src/executor.ts` — run lifecycle/tool loop/approval/computer orchestration; extremely large, change carefully.
- `packages/adapter-kit/src/background-jobs.ts` — typed jobs and keys.

Preserve idempotency, lease/fence checks, recovery, pause/resume, and event ordering. A passing happy-path unit test is insufficient for run-state changes.

### Database / migrations

- `packages/db/prisma/schema.prisma` — source schema.
- `packages/db/prisma/migrations/*` — SQL migrations.
- `packages/db/src/*` — repositories/scoping/transaction helpers.
- `packages/db/src/generated/prisma/*` — generated; never hand-edit.

Use coordinated cutovers for API/worker schema renames. Add isolation and rollback/upgrade evidence for security-sensitive changes. Run Prisma generation and PostgreSQL journeys.

### Auth, ownership, privacy

- `packages/auth/src/index.ts` — Better Auth, signup, deletion, reset.
- `packages/db/src/bootstrap-user.ts` — personal Organization/Space creation and deployment-owner claim.
- `packages/db/src/scope.ts` — session user to selected/default Space actor.
- `packages/testkit/src/authorization.test.ts` and PostgreSQL journeys — negative ownership/IDOR coverage.

Do not weaken personal Assistant privacy or permit deployment owner/admin access to personal content as a shortcut.

### Runtime/providers/integrations

- Interfaces: `packages/adapter-kit/src/interfaces.ts`, `types.ts`.
- Pi/models: `packages/adapters/src/pi-*`, `deployment-model.ts`.
- Computers: `computer-lifecycle.ts`, `computer-control.ts`, `computer-screens.ts`, `computer-workspace.ts`, and provider adapters (`docker-*`, `e2b-*`, `daytona-*`, `box-*`, `desktop-*`).
- Connectors: `composio-*`, `pipedream-*`, `installed-connectors.ts`, `mcp-*`, `remote-mcp.ts`.
- Approval/effects: `packages/core/src/action-approval.ts`, `packages/adapters/src/approval-*`, `auto-review.ts`.
- Memory: `packages/memory`, `memory-*`, `supermemory-*`.
- Voice/messaging/email/web: provider-specific adapters under `packages/adapters`.

New providers need the shared interface plus deterministic offline conformance tests. Do not introduce a hosted-vendor requirement for core use.

### Web

- `apps/web/src/App.tsx` — auth/session route gate.
- `apps/web/src/pages/Shell.tsx` — main product shell; huge/high-risk.
- `apps/web/src/lib/api.ts` and event/thread helpers — server interaction.
- `apps/web/src/components` — reusable app components.
- `apps/web/src/components/beautiful-ui` and `packages/ui-web` — shared primitives.
- `apps/web/src/locales/*` — Lingui catalogs.
- `apps/web/e2e/*` — Playwright journeys/screenshots.

Check Beautiful UI and existing primitives before inventing a new component. Keep copy concise and accessible.

### Desktop

- `apps/desktop/src/main.ts` — Electron main process, server selection, local stack, menu/update behavior.
- `apps/desktop/src/preload.ts` — narrow renderer/native bridge.
- `apps/desktop/e2e` — Electron smoke/E2E.

Electron hosts the web UI. Do not duplicate application logic in the shell. Local-stack and “This Mac” changes are privileged and need threat-focused review.

### Mobile

- `apps/mobile/app/_layout.tsx` — navigation/app bootstrap.
- `app/index.tsx`, `app/thread.tsx` — core list/thread flows.
- `app/models.tsx`, `integrations.tsx`, `voice.tsx`, `routine.tsx`, `account.tsx`, `bot-settings.tsx` — settings/features.
- `apps/mobile/lib` — API/native/storage/appearance behavior.

Shared domain behavior belongs in packages. Explicitly assess mobile parity or document a safe degradation for every cross-surface feature.

### Configuration / deployment

- `.env.example` — variable names/placeholders only; never real values.
- `infra/compose/*` — local, images, and production topologies.
- `infra/sandboxes/supervisor` — private Docker lifecycle service; Docker socket is host control.
- `infra/updater` — privileged, opt-in update/rollback sidecar.
- `docs/self-host.md`, `docs/computer-runtime.md` — operational contracts.
- `.github/workflows/*` — CI/images/releases/reports/mobile OTA/deployment.

## Commands Agents Should Use

Prerequisite: compatible Node. The reviewed repository requires Node 22.22.2+, Node 24, or Node 26+.

Typical loop:

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm lint
pnpm check
pnpm test
pnpm test:integration
pnpm build
git diff --check
git status --short
```

For applicable UI work:

```bash
pnpm test:e2e
```

For computer/provider work, add deterministic provider conformance and targeted integration tests. Live `test:canary`, `test:computer`, or provider-backed E2E requires explicit credentials/scope and is not a substitute for offline tests.

## Patterns to Reuse

- `AdapterContext` for operation/trace/Space/user/Assistant/run scope and cancellation.
- `SandboxProvider` and other adapter-kit contracts for provider-neutral behavior.
- oRPC + Zod shared contracts.
- Prisma composite keys and `updateMany` with actor scope for mutation safety.
- `requireMembership` + actor-derived Space/user context.
- `IsolationError`/not-found behavior to avoid resource enumeration.
- Serializable transaction retry for contested boundary creation.
- Unique client nonce/idempotency keys.
- Run/computer lease fences and stale-worker protection.
- Durable external-effect claim/replay and uncertain-effect settlement.
- Graphile jobs plus reconciliation recovery.
- Local/scripted/fake providers for deterministic tests.
- Portable computer-home checkpoint/restore contract.
- Secrets stored by encrypted reference and redacted from DTOs/logs.
- SSRF-aware endpoint validation and bounded remote responses.

## Patterns to Avoid

- Trusting `spaceId`, `userId`, `botId`, connection IDs, artifact IDs, or screen URLs without actor-bound lookup.
- Adding provider SDK types to contracts/core.
- Putting orchestration/retry/security decisions in web/mobile.
- Hand-editing generated Prisma files.
- Storing credentials in capability config, fixtures, events, logs, snapshots, or prompts.
- Treating Team Computer folders as security isolation.
- Enabling `desktop`/“This Mac” on a shared/public service.
- Exposing API, PostgreSQL, Docker supervisor/socket, screen backend, or updater directly to the internet.
- Expanding `APPROVAL_EXEMPT_TOOLS` or relying on default-allow as CortexAI policy.
- Calling marketing “audit log” language proof of comprehensive auditability.
- Assuming a passing unit suite proves live provider, deployment, backup/restore, or Hub readiness.
- Changing only web for a core workflow without assessing Electron/mobile/messaging.
- Large unreviewable changes to Shell/router/executor.

## Security / Data Safety Notes

- Current core CI at the reviewed SHA passed, but the TukaTek fork had 25 open Dependabot alerts (8 high, 15 medium, 2 low). Re-read live alerts before release decisions.
- The Playwright suite passed; only the separate S3 report-publishing workflow failed because publication configuration was absent.
- The desktop/“This Mac” provider only constrains the working directory; it still spawns agent-selected commands as the host OS account, so commands can address host resources independently of `cwd`. Treat it as trusted-host execution, not sandboxing.
- Proxied screen URLs currently have one-hour view/control capability lifetimes and do not cryptographically bind actor/Assistant/computer/active lease. Require actor/resource/lease enforcement and immediate stale-control invalidation before customer acceptance.
- Current approval behavior exempts shell/file/computer/schedule/subagent tools and defaults unmatched effects to allow. This is the highest-level governance caveat.
- Several secret-reference fields are plain strings without database foreign-key ownership constraints; retain application-level Space/user checks and add defense in depth when touching these paths.
- Custom OpenAI-compatible endpoints intentionally permit loopback/private-network targets for local use. On a shared deployment this is an authenticated SSRF capability; require an operator allowlist/disable policy before customer use.
- Do not assume repeated `spaceId`/`userId` columns are database-enforced tenant invariants. Many relationships use bare IDs; validate all Run/Bot/Thread/Task/Computer/connector companions before execution and prefer composite constraints for new work.
- Composio's external principal is currently keyed by user, not Space. Do not claim Space-hard connector isolation until this is deliberately specified and tested.
- Screen capabilities, control leases, provider references, MCP OAuth, connector accounts, browser profiles, artifacts, and homes are security-sensitive bearer/durable material.
- `ENCRYPTION_KEY`, Better Auth secret, screen-proxy secret, supervisor token, updater token, provider credentials, SMTP and messaging credentials must be independent and never logged.
- `DATA_DIR` is part of production data and backups. Homes/browser sessions/artifacts/push tokens can contain sensitive customer information.
- User deletion includes Assistant/computer/artifact cleanup, push-token deletion, messaging identity cleanup, and personal Organization deletion; modify only with full lifecycle tests.

## Known Unknowns

- Final Hub claims/policy/config/lifecycle contract.
- Qualified Phase 1 computer provider and failover expectations.
- Pilot client surfaces and support matrix.
- SeaweedFS adapter/migration plan.
- Governance/audit architecture for all consequential effects.
- Customer deployment SLOs, quotas, telemetry, retention, backup/restore and disaster-recovery evidence.
- Fork/upstream sync and CortexAI release/tag policy.
- Private-network model-endpoint policy for multi-user deployments.
- Composio user-versus-Space sharing and cross-deployment namespacing.
- Production screen proxy/verifier ownership and enforcement evidence.
- Worker-composition consolidation and direct worker-entry test coverage.
- Mobile gaps: deployment/updater, approvals/auto-review, memory-provider settings, messaging linkage, scratchpad, peer messages, taught-skill capture, and localization.
- External `deploy-main` implementation and marketing/Vercel deployment ownership.

## Suggested First Checks for Any Future Task

1. `git status --short`, branch, `HEAD`, remotes, `git fetch`, and compare `HEAD`, `origin/main`, `upstream/main`.
2. Read the task's linked requirements and project architecture documentation.
3. Read this handoff and root `AGENTS.md`.
4. Identify affected contract, API/worker, data, provider, and client surfaces.
5. Identify privacy/security/effect/deployment risks before coding.
6. Create an isolated worktree and write the failing test first.
7. Run targeted tests, then lint/typecheck/unit/integration/build/E2E as applicable.
8. Push one focused PR with exact-head evidence; wait for CI and automated reviewers.
9. Do not merge/deploy without explicit approval.
