# Operations

## Configuration and secrets

Copy `.env.example` to `.env` at the repository root and set:

| Variable                | Purpose                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `BOT_TOKEN`             | Telegram Bot API token                                          |
| `API_ID`, `API_HASH`    | Telegram MTProto application credentials                        |
| `TELEGRAM_USER_SESSION` | Authenticated owner session for reading private channel history |
| `STORAGE_CHANNEL_ID`    | Private channel holding original media messages                 |
| `MANAGEMENT_CHANNEL_ID` | Private channel holding entity and audit messages               |
| `OWNER_ID`              | Numeric Telegram ID of the owner                                |
| `WEBHOOK_URL`           | Public HTTPS webhook URL ending in `/telegram/webhook`          |
| `WEBHOOK_SECRET`        | Random secret used to authenticate Telegram webhook requests    |
| `PORT`                  | Health/status listener port; defaults to `3000`                 |
| `NODE_ENV`              | Runtime environment                                             |
| `LOG_LEVEL`             | Pino log level; defaults to `info`                              |
| `AI_BASE_URL`           | Required AI provider API base URL                               |
| `API_KEY`               | Required AI provider API key; never put it in prompts or logs   |
| `AI_MODEL`              | Required model identifier accepted by the selected provider     |
| `AI_API_FORMAT`         | API format: `openai-compatible` (default) or `anthropic`        |

Telegram updates are delivered through a webhook; long polling is not used.
Set `WEBHOOK_URL` to the exact public HTTPS endpoint for this instance.
Generate a private webhook secret with `openssl rand -hex 32` and store it in
the deployment's private environment settings. When using `.env.example`, remove
the leading `#` from both webhook entries and replace the example values. The
webhook path is
`/telegram/webhook`; the server verifies Telegram's
`X-Telegram-Bot-Api-Secret-Token` header. Keep the route reachable over HTTPS
and preserve that header through any reverse proxy. Startup registers the
webhook only after channel access and index recovery succeed; requests received
before startup is ready get a retryable `503`. The webhook remains registered
when the process shuts down. A host that supports waking on inbound HTTP
traffic may resume when Telegram sends an update; the host's wake-up time and
Telegram's retry behavior mean delivery can be delayed.

For local development, a public HTTPS tunnel or reverse proxy must forward
that webhook URL to the local `PORT`; `localhost` alone cannot receive
Telegram's requests. A sleeping host may delay processing until it wakes.
Each process restart rebuilds the channel-backed index and clears temporary
in-memory interactions, just as any other restart does.

## Cloud deployment

For provider-neutral instructions to deploy MiniStore using Node.js/npm or
Docker, configure health checks and secrets, or migrate an existing service,
see the [cloud deployment guide](./cloud-deployment.md). It covers the required
cloud fields and safe single-instance webhook setup.

### Test a local webhook with ngrok

An HTTPS tunnel lets Telegram send webhook updates to a MiniStore process
running on your computer. This is for testing, not permanent hosting; your
computer, MiniStore, and tunnel must stay running.

