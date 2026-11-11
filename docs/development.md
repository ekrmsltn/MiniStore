# Developer Guide

This guide describes MiniStore's code organization, runtime architecture,
data flows, and development practices. For configuration and deployment, see
the [operations guide](./operations.md). For Telegram user workflows, see the
[bot guide](./bot-guide.md). For assistant behavior, privacy, provider
configuration, and resource delivery, see the
[AI assistant guide](./ai-assistant.md).

## Project layout

```text
bot/
├── bot.ts                 Bot setup and handler wiring
├── config.ts              Environment loading and validation
├── errors.ts              Application and Telegram error types
├── health.ts              Operational HTTP endpoints
├── logger.ts              Structured Pino logging
├── main.ts                Startup, retry orchestration, and shutdown
├── models.ts              Persistent entity types and ID helpers
├── startup.ts             Cancellable startup retry helper
├── services/
│   ├── folders.ts         Folder lifecycle and hierarchy rules
│   ├── notifications.ts   Access-decision notifications
│   ├── permissions.ts    Permission definitions and checks
│   ├── resources.ts       Resource, version, and download lifecycle
│   ├── visibility.ts      Resource and inherited folder access policy
│   ├── assistant.ts      Assistant request orchestration and public API
│   ├── assistant/        Assistant formatting, identity, provider, and resource context
│   └── users.ts           Access requests, roles, permissions, favorites
├── handlers/
│   ├── assistant-ui.ts    Assistant reply formatting and conversation UI
│   ├── callbacks.ts       Callback registration entry point
│   ├── callbacks/         Store routing and admin decision callbacks
│   ├── commands.ts        User and admin command registration
│   ├── screens.ts         Store screens and compatibility exports
│   ├── screens/           Shared screen helpers and admin renderers
│   ├── state.ts           Process-local interaction state and action types
│   ├── text-actions.ts    Follow-up text interactions
│   └── uploads.ts         Upload prompts, callbacks, and media handling
├── telegram/
│   ├── index.ts           In-memory entity index and consistency checks
│   ├── management.ts      Management Channel JSON persistence
│   ├── mtproto.ts         Authenticated history reader
│   └── storage.ts         Media upload, download, and deletion
├── webhook.ts             Authenticated Telegram webhook endpoint
├── scripts/               Developer utilities
└── tests/                 Vitest unit and HTTP tests
docs/                      User, operations, and developer documentation
docker/                    Container build and Compose deployment
```

The application is intentionally a small single-process service, not a
framework with separate repositories and controllers. Start in `main.ts` for
runtime behavior, `bot.ts` for bot setup and command registration, `handlers/`
for feature-specific Telegram workflows, a service for business rules, and
`telegram/` for channel I/O.

## Runtime architecture

```text
Telegram update
      |
      v
 bot.ts handlers ---------> services/*
      |                          |
      |                          v
      |                    telegram/index.ts
      |                      /          \
      v                     v            v
 Bot API            management.ts    storage.ts
                    (JSON records)    (media)
                         ^               ^
                         |               |
                   MTProto reader (channel history and media lookup)
```

- grammY receives Telegram updates through the authenticated webhook in
  `webhook.ts`; the configured public HTTPS URL ends in `/telegram/webhook`.
- `bot.ts` wires the command, callback, upload, and text-action handlers.
  Feature handlers check the current index state and permissions, invoke
  services, and respond in chat.
- Services validate inputs and business constraints before changing entities.
- The in-memory index provides lookups and serializes changes by entity ID.
- The Management Channel is the durable metadata store. The Storage Channel
  holds original Telegram media.
- The owner MTProto session reads channel history and media that the Bot API
  cannot retrieve. The Bot API writes metadata and uploads/deletes messages.
- `health.ts` serves readiness information; it is not a user-facing web API.

Do not run multiple replicas. They would have separate in-memory indexes and
could conflict while processing updates or writing channel records.

## Startup and shutdown

`main.ts` validates configuration, starts the health listener, and retries
required startup operations: Bot API token validation, Bot API and owner-session
channel checks, index recovery, and webhook registration. Retries use
exponential backoff capped at one minute. The webhook returns `503` until
startup succeeds so Telegram can retry updates rather than processing them
against an uninitialized index.
The retry loop is cancellable so shutdown signals can stop a process waiting
for dependencies.

