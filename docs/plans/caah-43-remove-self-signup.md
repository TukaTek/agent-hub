# CAAH-43: Remove Self-Service Signup Implementation Plan

## Problem
Fresh deployments default to open email/password registration with automatic owner claim for the first account. Public exposure before operator setup leaves account creation and deployment ownership to whoever arrives first. Stored settings can reopen registration even after it's closed.

## Contract
This plan implements all six acceptance criteria from Linear CAAH-43:

1. Fresh and upgraded installations reject direct email/password signup regardless of legacy `signupsEnabled=true` settings
2. No account or deployment owner can re-enable signup through the API
3. Initial owner creation is operator-controlled, explicit, and cannot be claimed by visitors; deleting owner never reopens automatic claim
4. Existing accounts can sign in and recover passwords; Hub sign-in still works
5. Web, Electron, and mobile offer sign-in without signup controls or working signup routes
6. Deterministic auth and UI tests cover all scenarios

## Implementation Strategy

### Phase 1: Server-Side Auth Lockdown (AC 1, 2, 4)

#### 1.1 Disable signup in Better Auth
- File: `packages/auth/src/index.ts`
- Change `disableSignUp: false` → `disableSignUp: true` (line 247)
- Remove signup policy resolution from `before` hook (lines 337-370)
- Keep password reset functionality intact
- Tests: Fresh signup rejected, existing user sign-in works, password recovery works

#### 1.2 Remove owner claim from session creation
- File: `packages/auth/src/index.ts`
- Remove `claimUnverifiedFirstAccount` call from `session.create.before` (line 440)
- Remove `bootstrapUserSpace` owner claim from unverified flow (lines 448-454)
- Tests: New session never claims empty `ownerUserId`, deleting owner doesn't reopen claim

#### 1.3 Remove owner claim from bootstrapUserSpace
- File: `packages/db/src/bootstrap-user.ts`
- Set `claimDeploymentOwner: false` as hard-coded default (line 35)
- Remove conditional owner claim logic (lines 94-111)
- Remove `claimDeploymentOwner` parameter from function signature
- Tests: Bootstrap never sets `ownerUserId` even when null

#### 1.4 Remove signup controls from deployment API
- Files: `apps/api/src/router.ts`, `packages/contracts/src/domain.ts`, `packages/contracts/src/rpc.ts`
- Remove `signupsEnabled` and `signupAllowlist` from `deployment.update` input schema (router.ts:186-188, rpc.ts:186-188)
- Remove these fields from update handler (router.ts:960-967)
- Keep fields in `DeploymentSettingsSchema` output for read-only display
- Legacy stored values become inert
- Tests: Deployment owner cannot re-enable signup via API

### Phase 2: Operator Provisioning Commands (AC 3)

#### 2.1 Create CLI management commands
- New file: `apps/api/src/cli/provision.ts`
- Commands:
  - `provision-owner`: Creates local credential, provisions personal org/space, sets `ownerUserId` in transaction
  - `provision-user`: Creates local user without owner grant
  - `transfer-owner`: Explicit owner transfer/recovery, supports Hub identity mapping for AUTH_MODE=hub
- Secret input: stdin, TTY prompt, or mounted file path only (never argv/env)
- Concurrency: Exactly one owner survives concurrent `provision-owner` runs
- Tests: Owner provisioning, concurrent safety, existing owner failure, secret source validation, password never in output

#### 2.2 CLI entry point
- File: `apps/api/src/app.ts`
- Add CLI mode detection and command router
- Commands run before HTTP server starts
- Exit after command completes

### Phase 3: Remove Signup UI (AC 5)

#### 3.1 Web application
- Files: `apps/web/src/App.tsx`, `apps/web/src/pages/Auth.tsx`, `apps/web/src/pages/Welcome.tsx`
- Remove signup routes, forms, and navigation
- Old signup URLs redirect to sign-in without creating accounts
- Update routing to prevent signup path access

#### 3.2 Electron (same as web)
- Follow web changes (Electron hosts web UI)

#### 3.3 Mobile
- Files: `apps/mobile/lib/auth-routing.ts`, `apps/mobile/app/sign-in.tsx`
- Change logged-out default from signup to sign-in
- Remove signup screens and navigation

### Phase 4: Configuration & Documentation Updates (AC 6 requirements)

#### 4.1 Environment files
- Files: `.env.example`, `infra/compose/docker-compose.topology.yml`
- Remove `SIGNUPS_ENABLED=true` from both files
- Keep `SIGNUP_ALLOWLIST` for legacy read-only display

#### 4.2 Documentation
- File: `docs/self-host.md`
- Document operator provisioning workflow
- Exact Compose/container invocation examples with placeholder values
- Fresh install smoke check: provision owner, sign in, verify privileges, confirm signup closed
- Update onboarding instructions

### Phase 5: Comprehensive Testing (AC 6)

#### 5.1 Auth server tests (packages/auth/src/)
- New file: `packages/auth/src/provision.postgres.test.ts`
  - Fresh install rejects signup
  - Upgraded install with legacy `signupsEnabled=true` rejects signup
  - Direct API signup call rejected
  - Owner cannot re-enable signup through API
  - First-owner provisioning success and concurrency
  - Existing-owner prevents new owner
  - Owner deletion doesn't reopen claim
  - Existing user sign-in works
  - Password recovery works
  - Hub sign-in still works (AUTH_MODE=hub)

#### 5.2 CLI command tests
- Tests in `provision.postgres.test.ts`:
  - `provision-owner` creates owner successfully
  - Concurrent `provision-owner` leaves exactly one owner
  - `provision-owner` fails when owner exists
  - `provision-user` creates user without owner
  - `transfer-owner` works
  - Secret validation: password from argv/env refused
  - Password never appears in output

#### 5.3 UI tests
- Update web screenshot test if auth screen test exists
- Verify signup routes redirect to sign-in
- Verify mobile auth routing defaults to sign-in

## Coordination with PR 33 (CAAH-36)

Open PR 33 (branch `sanjay/caah-36-consume-hub-agent-hub-policy-with-versioned-cache-and-fail`) modifies:
- `packages/auth/src/index.ts` (same file)
- Hub login gate in auth code

Strategy:
- Keep our changes minimal around Hub auth code
- Focus on signup removal, not Hub integration
- Document overlap in PR description
- Rebase after PR 33 merges if it lands first

## Testing Strategy

### Local Testing
1. Run lint: `pnpm lint`
2. Run typecheck: `pnpm check`
3. Run unit tests: `pnpm test`
4. Run Postgres tests: `pnpm test:integration`
5. Verify all pass before pushing

### CI Verification
- All CI checks must complete and pass
- Postgres journeys job must run our new tests
- Web E2E screenshots updated if applicable

## Deliverables

1. Working feature on branch `cursor/caah-43-no-self-signup-9118`
2. Draft PR against main with:
   - Design explanation
   - Operator runbook (exact commands)
   - Upgrade behavior description
   - Overlap with PR 33 documented
   - Complete test list
3. All CI checks green
4. No merge or deployment

## Success Criteria

- All six acceptance criteria met with tests
- Existing functionality preserved (sign-in, password reset, Hub auth)
- Operator can provision first owner explicitly
- No path for public visitor to claim owner
- Clean CI run with all tests passing
