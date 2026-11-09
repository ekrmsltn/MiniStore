# Cloud Deployment

This guide covers deploying MiniStore as a cloud web service using either the
Node.js/npm runtime or the repository's Docker image. The setting names vary
between hosting providers; use the equivalent fields on your platform.

## Before deploying

Complete the initial setup in the [operations guide](./operations.md):

- Create the Telegram bot and private Management and Storage Channels. Add the
  bot as an administrator with permission to post in both channels, or make
  it the channel creator.
- Generate and configure `TELEGRAM_USER_SESSION` for the owner MTProto
  account.
- Configure a working AI provider.
- Set the environment variables listed below in the platform's protected
  environment/secrets settings. Do not commit credentials or add `.env` to the
  image.

MiniStore persists records and media in Telegram, not on the service's local
filesystem. A persistent disk is not needed for application data. The service
does need outbound HTTPS access to Telegram and the configured AI provider.

## Choose a runtime

Use one of these configurations for a web service connected to the repository
and `main` branch (or the branch you deploy from). Keep the repository root as
the build context unless your provider uses separate source-directory and
Docker-context settings.

### Node.js with npm

Set the platform fields to:

| Field             | Value                        |
| ----------------- | ---------------------------- |
| Repository branch | `main` or your deploy branch |
| Runtime           | Node.js                      |
| Root directory    | `bot`                        |
| Build command     | `npm ci && npm run build`    |
| Start command     | `npm start`                  |
| Health check path | `/health`                    |

Use Node.js 22.12 or newer. The build compiles TypeScript, and `npm start`
runs the compiled `dist/main.js`.

### Docker

Set the platform fields to:

| Field                           | Value                        |
| ------------------------------- | ---------------------------- |
| Repository branch               | `main` or your deploy branch |
| Runtime                         | Docker                       |
| Root directory / Docker context | Repository root              |
| Dockerfile path                 | `docker/Dockerfile`          |
| Build command                   | Clear or leave unset         |
| Start command / Docker command  | Clear or leave unset         |
| Health check path               | `/health`                    |

The Dockerfile installs dependencies, builds the TypeScript application, and
starts it with its default command. Do not override that command unless you
intend to replace the image's `CMD`.

## Configure environment variables

Set these in the provider's runtime environment settings for either runtime:

| Variable                | Required value                                    |
| ----------------------- | ------------------------------------------------- |
| `BOT_TOKEN`             | Telegram Bot API token                            |
| `API_ID`                | Telegram API application ID                       |
| `API_HASH`              | Telegram API application hash                     |
| `TELEGRAM_USER_SESSION` | Authenticated owner MTProto session               |
| `STORAGE_CHANNEL_ID`    | Private Storage Channel ID in `-100...` format    |
| `MANAGEMENT_CHANNEL_ID` | Private Management Channel ID in `-100...` format |
| `OWNER_ID`              | Owner's numeric Telegram ID                       |
| `WEBHOOK_URL`           | Public HTTPS URL ending in `/telegram/webhook`    |
| `WEBHOOK_SECRET`        | Random 32–256 character webhook secret            |
| `AI_BASE_URL`           | HTTPS base URL for the AI provider                |
| `API_KEY`               | AI provider key                                   |
| `AI_MODEL`              | Model identifier accepted by the provider         |
| `NODE_ENV`              | `production`                                      |

`AI_API_FORMAT` is optional and defaults to `openai-compatible`; set it to
`anthropic` for the provider's Anthropic Messages API. `LOG_LEVEL` is also
optional and defaults to `info`.

Set `WEBHOOK_URL` to the service's stable, public HTTPS address plus
`/telegram/webhook`. Do not use a private/internal service address or a
temporary preview URL. If the public service URL changes, update
`WEBHOOK_URL` and restart or redeploy so MiniStore registers the new address
with Telegram. Generate a secret with `openssl rand -hex 32`; keep it private.

Do not set a fixed `PORT` unless your provider explicitly requires it. Web
service platforms commonly assign `PORT` at runtime; MiniStore listens on that
value and defaults to `3000` for local use. The service must be publicly
reachable over HTTPS at `WEBHOOK_URL`, and any proxy must forward
`/telegram/webhook` and preserve Telegram's
`X-Telegram-Bot-Api-Secret-Token` header.

## Health and startup

Configure the platform health check to use `GET /health`. It returns `200`
after Telegram credentials and required channels have been checked, the
Management Channel index has been recovered, and webhook registration
succeeds. It returns `503` while startup is still retrying dependencies; allow
sufficient startup time in the provider's health-check settings. Check the
service logs if it does not become healthy.

After deployment, confirm that `/health` returns `200`, the logs show webhook
registration and index recovery succeeded, and the bot responds in Telegram.
The bot remains in webhook mode; do not configure a polling worker.

## Switch an existing service to Docker

When migrating a live Node/npm service:

1. Commit and push the Dockerfile and deployment configuration to the branch
   the cloud service deploys.
2. Record the current environment values securely. Keep the same bot token,
   owner session, channel IDs, owner ID, AI settings, and webhook secret. Use
   the new service's stable public URL in `WEBHOOK_URL` if it differs.
3. Change the existing service to the Docker runtime if the provider supports
   it. Set the Dockerfile path to `docker/Dockerfile`, use the repository root
   as context, and clear the Node build and start commands. Keep the health
   check at `/health`.
4. If the provider cannot change an existing service's runtime, create a
   replacement service with those settings and copy the protected environment
   values. Do not create a second independently running bot.
5. Stop the old service before starting the Docker service with the same bot
   token. Telegram allows one webhook per bot; two services can replace each
   other's webhook and interrupt updates.
6. Wait for healthy status, inspect startup logs, and test the bot in Telegram.
   The index is reconstructed from the Management Channel when the new
   container starts.

Run exactly one instance. Multiple replicas have separate in-memory indexes
and can conflict while processing updates or registering the webhook.
