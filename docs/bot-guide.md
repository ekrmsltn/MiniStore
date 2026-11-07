# MiniStore User Guide

MiniStore is a Telegram bot for browsing and sharing files from private Telegram
channels. Use commands and inline buttons in the bot chat; there is no separate
website or account password. Your Telegram sender ID identifies your account.

For installation, channel setup, backups, and service health, see the
[operations guide](./operations.md).

## Getting access

1. Send `/start` to the bot.
2. The owner is granted full access automatically. Other people create an
   access request.
3. An administrator with `manage_users` can approve or reject the request.
4. After approval, send `/start` again to open the store.

The request is saved even if the bot cannot deliver a notification to an
administrator. Contact the owner if the request remains pending. Use `/status`
to check your current role and account status.

Pending, rejected, suspended, or blocked accounts cannot browse or use store
features. A rejected user may request access again with `/start`; suspended
and blocked users must contact an administrator.

## Commands

| Command     | What it does                                                  | Access                          |
| ----------- | ------------------------------------------------------------- | ------------------------------- |
| `/start`    | Open MiniStore, show your access state, or request access     | Anyone                          |
| `/store`    | Open browsing, search, favorites, and profile                 | Active approved users           |
| `/search`   | Start a search across resource titles, descriptions, and tags | Active approved users           |
| `/upload`   | Start uploading files to the root folder                      | `upload_resources` permission   |
| `/admin`    | Open administrator tools available to your permissions        | Admins and owner                |
| `/users`    | List users                                                    | `manage_users` permission       |
| `/requests` | Review pending access requests                                | `manage_users` permission       |
| `/status`   | Show your account role and status                             | Anyone                          |
| `/usage`    | Show assistant requests used, remaining, and next reset       | Active approved users and owner |
| `/ask`      | Ask the MiniStore assistant a question                        | Active approved users and owner |
| `/cancel`   | Clear a prompt/upload or end the assistant conversation       | Anyone                          |
| `/help`     | Show basic command help                                       | Anyone                          |

The configured owner has all permissions. An administrator can use only the
commands and admin-dashboard actions matching their explicitly granted
permissions; regular users do not receive admin or permission-restricted
assistant guidance.

Commands are sent in the private bot chat. The bot may also provide inline
buttons for the same actions.

### MiniStore assistant

Choose **🤖 Ask assistant** from the `/store` menu and send a question. You can
also use `/ask` to start the
prompt or send a question directly, for example
`/ask how do I restore a deleted folder?`. After an answer, send another plain
text message to continue the same conversation. Each assistant reply tells you
that you can use `/cancel` to cancel. `/cancel` stops an in-flight request,
clears the assistant context, and returns you to the MiniStore home menu.
Access is limited to the configured owner and active, approved accounts with
the `user` or `admin` role. Pending, rejected, suspended, blocked, and inactive
accounts cannot use the assistant or other store features.
People who have not been approved can still use `/start` to request access,
`/help` for generic command information, `/status` to see their own account
state, and `/cancel` to clear their pending interaction; these do not grant
access to store content or assistant responses.

Recent conversation turns are kept only in the bot process's memory (up to
five question/answer pairs) and sent to the configured AI provider along with
the next question. They expire after 30 minutes of inactivity, are lost if the
bot restarts, and are immediately cleared by `/cancel`. They are not written to
disk, logs, or the Management Channel. Telegram does not notify bots when a
user manually clears a chat, so clearing Telegram chat history alone cannot
clear this short-lived in-memory context; use `/cancel` when you want to clear
it immediately.

Answers are personalized using the caller's current role and permissions:
owners can ask about owner-level management; admins can ask about the
administrator dashboard and receive action guidance only for their explicitly
granted permissions; regular users receive user workflows and are directed to
an administrator for restricted tasks. The assistant knows the command names
and their access gates only as needed for the caller's role; it receives
operational instructions for restricted commands only when the caller is
authorized. The bot itself determines role and permissions—it does not trust
a role claimed in a question.
The assistant context includes basic active file/folder/download totals for
active users, user-request totals only for callers with `manage_users`, and
recent audit-event totals only for callers with `view_audit_logs`.
For resource questions, it looks up the current active catalog and sends up to
eight relevant records, including the MiniStore resource ID, title,
description, tags, filename, category, file type, folder, and version. You can
ask for a resource's ID, and the assistant will return the exact ID attached
to the matching record. Deleted resources are excluded and the lookup is
refreshed for each question. Broad catalog questions show up to eight recently
updated records; use `/search` for more. These selected resource details and
IDs are sent to the configured AI provider for resource questions; Telegram
storage IDs and uploader IDs are not sent.