After startup succeeds, the app starts the periodic consistency check and
accepts updates through the webhook. Before a consistency-triggered rebuild,
the app stops accepting new webhook updates, drains active updates, then
rebuilds the index; a failed rebuild keeps updates paused until a later check
succeeds. Webhook requests must include Telegram's secret-token header. The
configured webhook is deliberately left in place at
shutdown so hosts that support waking on inbound requests can be reached by
Telegram; the host and Telegram retry behavior can delay delivery. Temporary
interaction state remains process-local and is cleared by a restart.

Shutdown stops accepting webhook updates, the retry loop, consistency timer,
health listener, and MTProto client. Shutdown tasks are awaited and failures
are logged.

## Persistence model

There is no SQL database, filesystem-backed store, or external database
service. Each persisted entity is a JSON message in the Management Channel.
The in-memory index is reconstructed from that history at startup and can be
rebuilt later; it is a cache, not the source of truth.

| Entity             | Purpose                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `user`             | Telegram identity, role, status, permissions, and favorites             |
| `folder`           | Folder name, parent, visibility, creator, and soft-delete state       |
| `resource`         | File metadata, visibility, Storage Channel references, version, and counters |
| `resource_version` | Historical file metadata and Storage Channel references                 |
| `audit`            | Actor, action, target, metadata, and timestamp                          |
| `session`          | Legacy record accepted for reading historical channel messages          |
| `assistant_usage`  | Per-account request timestamps and fixed quota-window start             |

Media is stored separately as messages in the Storage Channel. A resource
refers to a storage message ID and Telegram file ID. Do not delete or repost a
Management Channel message casually: its Telegram message ID is used by the
index when editing or deleting the entity.

## Important write flows

### Creating a resource

1. A handler receives an authorized user's media and captures its Telegram
   file ID and metadata.
2. `telegram/storage.ts` copies/uploads the media to the Storage Channel.
3. `services/resources.ts` validates the metadata and duplicate-file rules.
4. The index persists the resource record to the Management Channel, then
   updates its in-memory maps.
5. Audit metadata is written and the handler reports the result.
6. If the media upload succeeded but metadata persistence did not, the bot
   attempts to delete the unlinked media and logs cleanup failures.

Because a network timeout may happen after Telegram accepted the write,
operations with ambiguous outcomes must not be blindly retried.

### Directory names

Folder and resource names are unique across active entries in a single
directory, using case-insensitive comparison. The shared helper in
`services/naming.ts` appends a numbered suffix and preserves filename
extensions. Service mutations take a per-directory lock while allocating and
persisting names so concurrent creates in the same directory do not pick the
same name. Keep folder create/rename/move/restore and resource
create/update/restore operations on this shared policy.

### Updating an entity

Services construct and validate the updated entity. The index edits the
corresponding Management Channel message first and changes its in-memory copy
only after persistence succeeds. Per-entity locks prevent conflicting
concurrent writes from overwriting one another.

### Deleting resources and folders

Normal deletion is soft deletion where applicable. Permanent deletion removes
media and historical version records and cannot be undone. Folder operations
also enforce hierarchy depth and prevent moving a folder under itself or its
descendants. A folder-tree deletion assigns one optional `deletionBatchId` to
the root and only the active descendants/resources included in that deletion.
Restoring the root restores only matching batch members, preserving items
already in the recycle bin. Older records without a batch ID use the root
deletion timestamp for compatibility. Restore also allocates unique names in
the destination directory. Review cleanup and rollback behavior carefully
when changing these flows.

## Authorization and validation

Telegram sender IDs are the identity boundary. The owner ID bypasses
approval and has all permissions. Other users must be active and have the
required admin permission for privileged actions.

Keep authorization checks in handlers for user feedback and in service
operations where they are needed to protect business invariants. Never rely
only on whether a button is visible: Telegram callbacks can be replayed or
crafted independently of the current menu.

Resource visibility is enforced by `services/visibility.ts`: legacy resources
default to Public, legacy folders inherit, and each child audience is
intersected with every ancestor. Private includes only the owner and active
admins; Customize includes only the owner and selected active, approved
accounts (at most 200 selected IDs). Admin status does not bypass Customize.
Check the current caller's effective access before displaying, mutating, or
returning a resource, including resources nested in a folder operation.
Assistant resource metadata and aggregates must be built only from the
caller's accessible catalog and revalidated before delivery.

