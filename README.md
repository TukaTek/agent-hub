# CortexAI Agent Hub

[![GitHub stars](https://img.shields.io/github/stars/TukaTek/agent-hub?labelColor=black&style=for-the-badge&color=2563EB)](https://github.com/TukaTek/agent-hub/stargazers)

![CortexAI Agent Hub — personal, always-on AI assistants](./docs/readme-hero.png)

CortexAI Agent Hub is an open-source platform for running persistent AI assistants. It is available on the web,
as an Electron desktop app, and through an Expo mobile app. Bring your own model and computer
provider, or run the complete stack locally.

CortexAI Agent Hub is in beta. Learn more at the [CortexAI product page](https://www.tukasolutions.com/cortexaiagenthub).

## Features

- Persistent assistants with their own conversations, memory, routines, and history
- Voice mode: speak replies, dictate, and call an assistant. Bring your own ElevenLabs, OpenAI, or Cartesia key
- Shared Team Computers and isolated Private computers
- Browser, terminal, file, and graphical desktop access
- Assistants that can delegate to peer assistants or short-lived subagents
- Bring-your-own model credentials through Pi
- App integrations through Composio or Pipedream Connect, plus user-installed Treg, remote MCP, and OpenAPI tool sources
- Docker, E2B, Daytona, Box, and trusted local-computer support

## Stack

- TypeScript
- React 19, Vite, and Tailwind CSS
- Electron and Expo
- Hono and oRPC
- PostgreSQL and Prisma
- Better Auth
- Graphile Worker
- Pi
- Docker, E2B, Daytona, and Box
- Composio, Pipedream Connect, MCP, and OpenAPI integrations

## Quick start (published images)

You need Docker Engine, the Compose plugin, curl, and OpenSSL. No clone or Node install.

```bash
mkdir -p cortexai-agent-hub && cd cortexai-agent-hub &&
curl -fsSLO https://raw.githubusercontent.com/TukaTek/agent-hub/main/infra/compose/install-images.sh &&
bash install-images.sh
```

The installer downloads the Compose files, creates `.env` with random secrets, and starts CortexAI Agent Hub.
It preserves an existing `.env` when rerun.

Open [http://127.0.0.1:5173](http://127.0.0.1:5173), create an account, and connect a model.
Local Docker computers are on by default. Optional remote providers: `e2b`, `daytona`, or `box`
with the matching API key.

Default image tag is `edge` (main builds, `linux/amd64` + `linux/arm64`). Details and tags:
[self-hosting guide](./docs/self-host.md#published-images-no-checkout).

On restricted networks, override the installer download base (`CORTEXAI_AGENT_HUB_DOWNLOAD_BASE`), skip
existing Compose files (`--local` / `CORTEXAI_AGENT_HUB_DOWNLOAD_SKIP_EXISTING`), or mirror the bootstrap
script URL — see
[Restricted networks / mirror downloads](./docs/self-host.md#restricted-networks--mirror-downloads).

For an agent-assisted install, use [SETUP_PROMPT.md](./SETUP_PROMPT.md).

## Run on a server

Assistants stay on when the backend runs on a server. Use the same installer on a VPS, then connect from
the desktop app, the mobile app, or a browser.

```bash
bash install-images.sh --prepare-only
# edit .env: SANDBOX_PROVIDER=box (or e2b / daytona) with its API key, CORTEXAI_AGENT_HUB_HOST=your.domain
bash install-images.sh
```

Put HTTPS in front of port 5173; [docs/self-host.md](./docs/self-host.md#public-single-vm-deployment)
covers the Caddy setup and host hardening. In the desktop app choose **Existing instance** and enter
the `https://` address.

## Local development (source checkout)

You need Node.js 22+, pnpm 9, and Docker.

```bash
git clone https://github.com/TukaTek/agent-hub.git
cd cortexai-agent-hub
cp .env.example .env
```

Set `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, and `SCREEN_PROXY_SECRET` in `.env` to independent
long random values. Docker sandboxes also need a dedicated `SANDBOX_SUPERVISOR_TOKEN`. You can
also set `OPENROUTER_API_KEY`, or connect a supported model provider during onboarding.

Managed app catalogs are optional. Set `COMPOSIO_API_KEY` for Composio, or the
`PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET`, and `PIPEDREAM_PROJECT_ID` trio for Pipedream
Connect. Users can add an HTTPS MCP server, Treg endpoint, or OpenAPI JSON document from
**Integrations** without enabling either managed catalog. Connector credentials are encrypted on the
server and are never returned by the API.

Treg is usage-metered. Self-hosters supply their own Treg token; operators embedding Treg in a
hosted product should review [Treg's integration terms](https://treg.to/integrate.md), which require
a written agreement for hosted resale.

```bash
docker compose --env-file .env -f infra/compose/docker-compose.yml up postgres -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm sandbox:build
pnpm dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173), create an account, connect a model, and create
your first assistant.

For deployment, provider selection, backups, and upgrades, see the
[self-hosting guide](./docs/self-host.md).

## Desktop and mobile

The Electron and Expo apps are clients of the same CortexAI Agent Hub API used by the web app.

With the development stack running, launch Electron with:

```bash
pnpm --filter @cortexai-agent-hub/desktop dev
```

On first run the desktop app asks whether to run CortexAI Agent Hub on this computer or connect to an existing
server. **This computer** installs and starts the published images with Docker Compose (the same
files as `infra/compose/install-images.sh`) under the app's data directory, so Docker Desktop,
OrbStack, or Docker Engine must be installed; the app links to them when it is not. Installed
builds pin the image tag to their own version; unpackaged builds pull `edge`. Developers running
`pnpm dev` should pick **Existing instance** with `http://127.0.0.1:5173` instead. Public servers
must use HTTPS; HTTP is accepted only for loopback and private LAN addresses (not link-local). The
app verifies CortexAI Agent Hub's health endpoint before saving, and later launches go straight to that
instance. The stack keeps running after the app quits; **Stop Local Stack** in the application
menu turns it off.

Use **Change CortexAI Agent Hub Server…** in the application menu to reconnect. Closing that window without
saving returns to the previous instance. For development automation, set `CORTEXAI_AGENT_HUB_WEB_URL` to point
the shell somewhere else without changing the saved instance, or `CORTEXAI_AGENT_HUB_FORCE_SETUP=1` to run
setup again.

Mobile build and release instructions live in [docs/mobile-release.md](./docs/mobile-release.md).

## UI language

The web (and Electron-hosted) UI supports English, Deutsch, 한국어, Türkçe, हिन्दी,
Português (Brasil), and 简体中文 under **Settings → Language**. The Expo app supports
English and 简体中文 under **Account → Language**. The marketing homepage (`apps/www`) is
available in en/de/ko/zh via footer language links (`/`, `/de/`, `/ko/`, `/zh/`); other
marketing pages stay English.

## Development

CortexAI Agent Hub is a TypeScript monorepo built with React, Electron, Expo, Hono, Postgres, Prisma, Graphile
Worker, and Pi.

```text
apps/       web, api, worker, desktop, mobile, and public website
packages/   domain, contracts, persistence, adapters, UI, and test tooling
infra/      local services and computer images
docs/       architecture, operations, and release guides
```

Common checks:

```bash
pnpm lint
pnpm check
pnpm test
pnpm test:integration
pnpm test:e2e
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow and test matrix.

## Documentation

```bash
pnpm test              # unit, property, and in-process contract tests
pnpm test:integration  # Postgres journeys, Graphile jobs, LISTEN/NOTIFY
pnpm test:e2e          # Playwright against the emulated stack
pnpm test:e2e -- --sandbox=e2b # the same deterministic suite against real E2B
pnpm test:e2e -- --sandbox=daytona # the same suite against real Daytona
pnpm test:e2e -- --sandbox=box # the same suite against real Box
pnpm test:topology     # local Docker + Graphile worker recovery (needs Docker)
pnpm test:canary       # live OpenRouter / E2B / Box canaries
# explicit real vision-model + real E2B desktop acceptance test:
COMPUTER_E2E_MODEL=<vision-capable-openrouter-model-id> pnpm test:computer
```

- [Self-hosting](./docs/self-host.md)
- [Computer runtime and isolation](./docs/computer-runtime.md)
- [Desktop releases](./docs/desktop-release.md)
- [Mobile releases](./docs/mobile-release.md)
- [Performance testing](./docs/performance.md)

## Contributing

The Playwright workflow can also be started manually with **Sandbox provider** set to `e2b`, `daytona`, or `box`.
Those options require `E2B_API_KEY`, `DAYTONA_API_KEY`, or `BOX_API_KEY`, keep the deterministic scripted agent runtime, and destroy
the provider machines after the run. The default and all automatic runs remain on `fake`.
Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull
request. For security vulnerabilities, follow [SECURITY.md](./SECURITY.md) instead of filing a public
issue.

CortexAI Agent Hub is licensed under the [Apache License 2.0](./LICENSE).

Questions and ideas are welcome in the [CortexAI Agent Hub Discord community](https://discord.gg/RWwKa2Sn7h).
