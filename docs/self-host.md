# Self-hosting Rakazo

The signed-in product is a long-running API, a Graphile Worker, Postgres, and a computer provider (Docker supervisor, E2B, Daytona, or Box). It is not a static site. The marketing site in `apps/www` can be hosted separately.

## Local (source checkout)

Same as the README quick start: `.env` from `.env.example`, Postgres via Compose, `pnpm sandbox:build`, `pnpm dev`, then [http://127.0.0.1:5173](http://127.0.0.1:5173). Electron: `pnpm --filter @rakazo/desktop dev` while that stack is up.

## Published images (no checkout)

Pull Postgres and `ghcr.io/elie222/rakazo/app` into any empty folder. No clone or image build.
Requires Docker Engine and the Compose plugin.

```bash
mkdir rakazo && cd rakazo
curl -fsSO https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/docker-compose.images.yml
curl -fsSO https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/.env.images.example
cp .env.images.example .env
```

Generate secrets and write them into `.env` (after `cp .env.images.example .env`):

```bash
CORTEXAI_DEPLOYMENT_ID=$(uuidgen | tr '[:upper:]' '[:lower:]') &&
POSTGRES_PASSWORD=$(openssl rand -hex 16) &&
BETTER_AUTH_SECRET=$(openssl rand -hex 32) &&
ENCRYPTION_KEY=$(openssl rand -hex 32) &&
SCREEN_PROXY_SECRET=$(openssl rand -hex 32) &&
SANDBOX_SUPERVISOR_TOKEN=$(openssl rand -hex 32) &&
: "${CORTEXAI_DEPLOYMENT_ID:?}" "${POSTGRES_PASSWORD:?}" "${BETTER_AUTH_SECRET:?}" "${ENCRYPTION_KEY:?}" "${SCREEN_PROXY_SECRET:?}" "${SANDBOX_SUPERVISOR_TOKEN:?}" &&
sed -i.bak \
  -e "s/^CORTEXAI_DEPLOYMENT_ID=$/CORTEXAI_DEPLOYMENT_ID=${CORTEXAI_DEPLOYMENT_ID}/" \
  -e "s/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=${POSTGRES_PASSWORD}/" \
  -e "s/^BETTER_AUTH_SECRET=$/BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}/" \
  -e "s/^ENCRYPTION_KEY=$/ENCRYPTION_KEY=${ENCRYPTION_KEY}/" \
  -e "s/^SCREEN_PROXY_SECRET=$/SCREEN_PROXY_SECRET=${SCREEN_PROXY_SECRET}/" \
  -e "s/^SANDBOX_SUPERVISOR_TOKEN=$/SANDBOX_SUPERVISOR_TOKEN=${SANDBOX_SUPERVISOR_TOKEN}/" \
  .env && rm -f .env.bak
```

`SANDBOX_PROVIDER` defaults to `docker`. The images Compose file runs a sandbox supervisor
(from the app image, on the internal network only) and pulls `ghcr.io/elie222/rakazo/computer`.
Signup and local Docker computers work without an E2B account. Optional remote providers: set
`SANDBOX_PROVIDER` to `e2b`, `daytona`, or `box` and add the matching API key. Compose requires
`SANDBOX_SUPERVISOR_TOKEN` for the Docker path; leave it empty and `compose up` fails closed.

Optional: set `OPENROUTER_API_KEY` or connect a model in the UI after signup.

The example defaults to `edge` (main builds, `linux/amd64` only). On arm64 hosts, set both
`RAKAZO_IMAGE_TAG` and `RAKAZO_COMPUTER_IMAGE_TAG` to the same published multi-arch release tag
when one exists (see [Published images and tags](#published-images-and-tags)). Changing only
`RAKAZO_IMAGE_TAG` leaves the computer service on amd64-only `edge`. Do not assume `latest` is
published.

```bash
docker compose --env-file .env -f docker-compose.images.yml pull
docker compose --env-file .env -f docker-compose.images.yml up -d
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The first registered user becomes the
deployment owner. Put TLS in front of `:5173` for a public host and set the three public origins to
that HTTPS URL. Open **Agent computer** on a bot, or send a message that uses the desktop, to see
the local Docker computer. For automatic HTTPS via Caddy and remote E2B computers, use the
production Compose path below.

## Docker Compose (single machine)

1. Copy `.env.example` to `.env` and set `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, and `SCREEN_PROXY_SECRET` to independent long random strings (32+ characters; 64 hex for `ENCRYPTION_KEY`). Docker sandboxes also need a dedicated `SANDBOX_SUPERVISOR_TOKEN`. Keep existing `ENCRYPTION_KEY` values so stored credentials stay decryptable.
2. Set `OPENROUTER_API_KEY` (and `COMPOSIO_API_KEY` if you want Plugins).
3. Build the computer image: `pnpm sandbox:build` (Compose also builds it via the `computer` service).
4. `docker compose --env-file .env -f infra/compose/docker-compose.yml up --build`
5. Open the web origin (`http://127.0.0.1:5173` by default). The first registered user becomes the deployment owner.

On Windows, if an older clone with `core.autocrlf=true` leaves the computer pane hung on boot (`bash\r` in sandbox logs): from a clean worktree, set `git config core.autocrlf false`, run `git add --renormalize . && git checkout -- .`, then rebuild with `pnpm sandbox:build`.

Compose runs Postgres, the sandbox supervisor (Docker socket), API, worker, and a Vite preview of the web app. Bot computers are sibling containers (`rakazo/computer:local`) on separate per-bot networks; only the supervisor and screen proxy join each one. The API process does not get an unrestricted Docker socket; the supervisor owns the lifecycle.

Postgres is published on **loopback only** (`127.0.0.1:5433` on the host). Do not expose that port on a public VPS. Change `POSTGRES_PASSWORD` and keep Postgres on an internal network when you deploy remotely.

The Docker supervisor is not published as its own image and is not exposed on the host. It runs from
the app image, stays on the internal Compose network, and holds the Docker socket because access to
it is equivalent to control of the Docker host. Docker sandboxes require `SANDBOX_SUPERVISOR_TOKEN`
(API, worker, supervisor). `SCREEN_PROXY_SECRET` signs browser-screen capabilities (API and web
proxy). Keep both distinct from `BETTER_AUTH_SECRET`.

New credentials use versioned AES-GCM with per-record salt and row-bound AAD. Legacy ciphertext stays readable.

On a VPS, put TLS in front of `:5173` (or serve the web build behind your proxy) and set:

```env
BETTER_AUTH_URL=https://app.example.com
WEB_ORIGIN=https://app.example.com
API_URL=https://app.example.com
```

Cookies and CORS follow those origins. `SIGNUPS_ENABLED` / `SIGNUP_ALLOWLIST` seed the initial deployment settings. After initialization, the deployment owner's Settings values are the effective signup policy.

Optional:

```env
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=you@example.com,@company.com
SANDBOX_PROVIDER=docker   # or none, e2b, daytona, box. Keep fake only for pnpm test.
AGENT_RUNTIME=pi          # Keep scripted only for pnpm test.
WAKEUP_DRIVER=graphile
SANDBOX_IDLE_MS=600000    # pause the bot computer after 10 minutes idle
SANDBOX_COMMAND_TIMEOUT_MS=300000 # stop a shell command after 5 minutes
MAX_TOOL_CALLS_PER_TURN=  # optional Pi turn tool-call fuse; unset/0 = unlimited
E2B_API_KEY=              # when SANDBOX_PROVIDER=e2b
DAYTONA_API_KEY=          # when SANDBOX_PROVIDER=daytona
BOX_API_KEY=              # when SANDBOX_PROVIDER=box
```

To use an operator-controlled OpenAI-compatible server such as Ollama, LM Studio, llama.cpp, or
MLX, list its model IDs and an endpoint that both the API and worker processes can reach:

```env
RAKAZO_LOCAL_MODELS=qwen3:4b,llama3.1:8b
RAKAZO_LOCAL_MODELS_URL=http://127.0.0.1:11434/v1
RAKAZO_LOCAL_CONTEXT_WINDOW=32768
RAKAZO_LOCAL_MAX_TOKENS=4096
```

The loopback default is suitable when running Rakazo from a source checkout. In Docker Compose,
use the model server's Compose service name or another address reachable from the containers.
Only configure an endpoint you control: prompts, attachments, and tool results sent to that model
leave Rakazo through this URL. Leave `RAKAZO_LOCAL_MODELS` blank to disable the provider.

Each user can also connect their own OpenAI-compatible endpoint from **Connect a model** /
**Settings → Models** on web and mobile. Choose **OpenAI-compatible**, enter the server base URL
(for example `http://127.0.0.1:8000/v1` for Rapid-MLX, Ollama, LM Studio, llama.cpp, or vLLM),
the exact model id from that server, and an optional API key. By default Rakazo only allows
loopback, RFC1918, and `host.docker.internal` targets. To permit public hostnames, set
`RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC=1` in the deployment environment. Public hostnames must resolve
only to public addresses; redirects and DNS answers that reach private or link-local networks are
rejected.

Do not commit `.env`. Never put `COMPOSIO_API_KEY`, OpenRouter keys, or provider tokens in git, logs, or chat.

## Choosing a computer provider

The Electron desktop app is a client of the same API. Docker and E2B still apply. On first launch, Electron asks the deployment owner whether bots should keep using Docker or run on this Mac as you. `SANDBOX_PROVIDER=desktop` is a separate, explicit provider that always runs commands on the service host.

- **Published images** (`docker-compose.images.yml`) default to `SANDBOX_PROVIDER=docker` with a
  local supervisor and published `ghcr.io/elie222/rakazo/computer` image. No E2B account required.
  Optional: set `e2b`, `daytona`, or `box` plus the matching API key for remote computers.
- **Docker** is the quick-start default for published images and for a source checkout / full local
  Compose stack. Workspace bots share a persistent Team Computer by default; Private computers are
  optional. Keep the supervisor private, as the included Compose files do.
- **E2B** runs bot computers away from the Rakazo host and is a good choice for public or multi-user
  production deployments. Rakazo checkpoints the portable workspace and browser-profile directory to
  `DATA_DIR`; the E2B disk is a runtime cache, not the durable source of truth.
- **Daytona** provides the same remote-computer contract through Daytona sandboxes. Configure
  `DAYTONA_API_KEY` and optionally `DAYTONA_API_URL` / `DAYTONA_TARGET`.
- **Box by ASCII** provides a managed Linux desktop through `BOX_API_KEY` and optionally
  `BOX_API_URL`. Rakazo always creates or resumes boxes with `noEnv: true`, keeps the portable
  workspace under `/home/user/rakazo-home`, and refreshes a two-hour TTL. A Box currently exposes one
  shared desktop, so concurrent Team bots can still use shell and files but only one can use
  graphical tools at a time.
- **Desktop provider** / **This Mac** runs commands on the API/worker host. Docker stays the default.
  The Electron app asks once; if you choose This Mac, bots can use working directories under your home
  folder. Do not enable it on a public or shared service. macOS does not show its own permission
  dialog for this.
- **Fake** is only an emulator for verification.
- **None** boots the product without a computer host (fallback when Docker/supervisor is not
  configured, or when a remote provider is selected without its API key).

## Backup

```bash
./scripts/backup.sh
```

This dumps Postgres (`pg_dump`) and archives `data/` into `backups/<stamp>/`.

## Public single-VM deployment

`infra/compose/docker-compose.prod.yml` runs the hosted product with Postgres, the API, worker, web app,
and automatic HTTPS through Caddy. Production preflight accepts the remote E2B, Daytona, and Box
computer providers; the VM does not expose a Docker supervisor or browser containers. Pilot updates
and rollbacks are immutable, manual operator procedures. Production Compose has no automated updater
or Docker-socket mount.

Before deploying to a new Ubuntu host, create and verify a key-only `deploy` account, then apply the
idempotent host-hardening baseline. It disables SSH passwords and root login, rate-limits SSH, allows
only SSH/HTTP/HTTPS through UFW, enables fail2ban, unattended security updates, AppArmor, audit rules,
and conservative kernel/network protections. Keep the provider console open until a fresh SSH login
succeeds after the script reloads SSH.

```bash
sudo DEPLOY_USER=deploy bash infra/compose/harden-host.sh
```

The production host also uses `infra/compose/docker-daemon.json` to enable live restore, bounded local
container logs, default no-new-privileges, and the kernel NAT path instead of Docker's userland proxy.

1. Point an `A`/`AAAA` record such as `app.example.com` at the VM and allow inbound TCP 80/443 and
   UDP 443. If you use Cloudflare, enable the proxy with **Full (strict)** TLS and copy
   `Caddyfile.cloudflare.example` to an operator-controlled path outside the public checkout. Set
   `CADDYFILE_PATH` to that absolute path. The example drops application requests that do not come
   from Cloudflare's [published IP ranges](https://www.cloudflare.com/ips/); reconcile those ranges
   whenever Cloudflare publishes a change. A Cloudflare Tunnel can replace the public web listeners.
2. Clone the repository on the VM and create a root `.env` with production-only values. Generate
   `CORTEXAI_DEPLOYMENT_ID` once with `uuidgen | tr '[:upper:]' '[:lower:]'`; it is the immutable
   tenant identity shared by the API, worker, health response, inventory, and backups. Preserve it
   through same-tenant restores. A different tenant gets a new ID and must not receive restored
   external connections from this one. At minimum set
   `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SCREEN_PROXY_SECRET`,
   the key for the selected remote sandbox provider, `CORTEXAI_BACKUP_TARGET`,
   `CORTEXAI_BACKUP_ENCRYPTION_KEY`, `GIT_SHA`, `RAKAZO_IMAGE_TAG`, `RAKAZO_HOST`, and the three
   public origins. `GIT_SHA` is the exact lowercase 40-character checkout revision and
   `RAKAZO_IMAGE_TAG` is `sha-<GIT_SHA>`. Use distinct random values of at least 32 characters for
   every critical credential; `ENCRYPTION_KEY` is 64 lowercase hexadecimal characters.
   Because Compose places `POSTGRES_PASSWORD` into a PostgreSQL URI, production preflight accepts
   only unreserved URI characters (`A-Z`, `a-z`, `0-9`, `.`, `_`, `~`, `-`) and rejects URI
   delimiters or percent escapes. `openssl rand -hex 32` produces a compatible value without
   reducing the 32-character minimum.
   Do not set updater activation or configuration variables. Production preflight rejects them with
   `Manual updates only for pilot.`
3. Keep registration allowlisted while the service is private:

```env
NODE_ENV=production
CORTEXAI_DEPLOYMENT_ID=<canonical-lowercase-uuid>
RAKAZO_HOST=app.example.com
# Optional operator-owned override, for example the Cloudflare allowlist file:
# CADDYFILE_PATH=/etc/rakazo/Caddyfile.prod
BETTER_AUTH_URL=https://app.example.com
WEB_ORIGIN=https://app.example.com
API_URL=https://app.example.com
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=owner@example.com,reviewer@example.com
SANDBOX_PROVIDER=e2b
E2B_API_KEY=<provider-credential>
AGENT_RUNTIME=pi
WAKEUP_DRIVER=graphile
DATA_DIR=/data
GIT_SHA=<exact-40-character-checkout-revision>
RAKAZO_IMAGE_TAG=sha-<same-40-character-revision>
CORTEXAI_BACKUP_TARGET=s3://operator-owned-bucket/tenant-prefix
CORTEXAI_BACKUP_ENCRYPTION_KEY=<dedicated-backup-encryption-credential>
```

4. Install with Node 24, run the read-only preflight before any build, migration, or container start,
   and record the safe inventory output. Preflight parses the rendered Compose model, checks the
   exact checkout/image pin (including forbidden Git `assume-unchanged` and `skip-worktree` flags),
   host capacity and architecture, globally routable DNS answers, standard-port HTTPS same-origin
   settings, an exact `RAKAZO_HOST` match in rendered web/Caddy configuration, remote provider
   inputs, backup inputs, secret names/status classes, publicly bound Caddy ports 80/443, and the
   absence of updater activation/configuration variables. It never emits secret values and does not
   call providers, start containers, run migrations, create backups, or modify DNS/firewall state.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm deployment:preflight
corepack pnpm deployment:inventory \
  > /var/lib/rakazo/deployment-inventory.json
```

5. Only after preflight succeeds, build the source-addressed images, start the stack, and verify its
   public health endpoint:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  build
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never
curl --fail https://app.example.com/health
```

**Build, do not pull, for an unpublished first deployment.** Compose tags the local build with the
exact `sha-<GIT_SHA>` value, so the running image, health response, checkout, and recorded inventory
agree. For a published deployment, use the registry's full `sha-<commit>` tag and run `pull` before
`up`; moving `edge`, `latest`, abbreviated SHA, and semver-only tags do not pass preflight. See
[Published images and tags](#published-images-and-tags) for the tag contract.

Preflight's DNS check proves only that the configured hostname resolves during that run. Clean-VM
boot, authoritative DNS propagation, live TLS, provider API access, and an external 80/443 port scan
remain separate acceptance gates.

The root `.env` is excluded from both Git and the Docker build context. The database, application data,
and Caddy certificates live in named Docker volumes.

The production Compose file pins Postgres and Caddy to multi-architecture manifest digests, and the
published application build pins its base-image digests. Refresh those pins deliberately
when taking upstream security updates; changing only the visible major tag does not change the
content while a digest is present.

For the single-VM production layout, install both production scripts and enable the supplied
`rakazo-backup.timer`:

```bash
sudo install -m 0755 infra/compose/backup-prod.sh /usr/local/sbin/rakazo-backup
sudo install -m 0755 infra/compose/restore-prod.sh /usr/local/sbin/rakazo-restore
```

The backup script uses `/srv/rakazo` by default (override with `RAKAZO_PROJECT_DIR`) and creates one
mode-`0700` snapshot directory under `/var/backups/rakazo`. Its exact artifacts are `rakazo.dump`,
created by `pg_dump --format=custom`, `appdata.tgz`, and mode-`0600` `deployment.json`. The manifest
records the deployment ID, revision/image tag, provider kind, backup target class,
transport-encryption key fingerprint, exact artifact names/types/sizes, and SHA-256 digests. An
HMAC-SHA-256 made with the dedicated backup encryption key binds that metadata to the payload
digests without storing or printing the key, target URI, or other secrets.

## Production Restore

```bash
sudo /usr/local/sbin/rakazo-restore /var/backups/rakazo/<stamp>
```

The production restore uses `docker-compose.prod.yml` and consumes the production artifact names.
It rejects symlinked, missing, extra, permissive, tampered, cross-snapshot, wrong-layout, or
wrong-deployment input before stopping application services. Each payload is opened without
following symlinks and its size/digest is verified again from the same file descriptor immediately
before it is piped to `pg_restore` or the application-data volume. Preserve
`CORTEXAI_DEPLOYMENT_ID` and `CORTEXAI_BACKUP_ENCRYPTION_KEY` for a same-tenant recovery; do not
bypass these checks to clone credentials or external connections into a new tenant identity.

After verification, the restore starts PostgreSQL and waits for readiness before it stops Caddy,
web, the worker, or the API. The wait defaults to 60 one-second attempts; set
`RAKAZO_RESTORE_DB_READY_ATTEMPTS` to an integer from 1 through 300 when the host needs a different
bounded deadline. If PostgreSQL never becomes ready, the restore exits with recovery guidance and
does not stop the application services or consume either payload. Retry only after PostgreSQL is
healthy. Once payload restoration begins, the existing rollback limitations still apply: database
migrations are not automatically reversed, and a failed final recreate can require an operator to
redeploy the previous image against the restored volumes.

The development Compose scripts remain a separate layout: `./scripts/backup.sh` writes
`backups/<stamp>/{rakazo.sql,homes.tgz,deployment.json}`, and `./scripts/restore.sh backups/<stamp>`
restores only that local layout. Do not use it for production snapshots.

Local snapshots help with operator mistakes but are not the encrypted off-host transfer. Preflight
validates its declared target and dedicated encryption input, but these scripts do not encrypt or
upload backup objects. Verify that separate transport before production acceptance.

## Manual immutable update and rollback (pilot)

Manual updates only for pilot. The operator selects and records exact `sha-<40-character commit>`
application images; production has no automated update, apply, or rollback path. Run this procedure
from the production checkout as the deployment operator, with Node 24 and the existing `.env`.

First choose the reviewed target and prove that the running checkout and `.env` describe the exact
previous rollback point. Keep the previous image in the local Docker cache until the new release is
accepted, and write the recorded values to the operator change record outside the public checkout.

```bash
cd /srv/rakazo
RAKAZO_IMAGE="$(sed -n 's/^RAKAZO_IMAGE=//p' .env)"
: "${RAKAZO_IMAGE:=ghcr.io/elie222/rakazo/app}"
export RAKAZO_IMAGE
RAKAZO_HOST="$(sed -n 's/^RAKAZO_HOST=//p' .env)"
test -n "$RAKAZO_HOST"
export RAKAZO_HOST
export TARGET_SHA=<reviewed-lowercase-40-character-commit>
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid target revision" >&2; exit 1; }
TARGET_TAG="sha-${TARGET_SHA}"
PREVIOUS_SHA="$(git rev-parse HEAD)"
PREVIOUS_TAG="sha-${PREVIOUS_SHA}"
test "$(sed -n 's/^GIT_SHA=//p' .env)" = "$PREVIOUS_SHA"
test "$(sed -n 's/^RAKAZO_IMAGE_TAG=//p' .env)" = "$PREVIOUS_TAG"
test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
  "${RAKAZO_IMAGE}:${PREVIOUS_TAG}")" = "$PREVIOUS_SHA"
printf 'previous_revision=%s\nprevious_image=%s:%s\ntarget_revision=%s\ntarget_image=%s:%s\n' \
  "$PREVIOUS_SHA" "$RAKAZO_IMAGE" "$PREVIOUS_TAG" \
  "$TARGET_SHA" "$RAKAZO_IMAGE" "$TARGET_TAG"
```

Before changing the checkout or `.env`, run the current release's fail-closed preflight and take a
production backup. Copy the resulting snapshot through the operator-owned off-host backup transport
and verify it there before continuing.

```bash
corepack pnpm deployment:preflight
sudo /usr/local/sbin/rakazo-backup
```

Pull the exact target image directly, then verify its OCI revision label. A moving tag, abbreviated
SHA, missing label, or mismatched label stops the update.

```bash
docker pull "${RAKAZO_IMAGE}:${TARGET_TAG}"
test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
  "${RAKAZO_IMAGE}:${TARGET_TAG}")" = "$TARGET_SHA"
```

Fetch and detach the exact reviewed source revision. Replace both current identity values together
through a mode-`0600` temporary file, install its locked Node dependencies, and run that revision's
preflight before recreating any service.

```bash
git fetch --no-tags origin "$TARGET_SHA"
git checkout --detach "$TARGET_SHA"
update_identity() {
  local revision="$1" tag="sha-${1}" temporary
  temporary="$(mktemp .env.XXXXXX)"
  chmod 0600 "$temporary"
  awk -v revision="$revision" -v tag="$tag" '
    BEGIN { sha = 0; image = 0 }
    /^GIT_SHA=/ { print "GIT_SHA=" revision; sha = 1; next }
    /^RAKAZO_IMAGE_TAG=/ { print "RAKAZO_IMAGE_TAG=" tag; image = 1; next }
    { print }
    END { if (!sha || !image) exit 42 }
  ' .env > "$temporary" || { rm -f "$temporary"; return 1; }
  mv "$temporary" .env
}
update_identity "$TARGET_SHA"
corepack pnpm install --frozen-lockfile
corepack pnpm deployment:preflight
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never api worker web
```

`up --wait` verifies container health and startup. The API runs `prisma migrate deploy` before it
serves, so a migration failure keeps readiness red. Complete the operator gate by checking service
state and requiring the public health response to report the exact target revision.

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml ps
HEALTH_REVISION="$(curl --fail --silent "https://${RAKAZO_HOST}/health" | \
  node -e 'let value=""; process.stdin.on("data", chunk => value += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(value).revision ?? ""));')"
test "$HEALTH_REVISION" = "$TARGET_SHA"
```

### Rollback

Rollback is the same manual immutable procedure in reverse. It must use the recorded
`PREVIOUS_SHA` and already-cached `PREVIOUS_TAG`; do not pull during rollback. Verify the cached OCI
label, detach the recorded source revision, replace both `.env` identity keys together, reinstall
the locked dependencies, run preflight, recreate the application services, and verify readiness and
the exact previous revision.

```bash
[[ "$PREVIOUS_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid previous revision" >&2; exit 1; }
test "$PREVIOUS_TAG" = "sha-${PREVIOUS_SHA}"
test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
  "${RAKAZO_IMAGE}:${PREVIOUS_TAG}")" = "$PREVIOUS_SHA"
git checkout --detach "$PREVIOUS_SHA"
update_identity "$PREVIOUS_SHA"
corepack pnpm install --frozen-lockfile
corepack pnpm deployment:preflight
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never api worker web
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml ps
HEALTH_REVISION="$(curl --fail --silent "https://${RAKAZO_HOST}/health" | \
  node -e 'let value=""; process.stdin.on("data", chunk => value += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(value).revision ?? ""));')"
test "$HEALTH_REVISION" = "$PREVIOUS_SHA"
```

Plan for an outage while application containers are recreated and readiness is established. The API
startup migration is forward-only: an application rollback does not reverse a database migration.
If the previous application is incompatible with the migrated schema, use the separately documented
production restore procedure and accept its additional outage and possible loss of data written
after the snapshot. `rakazo-backup` creates a verified local snapshot; although preflight validates
the declared target and encryption input, the repository scripts do not encrypt or upload it. A
verified operator-managed off-host backup remains a live acceptance gate.

### Published images and tags

`.github/workflows/publish-server-image.yml` derives `ghcr.io/<owner>/<repo>/app` from
`${{ github.repository }}` so a fork can publish only to its own namespace. The pilot publication
matrix contains only the application image. Pull-request validation may still build the development
updater image, without push authority, but no pilot workflow path can publish it.

The production application image contains the API, worker, and web commands. Production Compose pins
it through `RAKAZO_IMAGE_TAG=sha-<full-commit>`. The exact-head workflow sets the OCI
`org.opencontainers.image.revision` label and the `GIT_SHA` build argument to the same commit.
Moving `edge`, `latest`, abbreviated SHA, and semver-only tags are not accepted by production
preflight or this runbook.

| Tag | Published on | Pilot use |
| --- | --- | --- |
| `sha-<full-commit>` | every push and manual run | required immutable application identity |
| `edge` | pushes to main | not accepted for pilot production |
| `vX.Y.Z`, `vX.Y` | release tags | discovery only; resolve to the full commit first |
| `latest` | stable release tags | not accepted for pilot production |

A registry tag can be replaced by a package writer, so operators with a stronger registry trust
requirement should additionally record and verify the pulled OCI digest. That does not replace the
required exact commit tag, revision label, checkout identity, preflight, or health revision gates.

## What “Rakazo Cloud” still needs

The product cannot be “pushed live” as a Vercel serverless app. Graphile Worker, Postgres `LISTEN`, Pi runs, and Docker computers need durable processes and a sandbox host.

To run a hosted product (same codebase):

1. Push `main` (this checkout may be ahead of GitHub).
2. Provision managed Postgres 16 and run `pnpm db:migrate`.
3. Run **API** and **worker** as always-on Node 22 services (Fly machines, a VM, ECS, k8s). Not lambda-style request handlers.
4. Persist and back up `DATA_DIR` (bot homes, browser profiles, artifacts). Today the concrete store is a local filesystem (`LocalAgentHomeStore`), so attach a Rakazo-owned durable volume shared by API and worker processes. The storage contract is separate from the computer-provider contract, but an object-storage implementation is not wired yet.
5. Choose computers: **`SANDBOX_PROVIDER=e2b`**, `daytona`, or `box` with the matching provider key for a public or multi-user production service. Each Team or Private Computer reconnects to its sandbox id (`providerRef`), while workspace state is checkpointed outside the provider at run completion, explicit stop, and idle suspension. If that sandbox is gone—or the deployment changes providers—the replacement is hydrated from Rakazo's copy. Idle computers pause after `SANDBOX_IDLE_MS` (default 10 minutes) and resume on the next message or Take control. Docker remains the local and trusted single-machine default.
6. A Hetzner CX22 (2 vCPU / 4 GB) is enough for API + worker + Postgres when E2B owns the desktops. 2 GB works for a quiet box; 8 GB is only needed if you also run Docker computers on that same machine.
7. Set public HTTPS `WEB_ORIGIN` / `BETTER_AUTH_URL` / `API_URL`, secrets, and an OpenRouter (or other Pi) deployment key if you want to skip per-user model keys.
8. Put the web app behind the same origin as `/api` and `/rpc` (Vite preview proxy, or a reverse proxy). Docker noVNC connections use short-lived signed `/novnc/*` capabilities; do not replace that route with an unrestricted port proxy.
9. Deploy `apps/www` to your public website and point `app.example.com` (or similar) at the product origin.
10. Turn on `SIGNUP_ALLOWLIST` until you want open registration. There is no Rakazo-managed model billing in version 1 — users bring keys.

Expo / desktop installers are clients of that origin (`EXPO_PUBLIC_API_URL`, `RAKAZO_WEB_URL`). They are not a Cloud control plane.

The iOS and Android app can also point at a self-hosted origin at runtime. On the sign-in screen, tap **Use a custom server** and enter the same HTTPS origin as `WEB_ORIGIN` (for example `https://app.example.com`). Store builds still default to `EXPO_PUBLIC_API_URL`; the in-app setting is an override for people running their own API. Changing the server signs the device out of any previous session.
