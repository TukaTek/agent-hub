# CortexAI Agent Hub

[English](./README.md) | [日本語](./README.ja.md)

[![GitHub stars](https://img.shields.io/github/stars/TukaTek/agent-hub?labelColor=black&style=for-the-badge&color=2563EB)](https://github.com/TukaTek/agent-hub/stargazers)

![CortexAI Agent Hub：本当に自分のものにできる AI チームメイト](./docs/readme-hero.png)

CortexAI Agent Hub は、常駐型の AI アシスタントを動かすためのオープンソースのプラットフォームです。Web 版、
Electron デスクトップアプリ、Expo モバイルアプリで利用できます。モデルやコンピューターのプロバイダーは
自分で選べるほか、スタック全体をローカルで動かすこともできます。

CortexAI Agent Hub は現在ベータ版です。詳しくは [CortexAI の製品ページ](https://www.tukasolutions.com/cortexaiagenthub) をご覧ください。

このドキュメントは[英語版 README](./README.md) の日本語訳です。リンク先のドキュメントは現在英語のみです。

## 機能

- それぞれに会話、メモリ、ルーティン、履歴を持つ常駐型ボット
- 音声モード：返信の読み上げ、音声入力、ボットとの通話。ElevenLabs、OpenAI、Cartesia、Fish Audio の自分のキーを使えます
- 共有の Team Computers と、分離された Private computers
- ブラウザー、ターミナル、ファイル、グラフィカルなデスクトップへのアクセス
- 他のボットや一時的なサブエージェントに仕事を任せられるボット
- Pi を通じて自分のモデル認証情報を利用
- Composio または Pipedream Connect によるアプリ連携に加え、ユーザーが追加できるリモート MCP、OpenAPI のツールソース
- Docker、E2B、Daytona、CreateOS、Boat、信頼済みローカルコンピューターに対応

## デモ

https://github.com/user-attachments/assets/dccdeddb-2134-4a56-8eed-b2e591736b1c

## 謝辞

- [PromptLayer](https://promptlayer.com/?utm_source=github&utm_medium=referral&utm_campaign=cortexai-agent-hub_readme)
- [Inbox Zero](https://getinboxzero.com/?utm_source=github&utm_medium=referral&utm_campaign=cortexai-agent-hub_readme)
- [ConnectorMap](https://connectormap.luinbytes.dev/?utm_source=github&utm_medium=referral&utm_campaign=cortexai-agent-hub_readme)
- [CodeRabbit](https://www.coderabbit.ai/?utm_source=github&utm_medium=referral&utm_campaign=cortexai-agent-hub_readme)
- [Greptile](https://www.greptile.com/?utm_source=github&utm_medium=referral&utm_campaign=cortexai-agent-hub_readme)
- [Snyk](https://snyk.io/?utm_source=github&utm_medium=referral&utm_campaign=cortexai-agent-hub_readme)

## 技術スタック

- TypeScript
- React 19、Vite、Tailwind CSS
- Electron、Expo
- Hono、oRPC
- PostgreSQL、Prisma
- Better Auth
- Graphile Worker
- Pi
- Docker、E2B、Daytona、CreateOS、Boat
- Composio、Pipedream Connect、MCP、OpenAPI 連携

## クイックスタート（公開イメージ）

Docker Engine、Compose プラグイン、curl、OpenSSL が必要です。リポジトリのクローンや Node のインストールは不要です。

```bash
mkdir -p cortexai-agent-hub && cd cortexai-agent-hub &&
curl -fsSLO https://raw.githubusercontent.com/TukaTek/agent-hub/main/infra/compose/install-images.sh &&
bash install-images.sh
```

インストーラーは Compose ファイルをダウンロードし、ランダムなシークレットを含む `.env` を作成して CortexAI Agent Hub を起動します。
再実行時は既存の `.env` をそのまま残します。

[http://127.0.0.1:5173](http://127.0.0.1:5173) を開き、アカウントを作成してモデルを接続します。
ローカルの Docker コンピューターはデフォルトで有効です。リモートプロバイダーとして `e2b`、`daytona`、`createos`、`boat`、`railway`
も、対応する API キーを設定すれば利用できます。

デフォルトのイメージタグは `edge`（main ブランチのビルド、`linux/amd64` と `linux/arm64`）です。詳細とタグは
[セルフホストガイド](./docs/self-host.md#published-images-no-checkout)を参照してください。

制限のあるネットワークでは、インストーラーのダウンロード元（`CORTEXAI_AGENT_HUB_DOWNLOAD_BASE`）を上書きする、
既存の Compose ファイルをスキップする（`--local` / `CORTEXAI_AGENT_HUB_DOWNLOAD_SKIP_EXISTING`）、またはブートストラップ
スクリプトの URL をミラーする方法があります。詳しくは
[制限のあるネットワーク / ミラーからのダウンロード](./docs/self-host.md#restricted-networks--mirror-downloads)を参照してください。

エージェントの支援を受けてインストールする場合は、[SETUP_PROMPT.md](./SETUP_PROMPT.md) を使ってください。

## サーバーで動かす

バックエンドをサーバーで動かすと、ボットは常に稼働し続けます。VPS でも同じインストーラーを使い、
デスクトップアプリ、モバイルアプリ、またはブラウザーから接続します。

```bash
bash install-images.sh --prepare-only
# edit .env: SANDBOX_PROVIDER=boat (or e2b / daytona / createos) with its API key, CORTEXAI_AGENT_HUB_HOST=your.domain
bash install-images.sh
```

ポート 5173 の前段に HTTPS を置いてください。Caddy の設定とホストの堅牢化については
[docs/self-host-production.md](./docs/self-host-production.md#public-single-vm-deployment) で説明しています。デスクトップアプリでは
**Existing instance**（既存のインスタンス）を選び、`https://` のアドレスを入力します。

または [Railway にデプロイ](https://railway.com/new/template/cortexai-agent-hub-template)することもできます。[Railway セットアップガイド](./infra/railway/README.md)を参照してください。

## ローカル開発（ソースから実行）

Node.js 24.x 系の 24.15.0 以降、または Node.js 26 以降と、
pnpm 12、Docker が必要です。Node.js 25.x はサポートしていません。

```bash
git clone https://github.com/TukaTek/agent-hub.git
cd agent-hub
cp .env.example .env
```

`POSTGRES_PASSWORD` と `POSTGRES_APP_PASSWORD` に `openssl rand -hex 16` で生成した 2 つの値を設定し、
それらを `DATABASE_MIGRATION_URL` と `DATABASE_URL` に記入します。アプリは専用の
`cortexai_agent_hub_app` ログインで接続し、行レベルセキュリティが適用されます。マイグレーションはオーナーとして実行されます
（[データベースロール](docs/self-host-configuration.md#database-roles)）。`BETTER_AUTH_SECRET`、`ENCRYPTION_KEY`、`SCREEN_PROXY_SECRET` には
それぞれ独立した長いランダム値を設定します。Docker サンドボックスには専用の
`SANDBOX_SUPERVISOR_TOKEN` も必要です。`OPENROUTER_API_KEY` を設定するか、オンボーディング中に
対応するモデルプロバイダーを接続することもできます。

Docker Desktop を使ってホスト側で開発する場合は、`.env` に `SANDBOX_CONTROL_VIA_LOOPBACK=true`
を設定します。スーパーバイザーは Docker Desktop のユーザーソケットを自動で検出します。
別の Docker ランタイムを使う場合は、`DOCKER_HOST` または `DOCKER_SOCKET` で上書きできます。

マネージドなアプリカタログは任意です。Composio を使う場合は `COMPOSIO_API_KEY` を、Pipedream
Connect を使う場合は `PIPEDREAM_CLIENT_ID`、`PIPEDREAM_CLIENT_SECRET`、`PIPEDREAM_PROJECT_ID` の 3 つを設定します。
どちらのマネージドカタログも有効にしなくても、ユーザーは **Integrations**（連携）から HTTPS MCP サーバー、
OpenAPI JSON ドキュメントを追加できます。コネクターの認証情報はサーバー上で暗号化され、
API から返されることはありません。

有料データサービス（地図の店舗情報、検索結果、勤務先メールアドレス、プロフィール、SEO データ）も任意です。
`PAID_SERVICES_PROVIDER=treg` と、組織用の [Treg](https://treg.to) トークンを入れた `PAID_SERVICES_API_KEY` を設定すると、
ボットがデプロイ側のアカウントでそれらを検索して呼び出せます。モデルクレジットが有効な場合、各呼び出しは
提供元の費用に 20% を加えた額が組織のクレジットから差し引かれます。

```bash
docker compose --env-file .env \
  -f infra/compose/docker-compose.yml \
  -f infra/compose/docker-compose.postgres-host.yml \
  up postgres -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm sandbox:build
pnpm dev
```

デフォルトの Compose ファイルでは、Postgres はネットワーク内部からのみアクセスできます（公開イメージと同じです）。
`postgres-host` オーバーレイは、ホスト側の `pnpm` やデータベースツール向けに、ループバックの `127.0.0.1:5433` を公開します。
そのポートが使用中の場合は、`.env` の `POSTGRES_HOST_PORT` と、`DATABASE_URL` および
`DATABASE_MIGRATION_URL` のポートを変更してください。
オーバーレイを使わない場合は、次のコマンドでシェルを開きます。
`docker compose --env-file .env -f infra/compose/docker-compose.yml exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`
`POSTGRES_PASSWORD` には URI で安全に使える値（`openssl rand -hex 16`）を使ってください。既存の `pgdata` ボリュームは
初回初期化時のユーザー、パスワード、データベースを保持するため、`.env` の値はそのまま残すか、
`ALTER ROLE` や名前の変更でその場で変更してください。ボリュームを作り直すのは、バックアップを取った後（またはデータが
不要な場合）だけにしてください。`docker compose down -v` は Postgres のすべてのデータを削除します。

[http://127.0.0.1:5173](http://127.0.0.1:5173) を開き、アカウントを作成してモデルを接続し、
最初のボットを作成します。

デプロイ、プロバイダーの選択、バックアップ、アップグレードについては
[セルフホストガイド](./docs/self-host.md)を参照してください。

CreateOS を使う場合は、`SANDBOX_PROVIDER=createos` と `CREATEOS_SANDBOX_API_KEY` を設定します。
任意の `CREATEOS_SANDBOX_BASE_URL`、`CREATEOS_SANDBOX_SHAPE`、
`CREATEOS_SANDBOX_ROOTFS` のデフォルト値は、それぞれ `https://api.sb.createos.sh`、`s-2vcpu-2gb`、
`desktop:1` です。

Railway のコンピューターを使う場合は、API と worker に `SANDBOX_PROVIDER=railway`、`RAILWAY_API_TOKEN`、
`RAILWAY_ENVIRONMENT_ID` を設定します。サンドボックス用の環境は明示的に指定してください。Railway が自動で設定する
環境 ID は、ホストしているアプリ自身の環境を指します。
Railway API トークンは、動作する範囲で最も権限の狭いものを使ってください。サンドボックスの操作に十分で、
クライアントの認証方式が対応していれば、プロジェクトトークンを優先します。このプロバイダーは
現在 Bearer 認証を使うため、個人アカウントのトークンではなく、チームまたはワークスペースのトークンを使ってください。
ライブ画面とデスクトップには `PRIVATE` ネットワークが必要です。これにより Railway の公開ドメインから
画面を配信できます。コンピューターはこのモードで動作し、同じ Railway プロジェクト／環境内の他のサービスや、
公開インターネットにアクセスできます。サンドボックスには、アプリやデータベースとは別の
専用 Railway プロジェクト（少なくとも別の環境）を使うことをおすすめします。既存の `ISOLATED` コンピューターは、使う前に作り直してください。
デスクトップは初回起動時にインストールされます。コンピューターを停止すると、ポータブルな
ホームディレクトリを保存してサンドボックスを破棄します。次回の起動時には、新しいサンドボックスにそのホームディレクトリを復元します。
Railway のサンドボックス利用は従量課金です。
新しいコンピューターは Railway のデフォルトリージョンで起動します。API の近くに置くには `RAILWAY_SANDBOX_REGION`（例：
`asia-southeast1-eqsg3a`）を設定してください。稼働中のコンピューターは次回の起動時に移動します。
ワークスペースのエクスポートでは、64 MiB を超えるファイルは切り詰めずに拒否します。この上限は `RAILWAY_MAX_WORKSPACE_FILE_BYTES` で変更できます。

## デスクトップとモバイル

Electron アプリと Expo アプリは、Web アプリと同じ CortexAI Agent Hub API を使うクライアントです。

開発用スタックを起動した状態で、次のコマンドで Electron を起動します。

```bash
pnpm --filter @cortexai-agent-hub/desktop dev
```

初回起動時、デスクトップアプリは CortexAI Agent Hub をこのコンピューターで動かすか、既存のサーバーに接続するかを
尋ねます。**This computer**（このコンピューター）は、macOS 26 以降の Apple シリコン搭載 Mac で、
ビルドにサーバーバンドルが含まれていれば Docker なしで動作します。新規セットアップではこの方式を使い、
必要なサーバーとコンピューターランタイムをアプリがダウンロードします。既存の Docker スタックがある場合は、
Docker の稼働中に移行を提案します。**Keep Docker** を選ぶと Docker を使い続けます。

その他のビルドやプラットフォームでは、アプリのデータディレクトリに Docker Compose で公開イメージを
インストールして起動します（`infra/compose/install-images.sh` と同じファイルを使います）。この方式には Docker Desktop、
OrbStack、Docker Engine のいずれかが必要です。未インストールの場合はダウンロードリンクを案内します。
インストール済みのビルドはイメージタグを自身のバージョンに固定し、パッケージ化されていないビルドは `edge` を取得します。

`pnpm dev` を実行している開発者は、代わりに **Existing instance**（既存のインスタンス）を選び `http://127.0.0.1:5173` を指定してください。公開サーバーは
HTTPS を使う必要があります。HTTP はループバックとプライベート LAN のアドレスでのみ受け付けます（リンクローカルは除く）。
アプリは保存前に CortexAI Agent Hub のヘルスチェックエンドポイントを確認し、以降の起動ではそのインスタンスに直接接続します。
Docker スタックはアプリを終了しても動き続けますが、Docker を使わないサーバーはアプリとともに停止します。
アプリを終了せずに管理対象のスタックを停止するには、アプリケーションメニューの **Stop Local Stack**（ローカルスタックを停止）を使います。

Linux では、デスクトップアプリは AppImage として配布されており、FUSE 2（`libfuse.so.2`）が必要です。Fedora Silverblue や
Ubuntu 24.04 など、FUSE 3 しか含まないディストリビューションでは
`dlopen(): error loading libfuse.so.2` と表示されます。FUSE 2 ライブラリ（Fedora では `fuse-libs`、
Ubuntu 24.04 では `libfuse2t64`、それ以前の Ubuntu や Debian では `libfuse2`）をインストールするか、FUSE を使わずに
AppImage を実行してください。

```bash
chmod +x CortexAI-Agent-Hub-*.AppImage
./CortexAI-Agent-Hub-*.AppImage --appimage-extract-and-run
```

**This computer** の Docker 方式は `docker` CLI を探し、Podman は検出しません。`compose` コマンドに対応した別の
Docker 互換 CLI を試すには、アプリを起動する前に `CORTEXAI_AGENT_HUB_DOCKER_BINARY` にそのパスを設定してください。

接続先を変えるには、アプリケーションメニューの **Change CortexAI Agent Hub Server…**（CortexAI Agent Hub サーバーを変更）を使います。保存せずに
そのウィンドウを閉じると、以前のインスタンスに戻ります。開発の自動化では、`CORTEXAI_AGENT_HUB_WEB_URL` を設定すると
保存済みのインスタンスを変えずにシェルの接続先を変更でき、`CORTEXAI_AGENT_HUB_FORCE_SETUP=1` を設定するとセットアップを
再実行できます。

モバイルのビルドとリリースの手順は [docs/mobile-release.md](./docs/mobile-release.md) にあります。

## UI の言語

Web（および Electron 内）の UI は、**Settings → Language**（設定 → 言語）で English、Deutsch、한국어、Türkçe、हिन्दी、
Português (Brasil)、简体中文、Español、Русский、Français、עברית、日本語 に対応しています。
Expo アプリには English、简体中文、Русский、Deutsch、日本語 のカタログが含まれ、
**Account → Language**（アカウント → 言語）にこの 6 つが表示されます。保存された選択がない場合は、デバイスの言語または
`EXPO_PUBLIC_DEFAULT_UI_LOCALE` が最初のカタログを決めます。
マーケティング用ホームページ（`apps/www`）は、フッターの言語リンクから en/de/ko/zh/ja で表示できます（`/`、`/de/`、
`/ko/`、`/zh/`、`/ja/`）。その他のマーケティングページは英語のままです。ロシア語のマーケティング用ホームページと、
Electron ネイティブのセットアップ画面／メニューの翻訳は、今後の課題として残っています。

## 開発

```text
apps/       web, api, worker, desktop, mobile, and public website
packages/   domain, contracts, persistence, adapters, UI, and test tooling
infra/      local services and computer images
docs/       architecture, operations, and release guides
```

よく使うチェック：

```bash
pnpm lint
pnpm check
pnpm test
pnpm test:integration
pnpm test:e2e
```

開発の流れとテストマトリクスについては [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。

## ドキュメント

- [セルフホスト](./docs/self-host.md)
- [セルフホストのシークレット](./docs/self-host-secrets.md)
- [コンピューターのランタイムと分離](./docs/computer-runtime.md)
- [デスクトップのリリース](./docs/desktop-release.md)
- [モバイルのリリース](./docs/mobile-release.md)
- [パフォーマンステスト](./docs/performance.md)
- [ボットを管理するボット](./docs/fleet-management.md)

## コントリビュート

コントリビューションを歓迎します。プルリクエストを作成する前に [CONTRIBUTING.md](./CONTRIBUTING.md) をお読みください。
セキュリティ上の脆弱性は、公開の Issue を作成せず、[SECURITY.md](./SECURITY.md) の手順に従って報告してください。

CortexAI Agent Hub は [Apache License 2.0](./LICENSE) のもとでライセンスされています。

質問やアイデアは [CortexAI Agent Hub Discord コミュニティ](https://discord.gg/RWwKa2Sn7h)でお気軽にどうぞ。
