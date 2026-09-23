# Changelog

Notable product changes in CortexAI Agent Hub. This is for people following the repo, not a dump of every commit. GitHub Releases still mark tagged builds.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- GPT-6 Luna, GPT-6 Sol, and Claude Opus 5.5 model support; optional TypeSafe Jev Auto Review verification.
- Free on-device mobile voice playback and scheduled routines that can finish without sending a chat reply.

- Pending agent questions can be answered directly in chat; approvals and secrets retain their dedicated controls.
- Bots can update their profile pictures and completion notification preference when asked.
- Optional CortexAI Hub sign-in across web, desktop, and mobile, using tenant discovery and live product-access checks.

### Fixed

- Improved computer startup, stopped-container recovery, mobile streaming, and touch clipboard paste.
- Every turn failed on Claude models through Amazon Bedrock with "input_schema does not support oneOf, allOf, or anyOf at the top level": `request_secret` declares its two destinations as a root `oneOf`, and Anthropic rejects the whole request for it. Root unions in tool schemas, including ones from MCP servers, are now merged into a single object schema before they reach a provider; the executor still enforces credential or `connectionId`, not both.
- Pipedream exposed every tool of every connected app at once, so a handful of apps could fill a run's tool list. Above 20 tools the connector now offers the same lazy catalog the MCP connector uses (`pipedream_search_tools`, `pipedream_load_tool`, and `pipedream_execute_tool`), with names grouped by app.
- The Needs you computer card in a thread now includes Open, which opens that bot's computer the same way the computer panel does, including from a group member bot.
- Bots with more than 20 MCP tools failed on every Claude model behind a Claude Pro/Max/Team sign-in with "You're out of extra usage": Anthropic rejects Claude Code OAuth requests that carry a tool named `mcp_*`. The lazy catalog wrappers are now `connectors_search_tools`, `connectors_load_tool` and `connectors_execute_tool`.

### Changed

- Rebranded the product as CortexAI Agent Hub across the web, desktop, mobile, runtime, packaging, and self-hosting surfaces. The web welcome, authentication, and chat screens now use the official CortexAI mark and theme-safe charcoal and orange brand styling.
- Every run's system instructions now state the current date and time (UTC), so bots judge deadlines, recency and scheduling from the real present instead of guessing it from training data or quoted timestamps.
- Connect Slack, WhatsApp Business Cloud, or Telegram DMs to a bot from Messaging settings, alongside iMessage/SMS. Each app can use a different bot. Group conversations remain iMessage-only.
- Model picker includes Grok 4.6 (xAI) and Ox Alpha Free / GLM-5.3 (OpenCode Go).

### Added

- Voice mode: speak replies, hold-to-talk dictation, and half-duplex calls. Speech sits behind a `VoiceProvider` interface (ElevenLabs, OpenAI, Cartesia, Fish Audio) so the product is not tied to one vendor. Keys stay on the server.
- Electron first-run: Docker (default) or this Mac. This Mac runs the bot shell as you, with working directories under your home folder. macOS does not show its own permission dialog; the consent is CortexAI Agent Hub's. The choice is owner-only and is refused when `SANDBOX_PROVIDER` is not `docker` (so E2B and test fakes cannot enable it).
- GitHub Copilot and SuperGrok / X Premium sign-in via Pi device-code OAuth (`openai-codex`, `github-copilot`, `xai`). Claude Pro is still omitted because Pi's Claude login uses a localhost callback that does not work from the web app.
- Spawn peer bots (each with its own thread and computer) and short-lived in-thread subagents.
- ChatGPT Plus or Pro sign-in for model access.
- Mobile: point the app at a self-hosted API origin, a native iOS inbox, and take control of the live desktop.
- Provider-neutral integrations: managed apps through Composio or Pipedream Connect, plus encrypted user-installed Treg, HTTPS MCP, and OpenAPI tool sources on web and mobile.
- Disconnect connected Composio plugins.
- Routines in plain language instead of raw cron.

### Removed

- Nonfunctional Grant folder picker in the desktop app.

### Messaging upgrade notes

- Webhooks use `/api/v1/messaging/webhook/<provider>`; the previous Sendblue path remains supported.
- Configure credentials for each messaging provider in `.env`; see [.env.example](.env.example).
- Unknown senders are ignored by default. `MESSAGING_OPEN_SIGNUP=true` restores automatic account
  creation from incoming messages and requires a deployment model key.

## [0.1.0-beta] - 2026-08-13

Initial public beta: web, Electron, and Expo clients; Pi runtime; Docker and E2B computers; plugins; one thread, computer, memory, routines, and history per bot.
