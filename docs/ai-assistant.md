# MiniStore AI Assistant

This guide explains how the assistant works, what it can access, how it handles
resource questions, and how to configure and maintain it. For general Telegram
commands and permissions, see the [bot guide](./bot-guide.md). For deployment
and environment-variable setup, see the [operations guide](./operations.md).

## What the assistant does

The assistant provides conversational help about MiniStore using a maintained,
credential-free knowledge base and the caller's verified role and permissions.
It can answer user workflow questions, provide permission-appropriate
administrative guidance, use current resource details to find files, and share
resources with an in-chat **Download** button.

The assistant is read-only. It has no tools to change users, permissions,
files, folders, or settings. It is not a general search of the source code,
documentation, logs, Telegram channels, or live server. It must not guess when
its supplied knowledge does not answer a question.

## Who can use it

The configured owner and active, approved accounts with the `user` or `admin`
role can use the assistant. Pending, rejected, suspended, blocked, and inactive
accounts cannot. The bot checks access before sending a request to the
provider.

The caller role and permission set come from MiniStore's current account data,
not claims in a question:

- **Owner:** receives owner-level help.
- **Admin:** receives guidance only for permissions currently granted to that
  admin.
- **User:** receives user workflows and is directed to an administrator for
  restricted tasks.

The assistant does not disclose owner-only workflows to regular users or
admins without the necessary permissions. A direct question about the
configured owner's identity may be answered with the owner's saved display
name and validated public Telegram username, if available. The bot refreshes
this saved profile when the owner sends `/start`. Actual profile values are
added locally to the final reply rather than sent to the AI provider. For
non-owner callers, the provider receives only a pseudonymous reference for
this lookup, not the owner's role, status, permissions, or creation date.
Callers can also ask who they are or what name is saved for their own account.
The model writes the answer using a pseudonymous `current_caller` reference;
the bot resolves it locally. Questions about the assistant itself are answered
as the MiniStore help assistant.

For owner-only questions about user accounts, the bot can match an exact
stored display name or public username locally. It masks matched names,
usernames, and Telegram IDs before sending the question to the AI. The AI sees
only pseudonymous references and selected account facts: role,
status, granted admin permissions, and creation date. Each reference is labeled
as the current caller, configured owner, or another account, without sending
the identity itself. Broad account questions
include at most 30 profile references per request. When answering the owner,
the bot replaces each account reference in the final Telegram reply with the
stored display name and public username, but never a Telegram ID. The owner
can therefore see the real saved identity and the available account facts;
masking applies only to provider requests and stored assistant conversation
history. Those real identity values are not included in the provider request
or saved in assistant conversation history; only pseudonymous references and
non-identifying answer text are retained in the short-lived conversation.
Before saving a model response, the bot masks any known profile names,
usernames, or Telegram IDs it echoes.
References use a random process-local key and cease to be stable when the bot
restarts. The AI determines the response structure and which requested account
facts to include. Locally, the bot only substitutes pseudonymous references
using the exact `[[MINISTORE_USER:USER_0123456789AB]]` marker with the saved
display name and clickable public username; unrecognized or malformed markers
are removed. This local parser does not generate a fixed profile block, so
count-only questions stay focused. Username links open the corresponding
`t.me` profile.

Use the **🤖 Ask assistant** button in `/store`, `/ask` to enter a question,
or `/ask <question>` to ask directly. After an answer, send another plain-text
message to continue the conversation. Use `/cancel` to stop an in-flight
request and clear the conversation. You can also edit one of your prompts that
the assistant has answered: the bot generates a replacement answer and edits
its previous reply. If you edit an earlier prompt, later turns based on the old
version are removed from the conversation. `/usage` shows your current request
usage.

## Resource search and delivery

For a resource-related question, the bot reads the current active resource
catalog from its index and ranks records locally using terms from the question
against titles, tags, filenames, descriptions, categories, file types, and
folder paths. Matching is lexical; it is not vector search. Deleted resources
are excluded, and the catalog is refreshed for each question. At most eight
matches are sent to the model. Broad catalog questions use the eight most
recently updated active records; use `/search` for the store's regular search
flow.

Resource metadata helps the assistant match the request; it should not be
dumped as a metadata list in the answer. The assistant should name relevant
resources naturally and may include a folder path when it helps the user
locate or browse to the file. It may mention a relevant tag or search term
when useful for finding the file, but should not list tags by default. It must
not reveal MiniStore resource IDs or Telegram storage details. The model can
select resources using an internal marker; the bot removes the marker and
validates every selected ID against the current active catalog before using
it. If the model does not provide a marker but names a current resource, the
bot can use that active title as a fallback selection.

For a validated match, the bot shows a **Download** button labelled with the
resource title. Tapping the button makes the bot copy the file from the private
Storage Channel into the user's Telegram chat. The assistant does not create
or provide a public download URL. If the resource has been deleted or is no
longer available when the button is used, normal store handling reports that
the file is unavailable.

The AI provider may receive the selected records' MiniStore IDs, title,
description, tags, filename, file type and size, category, folder, version,
download count, and timestamps to support matching. It does not receive
Telegram storage message IDs, Telegram file IDs, or uploader IDs. Do not put
sensitive information in resource metadata: selected metadata is sent to the
configured provider for resource questions.

## Information sent to the AI provider