Services validate persistent data constraints, such as title lengths,
folder depth, resource limits, duplicate file IDs, unique directory names, and
valid parent references. When adding an entity shape or changing stored fields, update
`models.ts`, the Management Channel shape validation, service validation,
and relevant persistence tests together.

## Errors and recovery

- `AppError` and its subclasses carry HTTP-style status metadata for
  application failures. `TelegramApiError` represents Telegram I/O failures.
- Startup retries channel checks, index recovery, and webhook registration.
  Invalid configuration is rejected before that retry loop begins.
- Telegram retries webhook deliveries that receive a non-success response.
  Update-processing failures go through the bot's centralized error handler,
  which logs the error and attempts a generic reply.
- A handler may catch an error when it can provide clearer feedback or safely
  clean up a partial operation. Log cleanup failures separately; don't make a
  partially completed operation look successful.
- Do not add blanket catches that turn failures into empty data, `false`, or
  success-shaped results.
- Do not retry writes automatically when Telegram may have accepted the
  request. Preserve enough context in logs to investigate an uncertain
  outcome without logging secrets.
- Periodic consistency-check failures are logged. A transient read failure
  preserves a currently usable index; a failed rebuild leaves the index
  unavailable until a later recovery attempt.

Operational recovery steps and health semantics are documented in the
[operations guide](./operations.md).

## Required AI assistant

For the user-facing behavior, provider data flow, privacy, configuration, and
operational details, see the [AI assistant guide](./ai-assistant.md). The
engineering rules below are the implementation contract for changes to this
feature.

`services/assistant.ts` orchestrates a read-only assistant over configurable
`AI_BASE_URL`, `API_KEY`, `AI_MODEL`, and `AI_API_FORMAT` settings. Keep all
provider credentials in the environment. The API key belongs only in the
provider authentication header; do not include it in prompts, context,
exceptions, or logs. Keep provider errors generic and never log provider
response bodies.
The `services/assistant/` modules isolate Telegram-safe formatting, identity
masking and restoration, provider prompts and response parsing, shared context
types, and resource-context ranking. Keep authorization, conversation state,
and request orchestration in the service; extract additional modules when
those responsibilities grow without creating cross-module state dependencies.
The base URL, key, and model are required for application startup; replace all
example values before running the bot.

Authorization and context generation must stay in MiniStore code. Only the
configured owner and active, approved users/admins can ask questions; build
caller-scoped aggregate context using the caller's current permissions before
making a provider request. Do not send
other users' names, Telegram identifiers, raw audit entities, `.env` values,
or per-user activity. For owner-only account questions, locally match exact
stored display names and public usernames, then mask matched names, usernames,
and Telegram IDs before provider requests and conversation storage. Provide
only pseudonymous references and selected role, status, granted permission,
and creation-date facts to the model. Resolve returned references to saved
display names and public usernames only in the final Telegram response; never
return Telegram IDs. Apply the same local resolution to direct owner-identity
questions. Refresh the owner profile from Telegram when the owner sends
`/start`. For resource
questions, query the current active in-memory catalog each request and send at
most eight ranked records with their MiniStore resource IDs and bounded,
user-visible metadata. Exclude soft-deleted resources, Telegram storage IDs,
file IDs, and uploader IDs; IDs sent to the model must be MiniStore resource
IDs only. Broad catalog questions may return the eight most recently updated
active records. User questions and permitted context leave the process for the
configured provider, so document and privacy-review context expansions. The
model receives no tools or ability to mutate MiniStore state. Preserve provider
timeouts, input/output limits,
and per-user rate limiting. The home-menu callback and `/ask` command must
continue to share the same authorization and assistant service. The model
context must distinguish owner, admin, and user roles and include only
explicitly granted admin permissions. Keep provider failures sanitized; only
expected validation/authorization/provider messages should be shown to the
user, while unexpected errors are logged and mapped to a generic response.
The curated, credential-free knowledge in `services/assistant-knowledge.ts`
is the assistant's product reference. Update it when documented behavior
changes, keep permission-specific sections gated in code, and test that
ungranted admin guidance and owner/deployment guidance are absent from other
callers' provider requests. Do not replace it with unrestricted source,
documentation, environment, log, or channel-history access.
Resource context must be freshly resolved per request, capped, and treated as
untrusted data. The model may return selected resource IDs only in the
machine-readable download marker; validate each ID against the current active
snapshot before creating a Download button. Never expose IDs or dump metadata
fields as a list in the user-facing answer. The assistant may mention a useful
folder path or relevant search term when it helps locate a resource; it should
not list tags by default. Keep markers and raw internal IDs out of replies and
conversation history. Test metadata matching, marker validation,
deleted-item exclusion, answer sanitization, and truncation.
Pseudonymous user references must be process-scoped and contain no reversible
user ID. Never persist the local identity-to-reference mapping; conversation
history may retain aliases and non-identifying facts but never profile names,
usernames, or Telegram IDs. Test masking in the current question and prior
turns, owner-only access to user facts, final-response identity resolution,
and absence of actual identity values from provider requests and conversation
history.
Assistant conversation turns are process-memory-only, bounded to five recent
question/answer pairs, and expire after 30 minutes without a follow-up.
`cancelAssistantConversation` must clear this state and abort the caller's
in-flight request. Do not persist the transcript. Telegram Bot API does not
signal when a user clears the chat, so document that limitation rather than
claiming a chat clear can erase server-side state.
Normalize the documented provider response shapes in `extractAnswer`, then
format common Markdown into escaped Telegram HTML in `formatAssistantResponse`.
Keep Telegram replies under its message-size limit and retain the plain-text
fallback for oversized or rejected formatting; never retry unrelated Telegram
API errors as plain text.

