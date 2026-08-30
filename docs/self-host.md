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
computer providers; the VM does not expose a Docker supervisor or browser containers. The
root-equivalent updater sidecar is an explicit opt-in profile.

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
   `RAKAZO_IMAGE_TAG` is `sha-<GIT_SHA>`. Set `RAKAZO_DEPLOY_DIR` when the checkout is not at the
   supported Linux default, `/srv/rakazo`. Use distinct random values of at least 32 characters for
   every critical credential; `ENCRYPTION_KEY` is 64 lowercase hexadecimal characters.
   Because Compose places `POSTGRES_PASSWORD` into a PostgreSQL URI, production preflight accepts
   only unreserved URI characters (`A-Z`, `a-z`, `0-9`, `.`, `_`, `~`, `-`) and rejects URI
   delimiters or percent escapes. `openssl rand -hex 32` produces a compatible value without
   reducing the 32-character minimum.
   If you enable the `updater` profile, also set a dedicated `RAKAZO_UPDATER_TOKEN` (at least 32
   characters) that differs from `BETTER_AUTH_SECRET`, `SANDBOX_SUPERVISOR_TOKEN`, and
   `SCREEN_PROXY_SECRET`.
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
# Absolute path of this checkout as the Docker daemon sees it. /srv/rakazo is the Linux default;
# set this explicitly for every other layout. See "The deploy directory must be one path" below.
RAKAZO_DEPLOY_DIR=/srv/rakazo
GIT_SHA=<exact-40-character-checkout-revision>
GIT_SHA_PREVIOUS=
RAKAZO_IMAGE_TAG=sha-<same-40-character-revision>
RAKAZO_IMAGE_TAG_PREVIOUS=
CORTEXAI_BACKUP_TARGET=s3://operator-owned-bucket/tenant-prefix
CORTEXAI_BACKUP_ENCRYPTION_KEY=<dedicated-backup-encryption-credential>
# Optional: required only with `--profile updater`.
# RAKAZO_UPDATER_IMAGE=ghcr.io/elie222/rakazo/updater
# RAKAZO_UPDATER_IMAGE_TAG=sha-<same-40-character-revision>
# RAKAZO_UPDATER_IMAGE_PREVIOUS=
# RAKAZO_UPDATER_IMAGE_TAG_PREVIOUS=
# RAKAZO_UPDATER_TOKEN=replace-with-32-plus-character-updater-token
```

4. Install with Node 24, run the read-only preflight before any build, migration, or container start,
   and record the safe inventory output. Preflight parses the rendered Compose model, checks the
   exact checkout/image pin (including forbidden Git `assume-unchanged` and `skip-worktree` flags),
   host capacity and architecture, globally routable DNS answers, standard-port HTTPS same-origin
   settings, an exact `RAKAZO_HOST` match in rendered web/Caddy configuration, remote provider
   inputs, backup inputs, secret names/status classes, and publicly bound Caddy ports 80/443. When
   the updater token enables the opt-in sidecar, preflight also requires its image to use the app
   image's registry/repository namespace, the exact sibling name ending in `/updater`, and the same
   full `sha-<GIT_SHA>` tag in both `.env` and the rendered service. If a rollback point is present,
   preflight also requires its complete full-SHA application identity and, when enabled, updater
   identity. It never emits secret values and does not call providers, start containers, run
   migrations, create backups, or modify DNS/firewall state.

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
published application/updater builds pin their base-image digests. Refresh those pins deliberately
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

## Upgrade

A Compose deployment using published images upgrades by selecting the next full source-addressed
`sha-<commit>` tag. Its durable identity is one transaction: move the outgoing `GIT_SHA` and
`RAKAZO_IMAGE_TAG` to `GIT_SHA_PREVIOUS` and `RAKAZO_IMAGE_TAG_PREVIOUS`, then set both current
values to the incoming commit. When the updater profile is enabled, move its image and tag to
`RAKAZO_UPDATER_IMAGE_PREVIOUS` and `RAKAZO_UPDATER_IMAGE_TAG_PREVIOUS` and pin the current updater
to the app image's exact `/updater` sibling at the same `sha-<commit>`. Write the complete `.env`
through a mode-`0600` temporary file, sync it, rename it over `.env`, and sync the parent directory;
do not edit these keys one at a time in place. Run preflight again before the pull or recreate:

```bash
git fetch --no-tags origin refs/tags/vX.Y.Z
git checkout --detach <full-commit>
# Atomically swap the complete current/previous identity in .env.
corepack pnpm deployment:preflight
# If the updater is enabled, append `updater` to this pull command.
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml pull api worker web
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never api worker web
# If enabled, finish with the updater self-restart documented below.
```

A source-built deployment uses the same current/previous transaction and `sha-<commit>` tags,
then reruns preflight and rebuilds:

```bash
git pull
# Atomically swap the complete current/previous identity in .env, then:
corepack pnpm deployment:preflight
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never --build api worker web
```

`up --wait` does not report success until the new API is healthy and the worker and web containers
are running. The API's start command runs `prisma migrate deploy` before it serves, so migration
failure keeps health red. A failed CLI recreate does not auto-roll back; atomically swap the
complete previous identity back to current, check out its exact `GIT_SHA`, and run preflight before
`up -d --wait --pull never`. Never recover by changing only the app tag.

The updater sidecar prepares its exact sibling image during `/apply`, commits all current and
previous identity keys atomically, and recreates only API, worker, and web. A successful response
uses `restart: manual`: the executing sidecar cannot replace itself and still truthfully report or
recover that run. Finish the transition with
`docker compose … up -d --wait --pull never updater`, then rerun preflight and verify `/health`
reports the new full revision. Until that restart, application services are on the new revision but
the running updater process is intentionally still the old one; the Settings UI reports the owed
restart instead of claiming the update is complete.

Sidecar `/apply` and `/rollback` recover a failed recreate by restoring the exact pre-run `.env`
and redeploying the cached previous application image when possible. Recovery Compose commands use
the same prior revision, app tag, and enabled updater image identity. If either durable restoration
or runtime recovery fails, the run reports the possible mixed state and requires operator repair.

Source checkouts (not Compose) still upgrade the old way: pull, rebuild with
`GIT_SHA=$(git rev-parse HEAD)`, run `pnpm --filter @rakazo/db migrate`, then restart API and worker.
Product contracts stay compatible across cloud and self-hosted.

### Published images and tags

`.github/workflows/publish-server-image.yml` publishes to `ghcr.io/<owner>/<repo>/…`, derived from
`${{ github.repository }}` rather than hardcoded, so a fork's CI fills the fork's own namespace. For
this repository that is:

| Image | Contents |
| --- | --- |
| `ghcr.io/elie222/rakazo/app` | api, worker, web, and sandbox supervisor — one image, multiple commands |
| `ghcr.io/elie222/rakazo/computer` | Linux desktop used as each bot computer |
| `ghcr.io/elie222/rakazo/updater` | the updater sidecar, plus the Docker CLI |

`infra/compose/docker-compose.images.yml` is the no-checkout path for those app and computer tags
plus Postgres. The supervisor runs from the app image on the internal network only (not a separate
published supervisor image, and no host port). Production Compose (`docker-compose.prod.yml`) can
also pull the same app tags once `RAKAZO_IMAGE_TAG` is set to a published value.

If you deploy from your own fork, set `RAKAZO_IMAGE` and `RAKAZO_UPDATER_IMAGE` to your namespace —
your CI cannot publish into someone else's.

| Tag | Published on | Moves? |
| --- | --- | --- |
| `local` | nothing — built locally by `up --build` | rebuilt in place |
| `local-<full-commit>` | non-production compatibility builds only | never |
| `vX.Y.Z`, `vX.Y` | release tags | conventionally no / on patch releases |
| `latest` | stable `vX.Y.Z` tags only (not prereleases) | yes, to the newest stable release |
| `sha-<full-commit>` | every push and manual run | source-addressed; used by the updater sidecar |
| `edge` | pushes to main | yes, to the newest main build |

`edge` from everyday main merges is `linux/amd64` only. Release tags (`v*`) and manual
`workflow_dispatch` publishes are multi-arch (`amd64` + `arm64`). On arm64 hosts, set both
`RAKAZO_IMAGE_TAG` and `RAKAZO_COMPUTER_IMAGE_TAG` to the same published release tag rather than
`edge`. Changing only `RAKAZO_IMAGE_TAG` leaves the computer service on amd64-only `edge`. Until a
stable `vX.Y.Z` has been published, GHCR may only have `edge` and `sha-*` tags; do not pin
`latest` unless that tag exists in the registry.

The updater resolves the newest stable `vX.Y.Z` source tag but deploys its `sha-<full-commit>` image,
not `latest` or a moving minor tag. A registry tag is not an OCI digest and GHCR package writers can
replace it, so the trust boundary remains this repository's publishing credentials. The workflow
reduces that boundary by using SHA-pinned actions, read-only pull-request jobs, digest-pinned base
images, SBOM/provenance output, and a GitHub build attestation. Operators who require registry-level
content addressing can pin `RAKAZO_IMAGE` outside the automatic updater to a verified digest.

Rollback never contacts the registry: it redeploys the previous tag from the local Docker cache,
so a later tag move cannot change rollback content. Do not prune the previous application image
until the next update has been accepted. If it is missing, rollback fails closed instead of pulling
new content under an old tag.

To populate the registry the first time, run the workflow manually (`workflow_dispatch`) or push a
`v*` tag. A manual run produces `sha-<full-commit>`; only a stable `vX.Y.Z` tag (no prerelease
suffix) produces `latest`, and any `v*` tag produces semver tags. The updater ignores prereleases
and refuses the official path until a stable `vX.Y.Z` exists.

### Updater sidecar

Compose production deployments offer an opt-in `updater` profile on a private `control` network.
Normal deployments do not start it or require its credential. To enable it, set a dedicated
`RAKAZO_UPDATER_TOKEN` and explicitly start the profile:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  --profile updater up -d --build updater
```

