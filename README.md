# MiniStore

MiniStore is a private Telegram bot for organizing and sharing files. Users browse, search, favorite, and download resources in Telegram. Authorized admins manage uploads, folders, users, and activity. Private Telegram channels store metadata and media; there is no web app or external database.

## What it supports

- Access requests and owner-controlled admin roles and permissions
- Nested folders, browsing, sorting, search, and favorites
- Telegram media uploads, metadata editing, version history, and download tracking
- Recycle bin, restore, permanent deletion, and audit history
- Required role-aware, read-only AI assistant for MiniStore help
- Telegram webhook delivery, Docker deployment, and operational health/status endpoints

## Documentation

- **Using MiniStore:** [Bot guide](./docs/bot-guide.md) — access, commands,
  permissions, browsing, uploads, administration, and user troubleshooting.
- **AI assistant:** [AI assistant guide](./docs/ai-assistant.md) — assistant
  behavior, role boundaries, resource matching and delivery, provider data
  handling, privacy, configuration, and maintenance.
- **Running MiniStore:** [Operations guide](./docs/operations.md) — credentials,
  channel setup, Docker deployment, persistence, backups, health checks, and
  incident troubleshooting.
- **Changing MiniStore:** [Developer guide](./docs/development.md) — code map,
  architecture, persistence flows, authorization, error handling, and tests.

## First-time local setup

Requirements: Node.js 22.12+, npm, a Telegram bot token, two private Telegram
channels, and Telegram API credentials plus an authenticated owner session for
MTProto channel reads.

Run these steps from the repository root. Create `.env` and set
`BOT_TOKEN`, `API_ID`, `API_HASH`, `OWNER_ID`, both channel IDs, the public
HTTPS `WEBHOOK_URL`, a random `WEBHOOK_SECRET`, and required AI provider
settings (`AI_BASE_URL`, `API_KEY`, and `AI_MODEL`) first. The webhook URL
must end in `/telegram/webhook`; see the
[operations guide](./docs/operations.md#configuration-and-secrets).
MiniStore commands, files, and assistant conversations are restricted to
private chats with the bot. Add the bot as an administrator in both channels
and grant it permission to post.

```bash
cp .env.example .env
cd bot
npm ci
npm run mtproto:login
```

`npm ci` installs the exact dependencies listed in the lockfile. You normally
run it once when setting up a checkout (and again after dependency changes or
removing `node_modules`).

`npm run mtproto:login` signs in the Telegram account, checks that it matches
`OWNER_ID`, and prints a session string. This is a one-time setup step for that
account/session: copy the printed value into `TELEGRAM_USER_SESSION` in the
repository-root `.env`. Do not share or commit the session string or bot token.
You do not need to run the login command every time you start the bot.
The AI provider settings are required for startup. Replace the example
values in `.env.example` with real provider values. See the
[operations guide](./docs/operations.md#configuration-and-secrets) and
[bot guide](./docs/bot-guide.md#ministore-assistant) for setup and data
handling details.

## Start locally

After first-time setup, start the bot from the `bot/` directory:

```bash
cd bot
npm run dev
```

The existing `TELEGRAM_USER_SESSION` is reused. Generate a new session only if
the current one is revoked or you need to authenticate a different owner
account. See the [operations guide](./docs/operations.md) for channel
permissions and deployment configuration. Telegram must be able to reach the
configured public HTTPS webhook URL; local development therefore needs a
public HTTPS tunnel or reverse proxy. See
[Test a local webhook with ngrok](./docs/operations.md#test-a-local-webhook-with-ngrok)
for local testing steps.

## Run locally with Docker

After completing the first-time setup above and saving the session in the
repository-root `.env`, run this from the repository root:

```bash
# First run: build the image and start the container.
docker-compose -f docker/docker-compose.yml up -d --build
```

For ordinary later starts, when you have not changed the application or
Docker configuration, use this instead; rebuilding each time is unnecessary:

```bash
docker-compose -f docker/docker-compose.yml up -d
```

After changing code, dependencies, or Docker configuration, run the first
command again to rebuild and start the updated app. The health endpoint is
available on the same machine at `http://127.0.0.1:3000/health`. If port 3000
is already in use, choose another host port without editing files:

```bash
HOST_PORT=3001 docker-compose -f docker/docker-compose.yml up -d --build
```

Then check `http://127.0.0.1:3001/health`. The `127.0.0.1` binding keeps the
operational endpoint accessible only from the Docker host; it does not prevent
the bot from connecting outbound to Telegram. View logs with
`docker-compose -f docker/docker-compose.yml logs -f ministore`. Stop the
container but keep it for later with `docker-compose -f docker/docker-compose.yml stop`,
or stop and remove it with `docker-compose -f docker/docker-compose.yml down`.
To also delete the MiniStore Docker image, run
`docker-compose -f docker/docker-compose.yml down --rmi all`; the next build
will recreate it.
For status, restart, port, troubleshooting, and deployment-security commands,
see the [Docker operations guide](./docs/operations.md#run-with-docker).
This machine's Compose command is `docker-compose` (version v2.32.4); use
that hyphenated form for the commands above. On systems with the Compose
plugin, `docker compose` is the equivalent form. See the
[Docker troubleshooting guide](./docs/operations.md#troubleshooting).

## Common bot commands

| Command               | Purpose                                                     |
| --------------------- | ----------------------------------------------------------- |
| `/start`              | Open MiniStore or request access                            |
| `/store`              | Browse, search, favorites, and profile                      |
| `/search`             | Search by title, description, or tags                       |
| `/upload`             | Start an upload to the root folder (admins with permission) |
| `/admin`              | Open permitted admin tools                                  |
| `/users`, `/requests` | Manage users and access requests (authorized admins)        |
| `/status`             | View your account role and status                           |
| `/cancel`             | Cancel a pending interaction or upload session              |
| `/help`               | Show basic commands                                         |

## Project layout

```text
bot/
├── bot.ts              Telegram commands and interactions
├── services/           users, resources, folders, permissions
├── telegram/           Telegram APIs, channels, and in-memory index
├── webhook.ts          Authenticated Telegram webhook endpoint
├── health.ts           Operational health/status endpoints
├── config.ts           Environment configuration
├── startup.ts          Startup retry behavior
├── models.ts           Data shapes
├── errors.ts, logger.ts
└── main.ts             Startup
bot/tests/   Tests
docs/             Guides
docker/           Docker deployment
```

Startup waits for Telegram channel access, index recovery, and webhook registration
before processing updates. While it retries temporary failures, `/health`
returns `503`; see the [operations guide](./docs/operations.md) for recovery
steps.

## Build, test, deploy

```bash
cd bot
npm run build
npm run lint
npm test
```

For Docker, configure `.env`, then run `docker-compose -f docker/docker-compose.yml up -d --build` from the repository root.