1. Install ngrok and follow its [official setup guide](https://ngrok.com/docs/share-localhost/overview/).
   If ngrok asks you to configure an account authtoken, add it using the
   command shown in your ngrok dashboard. Treat that token as a password; do
   not put it in `.env`, source control, or chat.
2. In a terminal, start a tunnel to MiniStore's default local port:

   ```bash
   ngrok http 3000
   ```

   Keep this terminal open. Copy the HTTPS forwarding address shown by ngrok,
   for example `https://example.ngrok-free.app` (use your actual address).

3. Generate a webhook secret in a separate terminal:

   ```bash
   openssl rand -hex 32
   ```

   Keep the output private. In the repository-root `.env` file, set
   `WEBHOOK_URL` to the ngrok address plus `/telegram/webhook`, and set
   `WEBHOOK_SECRET` to the generated value:

   ```dotenv
   WEBHOOK_URL=https://example.ngrok-free.app/telegram/webhook
   WEBHOOK_SECRET=replace_with_your_generated_secret
   ```

   Also replace the AI provider example values in `.env` with real
   `AI_BASE_URL`, `API_KEY`, and `AI_MODEL` values. MiniStore will not start
   until all three are configured.

4. From the `bot/` directory, start MiniStore:

   ```bash
   npm run dev
   ```

   Wait for the logs to confirm the Telegram webhook is registered and for
   `http://localhost:3000/health` to return `200`. Then test the bot in
   Telegram.

The ngrok HTTPS address may change when you restart the tunnel. If it changes,
update `WEBHOOK_URL` in `.env` and restart MiniStore so it registers the new
address. Stop the local bot and tunnel when finished. If you restart another
MiniStore instance using the same bot token, it will register its own webhook
URL, replacing the local one. Do not run both instances at once; use a
separate test bot and test channels when possible.

Treat the ngrok account, authtoken, and traffic inspector as sensitive. The
public tunnel exposes the webhook route to the internet, although MiniStore
rejects webhook requests without the configured secret-token header. Do not
share ngrok inspector captures or screenshots; they may contain Telegram
update content.

MiniStore requires an AI provider configuration to start. Set
`AI_BASE_URL`, `API_KEY`, and `AI_MODEL` to real values from your provider;
the example placeholders in `.env.example` must be replaced. `AI_API_FORMAT`
is optional and defaults to `openai-compatible`. Set it to `anthropic` when
using a provider's native Anthropic Messages API. This lets you switch
providers by changing the endpoint, key, model, and API format in `.env`,
without adding the key to source code. The provider endpoint must use HTTPS in
production (localhost endpoints are allowed).

For example, replace the required AI values in `.env.example` with values from
your provider:

```dotenv
AI_BASE_URL=https://api.example.com/v1
API_KEY=replace_with_your_provider_key
AI_MODEL=replace_with_a_model_identifier
AI_API_FORMAT=openai-compatible
```

For a provider's native Anthropic Messages API, use its base URL (commonly
`https://api.anthropic.com/v1`) and set `AI_API_FORMAT=anthropic`. Keep the
provider's key private just like `BOT_TOKEN` and `TELEGRAM_USER_SESSION`.

The API key is sent only as the provider's HTTP authentication header. It is not
included in prompts or assistant context, and log redaction recognizes
`API_KEY`. A question and minimum role-filtered context are sent to the
configured provider, so tell users this is enabled and do not send sensitive
user data. For resource questions, up to eight matched active resource records
are also sent to the provider, including internal MiniStore resource IDs and
bounded catalog metadata; Telegram storage IDs and uploader IDs are excluded.
The assistant does not display its internal IDs or tags to users. A direct
question about the owner is resolved locally, so the owner's actual name and
username are not sent to the provider. For owner-only account questions, the
provider receives pseudonymous profile references and selected role, status,
permission, and creation-date facts; matched names, usernames, and Telegram IDs
are masked locally and are not saved in conversation history.
The assistant is read-only, has no tools to modify the store, and never
receives Telegram credentials, `.env` contents, Telegram/user IDs, raw audit
events, or individual user activity.