## Adding a feature

For a new user-facing feature:

1. Define or reuse a typed entity shape in `models.ts` if persistence is
   needed.
2. Put business rules and validation in the appropriate service.
3. Add channel I/O only through the existing `telegram/` modules.
4. Add a handler or callback in `bot.ts`; validate authorization at the
   operation boundary, not just in menu rendering.
5. Consider audit history, partial failures, retries, and cleanup.
6. Add tests for success, validation failures, permission denial, Telegram
   failures, and partial completion as applicable.
7. Update the user or operations guide if behavior changes.

Avoid adding an abstraction for a single call unless it clarifies a real
boundary or prevents duplicated behavior.

## Development setup

Use Node.js 22.12+ and npm. These are first-time setup steps, not commands to
repeat every time you start the bot:

```bash
# From the repository root:
cp .env.example .env
# Fill in Telegram credentials, channel IDs, the public WEBHOOK_URL, a random
# WEBHOOK_SECRET, and real AI_BASE_URL, API_KEY, and AI_MODEL values in .env.

# Install dependencies and generate the owner session:
cd bot
npm ci
npm run mtproto:login
```

Copy the printed session into `TELEGRAM_USER_SESSION` in the repository-root
`.env` before starting the bot. Keep the session string and bot token secret.
`npm ci` is normally needed only for a fresh checkout, after dependency
changes, or after deleting `node_modules`. Run the login command again only
when the session is revoked or the owner account changes.

For routine local development, start the bot from `bot/`:

```bash
npm run dev
```

To run the compiled application:

```bash
npm run build
npm start
```

`npm run dev` uses `tsx watch`; it restarts the process after source changes.
After configuration validates, the first log is `Starting MiniStore...`,
followed by `Health/status server started` and readiness messages. Startup
configuration and module-loading errors are logged as
`Failed to start application`. If informational messages are hidden, set
`LOG_LEVEL=info` in the repository-root `.env` and restart. The bot requires
working Telegram credentials and channel access for live operation.

## Tests and quality checks

Run the project checks from `bot/`:

```bash
npm run build
npm run lint
npm test
```

Run a focused test file with:

```bash
npx vitest run tests/resource.service.test.ts
```

Tests mock Telegram interactions and should not require real credentials or
modify production channels. Existing test groups cover configuration,
services, persistence, MTProto behavior, permissions, health endpoints, and
bot interactions. Prefer focused regression tests for failure paths,
including failed persistence, user notification errors, retry cancellation,
and cleanup after partial uploads.

## Documentation map

- [Bot guide](./bot-guide.md): commands, permissions, browsing, uploads, and
  user troubleshooting.
- [Operations guide](./operations.md): secrets, deployment, backups, health,
  logs, and incident troubleshooting.
- [Cloud deployment guide](./cloud-deployment.md): provider-neutral Node.js/npm
  and Docker configuration, required environment values, health checks, and
  service migration.