It exposes `/health`, `/state`, `/plan`, `/apply`, and `/rollback` at `http://updater:7092` with
`RAKAZO_UPDATER_TOKEN`. Operator CLI upgrades above do not need it; the sidecar is for automated
apply/rollback over that private HTTP API.

The API cannot update itself — its image has no `.git`, and nothing inside the container would
restart it — so the work happens in a separate `updater` container that outlives the recreate:

- *Official repository:* resolves the newest stable release and its source commit with
  `git ls-remote --tags`, fetches and detaches the clean deployment checkout at that exact commit,
  atomically advances the complete current/previous deployment identity, explicitly pulls the new
  application images and the enabled updater's exact sibling image, then runs
  `up -d --wait --pull never` for API, worker, and web. No build runs on the server.
- *Fork (Advanced):* a fork has no published images, so the sidecar fast-forwards the checkout in
  `RAKAZO_DEPLOY_DIR`, uses the full `sha-<commit>` identity, prepares the updater image when
  enabled, and runs `up -d --build`. This builds on the server and takes minutes rather than
  seconds. Point it only at a fork you control and have reviewed — the sidecar runs that Compose
  file through a root-equivalent Docker socket.

The durable schema is a single-level rollback journal. Current state is the checkout at `GIT_SHA`
plus `RAKAZO_IMAGE_TAG`; previous state is the cached source revision in `GIT_SHA_PREVIOUS` plus
`RAKAZO_IMAGE_TAG_PREVIOUS`. An enabled updater adds its current image/tag pair and corresponding
`_PREVIOUS` pair. The updater
accepts an entirely absent previous state for the first transition, but production preflight and
the sidecar reject partial, abbreviated, cross-revision, or non-sibling state. With the updater
disabled, no updater pin is required or introduced. Every successful update replaces the one
previous entry, so A→B→C leaves current C and previous B; rollback swaps them, leaving current B
and previous C.