Active users see **🤖 Ask assistant** in the `/store` inline
menu. Users can also ask with `/ask <question>` or start a prompted question
with `/ask`; after an answer, plain text continues the conversation.
`/cancel` stops the prompt or in-flight request, clears assistant context, and
returns the user to the MiniStore home menu. Responses are based on the verified
caller role. Only the configured owner or active, approved users/admins can
access the assistant or store features; pending, rejected, suspended, blocked,
or inactive accounts are denied. The owner receives owner-level guidance, admins only receive
guidance for explicitly granted permissions, and users receive regular
user-facing help. Provider failures produce safe user-facing messages and
server logs omit provider response bodies; unexpected errors are logged and
shown as a generic temporary failure. A temporary provider outage can make
assistant requests unavailable, but does not prevent other store features from
working.
Unapproved people can still use `/start` to request access, `/help` for generic
command information, `/status` to view their own account state, and `/cancel`
to clear a pending interaction; none of these commands grant store or
assistant access.
The assistant receives a maintained, credential-free knowledge base of
documented product workflows, permission-specific help, and safe owner
troubleshooting—not source files, full documentation, logs, or live machine
state. Resource metadata is looked up from the current active index for each
resource question; deleted records are excluded and broad catalog results are
capped at eight. Matching metadata and resource IDs are sent to the configured
AI provider, but IDs are never shown to users and metadata is not dumped in
answers. The assistant may mention a useful folder path or relevant search
term when it helps locate a resource; tags are not listed by default.
Resource matching and aggregate counts are scoped to the caller's effective
visibility; private or customized resources the caller cannot access are not
sent to the provider. Assistant-selected IDs are checked against current access
before the bot offers an in-chat Download button. Keep this knowledge reviewed
and updated with behavior or documentation changes; the model must acknowledge
missing knowledge instead of guessing.
The assistant retains up to five recent question/answer pairs in process
memory for 30 minutes after the last question. The turns are sent to the
provider with each follow-up and are not written to disk, logs, or Telegram
channel records. A restart or `/cancel` clears them. Telegram does not tell
bots when a user manually clears chat history, so a manual chat clear does not
clear this short-lived memory; tell users to send `/cancel` to clear it
immediately. Users should not include credentials or sensitive data in a
question or follow-up.

Assistant request limits are 50 per active user and 100 per admin in a fixed
24-hour window that starts with each user's first request; the full quota
resets when that window ends. The configured owner has no daily cap. Accepted
request attempts count even if the provider later returns an error. Per-user
usage timestamps and the window start (without prompts or answers) are
persisted as `assistant_usage` records in the private Management Channel, so
usage limits survive restarts.
These records contain Telegram account IDs and request times; keep Management
Channel access restricted. Current usage counts are not included in assistant
prompts. Users can run `/usage` or read the usage footer on assistant replies
to see their count, remaining requests, and window reset time. Limit errors
include the exact reset time in UTC. The configured owner also has an **AI usage
overview** in the admin tools showing account status and per-account usage;
this all-user view is owner-only and is not included in assistant prompts.

For the complete explanation of assistant behavior, access boundaries, data
sent to the provider, resource matching and delivery, privacy, and maintenance,
see the [AI assistant guide](./ai-assistant.md). Review the provider's data
handling policy before deployment and tell users that assistant questions and
permitted context are sent to that provider.

The bot must be a channel administrator with permission to post in both
channels, or be the channel creator. Startup verifies the bot's member status
and posting permission before marking channel access ready.
`TELEGRAM_USER_SESSION` is required to run the bot; it can remain blank only
while generating the initial session.
The Telegram account in that session must match `OWNER_ID`, belong to both
channels, and be able to read their history. Archiving a channel only changes
its folder in the owner's Telegram account; it does not prevent access. The
owner session checks archived and active dialogs, then its cached channel
entities. Startup validates required credentials, webhook URL and secret,
channel IDs, owner ID, API ID, and port format before contacting Telegram.

### One-time initial setup