The assistant uses a maintained, credential-free MiniStore knowledge base
covering documented user workflows, troubleshooting, and permission-specific
features. It is not a live code or documentation search and does not see the
running server. Its knowledge is not exhaustive; for details it does not know,
ask an administrator. Admin-only guidance is included only for that caller's
granted permissions, and owner/deployment guidance is included only for the
configured owner.

Assistant usage is limited per Telegram account over a rolling 24-hour window:
active users may make 50 requests, admins may make 100, and the configured
owner has no daily request limit. Each accepted request attempt counts even if
the provider later fails. Usage timestamps are stored in the private Management
Channel so limits survive bot restarts; prompts and answers are not stored as
part of usage tracking. The assistant does not receive a user's current usage
count or remaining quota. Use `/usage` to check requests used, requests
remaining, and the next request-slot reset time. Assistant replies also show
the current usage summary. When the limit is reached, the bot gives the exact
next available time in UTC; because the limit is rolling, each request slot
becomes available 24 hours after its corresponding request.
The configured owner can additionally see aggregate account-status counts
and per-account assistant usage in the **AI usage overview** in admin tools.

The assistant is read-only: it can explain MiniStore but cannot upload,
download, delete, change roles, or perform other actions. It does not receive
Bot API tokens, Telegram sessions, the API key, `.env` contents, Telegram IDs,
other users' identities, raw audit records, or per-user activity history. If
an active user asks who the configured owner is, the assistant may receive the
owner's saved display name and public Telegram username for that request only.
That profile is refreshed when the owner sends `/start`; no owner-only
instructions are included with the answer. MiniStore does not currently keep
per-user search or browsing history. Questions and the minimal role-scoped
context are sent to the configured AI provider to generate an answer; do not
include passwords, tokens, private personal data, or other sensitive
information in a question or follow-up, because recent turns are sent again to
the provider. Invalid questions and rate limits receive an
explanation; provider/network failures receive a safe error message and are
logged without returning provider response bodies. Unexpected errors are
logged and shown as a generic temporary-unavailability message. If the
assistant is not configured or the provider is unavailable, use the normal bot
menus or contact an administrator.

Assistant replies render common Markdown formatting (headings, emphasis,
numbered/bulleted lists, tables, links, and inline or fenced code) in Telegram.
Telegram-style bot commands remain plain text even when the assistant wraps
them and their usage arguments in inline code (for example
`/search <query>`), so Telegram can make the command tappable like the cancel
hint. This works for commands not currently listed in the bot guide too. Other
inline and fenced code remains formatted.
Commands sent while the assistant is waiting for a question are handled as bot
commands, not forwarded as assistant questions.
HTML from the provider is escaped rather than interpreted; links are rendered
only for HTTP or HTTPS addresses. If formatted output would exceed Telegram's
message limit, the bot sends the bounded answer as plain text; if Telegram
rejects formatting, the bot retries the answer without parse mode.

## Browsing and searching

1. Open `/store` and choose **Browse files**.
2. Select a folder or resource. Listings show up to eight entries per page;
   use the page controls to move through larger lists.
3. Sort folder contents by name or by newest.
4. Choose **Search** to enter a search phrase. Search matches active resources
   by title, description, or tag and shows up to 20 results.
5. Open a resource to view its description, tags, category label, file details,
   available versions, and download count.

Use the menu and back buttons to navigate. If a button is stale or no longer
matches the current state, reopen `/store` or `/admin`.

## Favorites and downloads

- Add or remove a resource from favorites on its resource screen.
- View saved favorites from the store menu.
- Download the current resource or an available earlier version from its
  details screen.
- Downloads are sent to you in Telegram. MiniStore preserves the original
  Telegram media type when copying the stored file.
- A successful download updates the resource's download count.

If a download fails, the original message may be missing from the Storage
Channel, or the owner account may not be able to read it. Contact an
administrator rather than repeatedly retrying a file that appears missing.

## Uploading files

Uploading requires the `upload_resources` permission.

### New files

1. Send `/upload` to upload to the root folder, or open a folder and choose
   **Upload here** to use that folder as the destination.
2. Send one or more files to the bot.
3. Each file is stored as its own resource as soon as it succeeds.
4. Use **Done** to finish the upload session or **Cancel** to stop accepting
   more files.

The bot accepts documents, photos, videos, audio, animations, voice notes,
video notes, and stickers. Each file is limited to 50 MB, in addition to
Telegram's own limits. Telegram file IDs already in the store are rejected as
duplicates.

Different files or folders in the same folder cannot use a name that already
exists there (matching is case-insensitive). MiniStore automatically appends a
number such as `(1)` to a duplicate name; for files, the suffix is placed
before the extension, for example `photo (1).jpg`. Names may be reused in
different folders. The upload confirmation shows the name actually stored.