Existing tag-only rollback state is not accepted silently. If its previous application tag is
already `sha-<40 lowercase hex>`, copy that exact suffix to `GIT_SHA_PREVIOUS`; when the updater is
enabled, also set the previous updater image to the current app image's `/updater` sibling and its
tag to the same `sha-<commit>`. If the old previous tag is moving, abbreviated, or unknown, clear
all `_PREVIOUS` identity values together and deliberately discard that rollback point; the next
successful transition records a complete one. Repair any mismatch in the current checkout,
`GIT_SHA`, app tag, or enabled updater pin before starting the sidecar or running preflight.

Updates and rollbacks run one at a time. The `.env` replacement is written to a private temporary
file, file-synced, atomically renamed, and parent-directory-synced. A failed pull leaves running
services alone; a failed recreate restores the exact previous environment and attempts to redeploy
the cached previous image. A failed fork build also restores the
pre-update branch and commit (including when checkout succeeded but merge did not) so a later
manual `--build` cannot deploy the rejected or unintended revision. Database migrations are not
reversed. An abrupt stop after source checkout but before the atomic `.env` commit can leave the
checkout ahead of the still-coherent old identity; no application service has changed, the next
apply and preflight fail closed, and the operator must check out the current `GIT_SHA` before
retrying. A crash after the identity commit but before application recreate converges to the new
identity on ordinary Compose restart. A crash between application recreate and the updater's manual
self-restart leaves that bounded mixed runtime until the updater is restarted. The sidecar never
touches Postgres or Caddy and never runs migrations — that ordering belongs to the API start command.