From the repository root, copy `.env.example` to `.env` and set the Telegram
credentials, channel IDs, owner ID, public webhook URL, and webhook secret.
The webhook URL must be available from your hosting provider; for local
testing, follow [Test a local webhook with ngrok](#test-a-local-webhook-with-ngrok)
to obtain a temporary URL. Then install dependencies and generate the initial
owner session from the `bot/` directory:

```bash
cd bot
npm ci
npm run mtproto:login
```

`npm ci` installs the exact dependency versions from the lockfile. Run it
during initial setup, after dependency changes, or after removing
`node_modules`; it is not required for every bot start.

`npm run mtproto:login` interactively signs in the Telegram account, verifies
that it matches `OWNER_ID`, and prints the owner session string. Copy that
string into `TELEGRAM_USER_SESSION` in the repository-root `.env` or a secret
manager. Keep it secret; do not commit it, put it in logs, or share it. This
login step is not part of routine startup. Repeat it only if the session is
revoked or you need to authenticate a different owner account.

Keep application logs access-controlled. HTTP access logs include the request
method and response metadata but omit request URLs, headers, and bodies. The
logger redacts configured credentials and Telegram identifier fields,
including bot tokens embedded in Bot API URLs. Redaction reduces accidental
exposure but does not make logs public-safe: review logs for message content
or other personal/operational data before sharing them.

MiniStore handles commands, callbacks, and files only in private chats. Group
messages and callbacks are not processed; users are directed to open a private
chat with the bot.

## Run with Docker

### Requirements

- Docker Engine and either the Compose plugin (`docker compose`) or the
  standalone Compose command (`docker-compose`). The examples below use
  `docker-compose`; if your system only has the Compose plugin, use
  `docker compose` instead.
- A configured `.env` file at the repository root. It must contain valid
  Telegram credentials and channel IDs, `TELEGRAM_USER_SESSION`, and
  `WEBHOOK_URL` and `WEBHOOK_SECRET`.
  Complete [one-time setup](#one-time-initial-setup) first if you have not
  generated the owner session yet.
- Outbound network access from Docker to Telegram.

No separate `npm ci` on the host is needed to run the Docker image. The
Dockerfile installs the locked dependencies and builds the application as part
of the image build.

### First run and routine startup

Run commands from the repository root (the directory containing `.env` and
the `docker/` folder). On the first run, build the image and start the
container:

```bash
docker-compose -f docker/docker-compose.yml up -d --build
```

The first build may take a few minutes. For later starts when you have not
changed the application code, dependencies, Dockerfile, or Compose
configuration, just run:

```bash
docker-compose -f docker/docker-compose.yml up -d
```

You do **not** need to rebuild the image every time. `-d` runs the service in
the background. If you stopped it with `docker-compose ... stop`, either
`docker-compose ... start` or `docker-compose ... up -d` will start it again.
If you removed the container with `docker-compose ... down`, use `up -d` to
create it again.

After changing application code or dependencies, rebuild and start with:

```bash
docker-compose -f docker/docker-compose.yml up -d --build
```

This builds the updated image and recreates the container if needed. If you
pull new project changes, use this same command to ensure the running
container uses the updated code.

By default, the health/status listener is published on
`http://127.0.0.1:3000`. This is the loopback address of the machine running
Docker, not a hard-coded development machine address. It means only programs
on that same machine can connect to the listener. Telegram sends webhook
updates to the public `WEBHOOK_URL`, which must be routed to this listener;
the bot also makes outbound Telegram API requests.

To use a different host port without editing any files, set `HOST_PORT` for
the Compose command. For example, on Linux or macOS:

```bash
HOST_PORT=3001 docker-compose -f docker/docker-compose.yml up -d --build
```

Then use `http://127.0.0.1:3001`. In PowerShell, set the variable for the
command like this:

```powershell
$env:HOST_PORT = "3001"
docker-compose -f docker/docker-compose.yml up -d --build
```

The container still listens on port `3000`; `HOST_PORT` changes only the
machine-side port. If you have stopped using the custom port and want the
default again, run Compose without `HOST_PORT` (or clear the environment
variable first).

### Check status, view logs, and stop

All commands below are run from the repository root. Check whether the
container is running and its health state:

```bash
docker-compose -f docker/docker-compose.yml ps
```

Show the container's health status:

```bash
docker inspect --format='{{.State.Health.Status}}' ministore
```

Check the health endpoint from the Docker host:

```bash
curl http://127.0.0.1:3000/health
```

If you selected a different `HOST_PORT`, use that port instead. The endpoint
may return `503` during startup while MiniStore checks Telegram channel access
and rebuilds its index. Check the container logs and allow its retry process
to continue:

```bash
docker-compose -f docker/docker-compose.yml logs --tail 100 ministore
```

Follow new log output while troubleshooting:

```bash
docker-compose -f docker/docker-compose.yml logs -f ministore
```

Press `Ctrl+C` to stop following logs; this does not stop the container. To
temporarily stop the container but keep it available for a later `start`:

```bash
docker-compose -f docker/docker-compose.yml stop
docker-compose -f docker/docker-compose.yml start
```

To stop and remove the container and its Compose network:

```bash
docker-compose -f docker/docker-compose.yml down
```

To also remove the image used by this MiniStore Compose project:

```bash
docker-compose -f docker/docker-compose.yml down --rmi all
```

This stops and removes the MiniStore container and Compose network, then
removes the image(s) used by this Compose project. It does not remove Docker
images for unrelated projects. The next `up -d --build` will build the image
again. MiniStore's source files, `.env`, and Telegram channel data are not
removed.

If you want to inspect or remove the image manually, first stop/remove the
MiniStore container, then list images:

```bash
docker-compose -f docker/docker-compose.yml down
docker image ls
```

Find the image created for the MiniStore service in the list, then remove it
by its image ID:

```bash
docker image rm IMAGE_ID
```

Replace `IMAGE_ID` with the actual ID shown by `docker image ls`. Docker will
refuse to remove an image that is still used by a container; remove the
MiniStore container first. Avoid `docker system prune -a` for this task: it
can remove unused images belonging to other projects too.

The bot's persistent data is stored in the Telegram channels, not in the
container filesystem. Removing the container does not delete channel data.
Keep `.env` backed up securely because it contains credentials and the owner
session.

After changing values in `.env`, run this from the repository root so Compose
recreates the container with the new environment. Changing only environment
values does not require rebuilding the image:

```bash
docker-compose -f docker/docker-compose.yml up -d
```

### Useful command reference

Run these commands from the repository root:

| What you want to do                                    | Command                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| First start or start after `down`                      | `docker-compose -f docker/docker-compose.yml up -d --build`             |
| Routine start without code changes                     | `docker-compose -f docker/docker-compose.yml up -d`                     |
| Rebuild after code/config/dependency changes           | `docker-compose -f docker/docker-compose.yml up -d --build`             |
| List status                                            | `docker-compose -f docker/docker-compose.yml ps`                        |
| Follow logs (Ctrl+C exits log view only)               | `docker-compose -f docker/docker-compose.yml logs -f ministore`         |
| Show last 100 log lines                                | `docker-compose -f docker/docker-compose.yml logs --tail 100 ministore` |
| Restart the existing container                         | `docker-compose -f docker/docker-compose.yml restart ministore`         |
| Stop but keep the container                            | `docker-compose -f docker/docker-compose.yml stop`                      |
| Start a previously stopped container                   | `docker-compose -f docker/docker-compose.yml start`                     |
| Stop and remove the container/network                  | `docker-compose -f docker/docker-compose.yml down`                      |
| Stop, remove container/network, and MiniStore image(s) | `docker-compose -f docker/docker-compose.yml down --rmi all`            |
| List local images                                      | `docker image ls`                                                       |

Use `restart` for a simple process restart when the image and configuration
have not changed. Use `up -d --build` after code, dependency, Dockerfile, or
Compose changes so the updated image/configuration is applied.

The container runs as a non-root user and drops Linux capabilities. It starts
the bot webhook and health/status listener together. Startup retries channel
checks, index recovery, and webhook registration while health remains unready.
The webhook is not removed on shutdown, allowing Telegram to deliver pending
updates when the service starts again. Shutdown stops webhook processing,
the consistency timer, HTTP server, and owner MTProto connection.

### Network exposure

The default `127.0.0.1` binding is intentional and also applies when running
Compose on a production server. A reverse proxy on that same server can reach
the listener through loopback and should forward `/telegram/webhook` and the
Telegram secret-token header. Another machine cannot connect to it directly.
Do not expose this port to the public internet unless you have deliberately
configured appropriate network access controls. The health/status listener is
for operations; users interact with MiniStore through Telegram.

## Run without Docker

### Routine local start

After completing initial setup and saving `TELEGRAM_USER_SESSION`, start the
ngrok tunnel (or another HTTPS reverse proxy), set its public URL in
`WEBHOOK_URL`, and start the bot from the `bot/` directory:

```bash
cd bot
npm run dev
```

Do not rerun `npm run mtproto:login` each time. The bot reads and reuses the
session from the configured environment.

## Persistence and recovery

- The Management Channel is authoritative for user, folder, resource, version, and audit records. Each record is a JSON message. Folder and resource records may include a `deletionBatchId` while they are in the recycle bin; this links the active items moved together by one folder deletion and is cleared when restored. The field is optional so records written by older versions remain readable.
- The Storage Channel is authoritative for original media messages.
- The process-local in-memory index is rebuilt from Management Channel history at startup; it is not a backup.
- MTProto reads channel history; the Bot API writes and edits messages. If the initial Bot API
  validation, required channel access, or index recovery fails, the health listener stays available
  but unready while startup retries with an exponentially increasing delay capped at one minute.
  Channel access, index recovery, and webhook registration must all succeed before Telegram
  updates are processed.
- Periodic consistency checks compare the index with channel data once per hour. A transient
  check failure is logged without discarding an otherwise usable in-memory index. Before rebuilding,
  MiniStore returns retryable `503` responses to new webhook requests and waits for active updates
  to finish. A failed rebuild keeps updates paused and health unready; a later consistency check
  retries the rebuild and resumes updates only after recovery succeeds.
- If an upload reaches the Storage Channel but its metadata cannot be saved, MiniStore attempts to remove the unlinked media and logs cleanup failures. Telegram/network timeouts can leave the outcome unknown; check the store before retrying.
- Bot update failures are logged and the bot attempts to send a generic error reply. Failure to
  deliver that reply is logged separately. Individual command or callback operations may provide
  more specific feedback.
- Startup retries webhook registration; Telegram retries webhook deliveries
  that do not receive a successful response. Ordinary writes and user actions
  are not blindly retried. A timeout can occur after Telegram accepted a
  write, so confirm the current channel/store state before manually repeating
  an operation.

There is no automated, application-aware backup/restore command. Export both channels independently with Telegram Desktop for archival, encrypt the exports, store them off-host, and back up `.env` separately using protected secret storage. These exports are not a complete direct restore: reposted Management Channel records receive new Telegram message IDs, while resource and version records refer to Storage Channel message IDs. Reposting records without remapping those references can leave resources or media unusable.

For an operational outage, keep the bot stopped while diagnosing the issue; do not delete or recreate either production channel as a troubleshooting step. If the original channels remain available, restore the bot and owner account's membership/permissions, correct the configuration, and start MiniStore so it can recover the index from the original history. If channel content was lost, preserve the exports and contact the project maintainer before reposting records or media; a complete recovery requires remapping Telegram message references, which MiniStore does not currently automate. Treat restore testing in isolated channels, with a migration/remapping procedure, as a prerequisite before relying on exports for disaster recovery.

Old session records may remain in channel history for backward compatibility; the bot no longer creates or uses application sessions.

## Health and logs

- `GET /health` returns 200 when the entity index is initialized and webhook
  registration succeeded, otherwise 503. During startup recovery, 503 is
  expected; the process keeps retrying. Docker's healthcheck may report the
  container as unhealthy while this endpoint returns 503.
- `GET /api/status` reports whether the entity index is initialized and the
  webhook is registered (`initializing` or `running`).
- `POST /telegram/webhook` is the Telegram update endpoint and requires the
  configured secret-token header. User actions are performed through Telegram.

Useful commands:

```bash
docker-compose -f docker/docker-compose.yml ps
docker-compose -f docker/docker-compose.yml logs --tail 100 ministore
docker inspect --format='{{.State.Health.Status}}' ministore
docker stats ministore
```

## Troubleshooting

- **`docker compose` reports `unknown shorthand flag: 'f'` or says
  `compose` is not a Docker command:** the Compose plugin is missing or
  unavailable to the Docker CLI. Check both command forms:

  ```bash
  docker compose version
  docker-compose --version
  ```

  If `docker-compose --version` prints a version, use the hyphenated
  `docker-compose` form (for example,
  `docker-compose -f docker/docker-compose.yml up -d --build`). If the
  `docker compose version` command works instead, use `docker compose` with
  the same options. If neither command works,
  install the current Docker Compose v2 plugin for your operating system or
  install/update Docker Desktop, then open a new terminal and confirm
  `docker compose version` succeeds. Installation steps vary by Linux
  distribution; use the official Docker installation instructions for your
  distribution rather than running an arbitrary install script. This is a
  Docker setup issue and does not require changing MiniStore files.

- **`Required Telegram access or index recovery is unavailable`:** this is a
  retry warning, not the underlying error. If the accompanying
  `Telegram channel access checks failed` log shows a channel as not ready,
  inspect the preceding `Bot API cannot post...` or
  `Owner session cannot read...` warning. If the Bot API error is `401
Unauthorized`, Telegram rejected `BOT_TOKEN`: replace it with the current
  token from BotFather in the local `.env` or hosting environment, then restart.
  This happens before channel permissions are checked; changing channel access
  will not fix an invalid token. Other Bot API permission errors mean check the
  channel ID and add the bot as an administrator with permission to post, or
  make it the channel creator. The owner session warning means check the full
  channel ID and confirm the account in `TELEGRAM_USER_SESSION` matches
  `OWNER_ID`, is still a member, and can read history. If instead logs say
  index recovery failed, inspect that error for
  malformed or inaccessible Management Channel history. Startup retries
  automatically after temporary access or network failures are restored.
  Invalid/revoked credentials or an incorrect channel ID require configuration
  or account changes. Verify all required values in `.env`, especially that
  the owner ID/session match and both the bot and owner account have the
  required channel membership and permissions.
- **Channel not found:** check the full `-100...` channel ID and confirm the owner session still belongs to the channel. The owner session checks archived and active dialogs, then cached entities; inspect logs for whether Bot API access or owner-session MTProto access failed.
- **Webhook registration or Telegram API errors:** check outbound network
  access, bot token validity, the exact `WEBHOOK_URL`, and whether another
  service is changing the bot's webhook configuration. Startup does not accept
  updates until webhook registration succeeds.
- **Uploads fail:** verify the bot can post to both channels; each file must be at most 50 MB and comply with Telegram limits.
- **Downloads fail:** check that the referenced Storage Channel message still exists and that the owner session can read it.
- **Health returns 503:** check whether startup is still retrying Management/Storage Channel access,
  webhook registration, or index recovery. Inspect logs for the failing layer; a malformed entity
  record in Management Channel history also prevents a successful rebuild and must be corrected
  without deleting unrelated channel history.
- **Bot appears unresponsive:** inspect Telegram/network errors in logs, reopen the current menu, and use `/cancel` for a pending interaction.
- **Startup fails on configuration:** confirm channel IDs use the full `-100...` format and `OWNER_ID`, `API_ID`, and `PORT` contain valid positive integers/ranges.
- **Startup fails on webhook configuration:** set both `WEBHOOK_URL` and
  `WEBHOOK_SECRET`. The URL must be public HTTPS and end exactly in
  `/telegram/webhook`; the secret must be 32-256 letters, numbers, underscores,
  or hyphens. Keep the secret private.
- **Telegram updates are not processed:** verify the webhook URL is reachable
  over HTTPS, the secret is configured only in the environment, and Telegram
  can reach `/telegram/webhook`. Inspect startup logs for registration errors
  and deployment logs for webhook request failures.
