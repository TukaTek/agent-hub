# CAAH-43: Remove self-service signup; explicit owner provisioning

Status: implemented on `cursor/caah-43-no-self-signup-9118` (draft PR #34).

## Design

- **Signup is gone, not configurable.** Better Auth runs with `disableSignUp: true`; the auth
  `before` hook also refuses `/sign-up*` with 400 "Registration is closed", and the API routes
  `/api/auth/sign-up` and `/api/auth/sign-up/*` to 404 (`isBlockedAuthPath`). No code reads
  `SIGNUPS_ENABLED`, `SIGNUP_ALLOWLIST`, or the stored `signupsEnabled`/`signupAllowlist`
  columns. The columns stay in the schema (no migration); `deployment.get` always reports
  `signupsEnabled: false, signupAllowlist: []` (`DeploymentSettingsSchema` uses
  `z.literal(false)` and an empty array), and `deployment.update` is a strict object, so signup
  fields are a 400.
- **No implicit owner.** Neither sign-in nor `bootstrapUserSpace` claims an empty owner seat.
  Local session creation requires an existing space membership, so a pre-upgrade account that
  was never admitted (pending email proof) cannot sign in.
- **Operator commands** (`apps/api/src/cli/provision.ts`, run as
  `pnpm --filter @cortexai-agent-hub/api provision`):
  - `provision-owner` / `provision-user --email --name`: password from piped stdin or
    `--secret-file` only; terminals are refused, `--password`-style flags are refused without
    echo, environment variables are never read. Accounts are created verified, with Better
    Auth's own `hashPassword`, plus the user's space, in one transaction under a Postgres
    advisory lock. `provision-owner` fails with no change if an owner exists.
  - `transfer-owner --email`: moves the seat to an existing, admitted local account.
  - Hub mode (`AUTH_MODE=hub`): `provision-owner|transfer-owner --hub-user-id <tenant_users.id>
    --hub-tenant <tenant>` sets the seat to `hubUserId(origin, tenant, tenant_users.id)`. No
    user, credential or session is created; emails and whitespace are rejected as ids; the
    tenant must match `HUB_AUTH_TENANT_ID` when set. `provision-user` and local credentials are
    refused. The seat applies only after that user signs in through Hub and is admitted.
- **Clients:** web Auth, mobile sign-in and the desktop shell (which renders the web app) show
  sign-in only, with an "Ask the person who runs this server" hint; `/sign-up` redirects to
  `/sign-in`.

## Tests

- Unit: `packages/auth/src/index.test.ts`, `identity-trust.test.ts` (real Better Auth with the
  memory adapter), `packages/core/src/signup-policy.test.ts`, `packages/db/src/bootstrap-user.test.ts`,
  `packages/contracts/src/deployment-settings.test.ts`, `apps/api/src/cli/provision.test.ts`,
  web `Auth.test.tsx`, mobile `auth-routing`/`api` tests.
- PostgreSQL (CI "Postgres journeys"): `packages/auth/src/signup-lockdown.postgres.test.ts`,
  `apps/api/src/cli/provision.postgres.test.ts` (spawns the real `pnpm … provision` entrypoint),
  and `packages/testkit/src/authorization.test.ts` (owner cannot reopen signup through the API).
- Web E2E: `apps/web/e2e/auth-lifecycle.spec.ts` (closed signup, `sign-in-no-signup` screenshot).

## Follow-ups

- Desktop "This computer" local stack does not yet provision its first owner itself; the
  operator runs `provision-owner` against the local Compose stack.
- `MESSAGING_OPEN_SIGNUP` (opt-in, default off) still creates messaging-only identities; they
  cannot sign in by email. Decide separately whether to remove it.