MiniStore sends requests to the provider configured by the operator. Depending
on the question and the caller's permissions, a request can contain:

- The user's question and up to five recent question/answer pairs.
- The caller's verified role and explicitly granted permissions.
- Credential-free, role- and permission-scoped knowledge entries.
- Permitted aggregate counts, such as active resources and folders. User and
  pending-request counts are included only for callers with `manage_users`;
  recent audit-event counts are included only for callers with
  `view_audit_logs`.
- For relevant questions, up to eight matching current resource records as
  described above.
- For owner-only account questions, pseudonymous references and selected
  account facts, as described above. A direct owner-identity question uses the
  same local resolution and does not send the owner's name or username.

The assistant does not receive provider credentials in its prompt, `.env`
contents, Telegram bot or user IDs, user profile names, usernames, Telegram
IDs, raw audit records, or other users' individual
activity, Telegram channel history, or source files. For owner-only account
lookups, the prompt contains pseudonymous references and selected account
facts, never actual profile identity values. Current assistant usage counts
are not included in the prompt.

Questions and the listed context leave the MiniStore process and are subject
to the configured provider's data handling, retention, and privacy policies.
Do not include passwords, API keys, tokens, private personal data, or other
sensitive information in questions or resource metadata. Operators should
review the provider's policies and inform users that the assistant is enabled.

## Conversation memory and privacy

Conversation state is process-memory-only and contains at most five recent
question/answer pairs. It expires after 30 minutes without a follow-up, is
cleared by `/cancel`, and is lost when the bot restarts. MiniStore does not
write assistant transcripts to disk, application logs, or the Management
Channel. Follow-up turns are sent to the provider as part of the next request.

Telegram does not notify the bot when a user manually clears chat history, so
clearing the Telegram chat does not clear this short-lived server-side
conversation. Send `/cancel` to clear it immediately.

Assistant usage is tracked separately from conversation content. Accepted
request attempts count toward the quota even if the provider later fails.
Usage timestamps are persisted as `assistant_usage` records in the private
Management Channel so limits survive restarts; prompts and answers are not
stored in those records. Keep Management Channel access restricted. Only the
configured owner can view the all-account AI usage overview.

## Request limits and reliability

- Maximum question length: 1,500 characters.
- Per-user cooldown: 10 seconds between requests for admins and regular users.
- Fixed 24-hour quota window starting with the user's first request: 50
  requests for users, 100 for admins, unlimited for the configured owner. The
  full quota resets when that window ends.
- Provider request timeout: 30 seconds.
- Provider completion limit: 800 tokens; the returned answer is limited to
  3,800 characters before Telegram formatting.

The `/usage` command and assistant reply footer show usage and the quota reset
time. Limit errors include the reset time in UTC.

Provider, validation, access, and rate-limit errors are handled with safe
user-facing messages. Provider response bodies are not logged or shown to the
user. Unexpected failures are logged and mapped to a generic temporary error.
A provider outage makes assistant requests unavailable but does not stop
ordinary store operations.

## Answer formatting

The bot renders common Markdown such as headings, emphasis, lists, tables, and
code in Telegram. It escapes provider-supplied HTML instead of interpreting it,
and only formats links with `http` or `https` URLs. Telegram bot commands are
kept tappable even when written anywhere inside inline code; ordinary code
remains formatted. Commands inside fenced code blocks remain code. If formatted
output is too long or Telegram rejects its formatting, the bot falls back to
bounded plain text.

## Provider configuration

MiniStore requires all three values below to start:

```dotenv
AI_BASE_URL=https://api.example.com/v1
API_KEY=replace_with_your_provider_key
AI_MODEL=replace_with_a_model_identifier
```

`AI_API_FORMAT` is optional and defaults to `openai-compatible`. Set it to
`anthropic` for a provider's native Anthropic Messages API. The base URL must
use HTTPS in production; localhost endpoints are allowed for development. The
application appends `/chat/completions` for the OpenAI-compatible format or
`/messages` for Anthropic.

Keep `API_KEY` in the environment. It is sent only in the provider's
authentication header, not in prompts, application logs, or user-facing
errors. Never commit or share the key. See the [operations guide](./operations.md)
for configuration, deployment, and secret-management instructions.

## Implementation and maintenance

The main implementation is in `bot/services/assistant.ts`; Telegram
interaction, request flow, and validated resource download buttons are in
`bot/bot.ts`. The maintained product reference and role-gated knowledge are
in `bot/services/assistant-knowledge.ts`.

When changing assistant behavior:

1. Keep role and permission checks in MiniStore code; never trust a role
   claimed in a prompt.
2. Keep context minimal, caller-scoped, bounded, and fresh. Review every new
   field for privacy before sending it to the provider.
3. Treat prompts and resource metadata as untrusted data. Do not add provider
   tools or unrestricted access to source code, documentation, logs, or
   channel history.
4. Validate model-selected resource IDs against the current active catalog.
   Never display internal IDs or raw metadata markers in replies or saved
   conversation turns.
5. Keep provider credentials and response bodies out of prompts and logs.
   Preserve request timeouts, input/output limits, cancellation, and safe
   error handling.
6. Test authorization boundaries, prompt contents, resource matching and
   selection validation, deleted-resource handling, answer sanitization,
   conversation expiry/cancellation, quota behavior, and provider failures.

See the [developer guide](./development.md#required-ai-assistant) for the
engineering contract and test expectations.