Only `https://` and `ssh://` git remotes are accepted. Merges are fast-forward only. A dirty or
untracked source tree fails closed before anything runs (the application Dockerfile uses `COPY . .`).

### The deploy directory must be one path

`RAKAZO_DEPLOY_DIR` is bind-mounted into the updater at the same path it is read from
(`${RAKAZO_DEPLOY_DIR}:${RAKAZO_DEPLOY_DIR}`), and that is load-bearing rather than tidy. Production
Compose defaults both sides to `/srv/rakazo`; set the variable for any other layout. When the
updater runs `docker compose -p <project> --file $RAKAZO_DEPLOY_DIR/infra/compose/docker-compose.prod.yml up -d`,
the Compose CLI *inside* the container expands this file's relative bind mounts — `../../.env`,
`./Caddyfile.prod` — against that path and hands the results to the daemon. The daemon has to be
able to resolve the same strings, or it silently creates empty directories where your `.env` and
Caddyfile should be. Compose makes the effective `-p` value available for interpolation but does
not automatically put it in a container's environment, so the production file explicitly assigns
`COMPOSE_PROJECT_NAME` to the updater. A standalone sidecar can instead set
`RAKAZO_COMPOSE_PROJECT_NAME`; the final fallback is `rakazo-prod`. Without that propagation, a
stack started with `-p something-else` would be left alone while a second project with a new empty
Postgres volume came up beside it.

The value therefore has to be the path **the daemon** sees, which is not always the path your shell
sees:

- **Linux.** The daemon shares the host filesystem, so the checkout path is the answer:
  `/srv/rakazo` is the default and supported production layout. Set `RAKAZO_DEPLOY_DIR` explicitly
  when the checkout is elsewhere.
- **Docker Desktop (Windows/macOS).** The daemon runs in a VM that mounts your drive somewhere else.
  On Windows, `C:` appears at `/run/desktop/mnt/host/c`, so a checkout at `C:\Users\you\rakazo` is
  `RAKAZO_DEPLOY_DIR=/run/desktop/mnt/host/c/Users/you/rakazo`. Host Git may use `core.autocrlf=true`; the updater ignores CR-only diffs so that does not block `/apply`. Verify the mount before deploying:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  --profile updater run --rm updater git -C "$RAKAZO_DEPLOY_DIR" log --oneline -1
```

  That must print your checkout's HEAD. The two tempting wrong answers both fail: a native Windows
  path is rejected by the daemon (`mount denied: … too many colons`, because the drive letter's
  colon collides with the bind-mount separator), and `/mnt/c/...` fails *silently* — the container
  starts, the mount is an empty directory, and the updater simply reports no checkout.

### The updater's privileges

The updater holds the Docker socket, which is root-equivalent on the host. It is scoped as narrowly
as that allows:

- No `ports`, so nothing is published on the host.
- Only on the dedicated `control` network shared with the API. Caddy is not attached, so the
  reverse proxy has no route to the updater.
- Every route except `/health` requires the shared bearer token, compared in constant time.
- The process environment carries only updater settings (`RAKAZO_UPDATER_TOKEN`, deploy path,
  image name, project name). Application secrets stay in the bind-mounted `.env` that Compose
  reads for interpolation; they are not loaded into this container.
- The Docker CLI lives only in the updater image. The api, worker, and web containers keep
  `cap_drop: ALL` and no socket.

Enabling the `updater` profile requires `RAKAZO_UPDATER_TOKEN` to be a dedicated random value (at
least 32 characters in production). It must differ from `BETTER_AUTH_SECRET`,
`SANDBOX_SUPERVISOR_TOKEN`, and `SCREEN_PROXY_SECRET`. Leave the profile disabled if you would
rather not grant the capability.

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