Cancel ends the current session; it does not undo files that were already
uploaded successfully. A restart also clears temporary upload state but does
not remove saved files or metadata.

### Replacing a resource with a new version

An administrator with `upload_resources` can start a version upload from a
resource's details screen. Version uploads accept one file per action. The
previous version remains available for download until the resource is
permanently deleted.

### If an upload reports an error

If the bot says a file was saved but confirmation failed, check the resource
list before uploading it again. Telegram may have accepted the file even if
the connection failed before MiniStore received confirmation. MiniStore tries
to remove media that was uploaded but could not be linked to saved metadata;
cleanup can also fail and is logged for the administrator.

## Resource metadata

Administrators with `upload_resources` can edit resource metadata:

| Field          | Limit or behavior                        |
| -------------- | ---------------------------------------- |
| Title          | Required; 1–500 characters               |
| Description    | Up to 4,000 characters                   |
| Tags           | Up to 20 tags; each up to 100 characters |
| Category label | Up to 100 characters                     |

Send `-` to clear the description, tags, or category label. The category is a
label stored with the resource; MiniStore does not maintain a separate
category registry.

## Folders

Administrators with `manage_folders` can create, rename, and move folders.
Folder names may contain up to 100 characters, and nesting is limited to
10 levels. A folder cannot be moved into itself or one of its descendants.

Deleted folders are not available for normal browsing. Folder deletion and
restoration also require `delete_resources`. Folder names that collide with
another folder or file in the same parent are automatically suffixed, including
on rename, move, or restore.

## Administrator permissions

The owner has all permissions. Other administrators receive permissions
individually:

| Permission         | Allows                                            |
| ------------------ | ------------------------------------------------- |
| `upload_resources` | Upload files and versions; edit resource metadata |
| `delete_resources` | Delete, restore, and permanently delete resources |
| `manage_folders`   | Create, rename, and move folders                  |
| `manage_users`     | View users and approve or reject access requests  |
| `view_audit_logs`  | View recent activity                              |

Only the owner can promote or demote administrators, change administrator
permissions, suspend or block users, and reactivate suspended or blocked
accounts. Deleting, restoring, or permanently deleting folders requires both
`manage_folders` and `delete_resources`.

## Recycle bin and permanent deletion

Administrators with `delete_resources` can move resources to the recycle bin
and restore them. Permanent deletion cannot be undone: it removes the stored
media messages and resource version records. Folder deletion applies to
active contents within that folder tree and requires the additional
folder-management permission. Restoring that folder restores only the folders
and files that were moved to the recycle bin as part of that same folder
deletion. Items that were already in the recycle bin remain there. Restore
operations automatically suffix names if an active item has reused the
original name. Restore a deleted parent folder before restoring an individual
resource that was inside it.

If you are unsure whether a file is still needed, restore it instead of
permanently deleting it.

## Audit history

Users with `view_audit_logs` can view recent activity recorded by MiniStore.
Resource and folder operations, along with selected user-management
operations, are recorded in the Management Channel. Notification delivery
failures do not necessarily mean the underlying access decision was not saved;
check the request list or user record.

## Temporary actions and navigation

The bot keeps an in-progress text prompt, selected upload folder, or
version-upload action in process memory. Send `/cancel` or use the relevant
Cancel button to clear an active action. Restarting the bot also clears these
temporary actions. Saved resources and metadata remain in the channels.

Inline keyboards are rendered by Telegram clients, so button widths and
alignment can vary. Use the provided **Menu**, **Back**, **Admin menu**, or
**Store** buttons to return to a previous screen.

## Troubleshooting

| Problem                                   | What to try                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `/start` says access is pending           | Wait for an administrator or contact the owner.                                                                       |
| You cannot open the store                 | Check `/status`; suspended or blocked accounts need administrator help.                                               |
| A button does nothing or is stale         | Reopen `/store` or `/admin`, then try again.                                                                          |
| A text prompt is stuck                    | Send `/cancel` and start the action again.                                                                            |
| Upload is rejected                        | Check your permission, the 50 MB limit, duplicate warning, and Telegram file limits.                                  |
| Upload says saved but confirmation failed | Check the store before trying again to avoid creating a duplicate.                                                    |
| A resource or version will not download   | Ask an administrator to check that its Storage Channel message still exists.                                          |
| MiniStore is temporarily unavailable      | The service may be recovering channel data. Try again later; administrators can inspect the health endpoint and logs. |

See the [operations guide](./operations.md) for channel access, startup
recovery, and administrator troubleshooting.
