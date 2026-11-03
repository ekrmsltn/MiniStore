import { AdminPermission } from './permissions';

export const sharedAssistantKnowledge = [
  'MiniStore is a Telegram bot for browsing and managing files stored in private Telegram channels. There is no separate website.',
  'Command reference: /start checks access or opens the store; /store opens the store menu; /search searches active resource titles, descriptions, and tags; /status shows the caller role and account status; /usage shows the caller assistant request usage and next reset; /help shows basic help; /cancel clears a pending prompt or upload session and cancels an assistant conversation; /ask asks this assistant. /admin, /upload, /users, and /requests are restricted commands: /admin requires the admin role, /upload requires upload_resources, and /users and /requests require manage_users. The owner has all permissions. Do not give restricted-command instructions beyond the caller role and permissions in the supplied context.',
  'Assistant usage limits are rolling: active users may make 50 requests per 24 hours, administrators may make 100 requests per 24 hours, and the configured owner has no daily request limit. Every accepted request attempt counts, including a request whose provider call later fails. Usage data tracks request timestamps only; it does not contain prompts or answers. The assistant does not receive the caller remaining quota.',
  'The owner has full access. Other people request access with /start. An approved active user can browse folders, search, favorite resources, and download current or earlier versions. Pending, rejected, suspended, and blocked accounts cannot use store features.',
  'Browse from /store using inline buttons. Listings are paginated; a resource detail screen shows its metadata, versions, and download count. Search results match active resources by title, description, or tag.',
  'An upload is a separate resource. Supported Telegram media includes documents, photos, videos, audio, animations, voice notes, video notes, and stickers; each upload is limited to 50 MB and Telegram may impose additional limits. Existing Telegram file IDs are rejected as duplicates.',
  'Names are unique case-insensitively among active files and folders in the same folder. A collision is handled by adding a numbered suffix such as (1); file suffixes go before the extension. Names may be reused in different folders.',
  'Downloads are sent in Telegram. A download failure may mean the stored Telegram message is unavailable; ask an administrator to check the Storage Channel rather than repeatedly retrying.',
  'Use /cancel or the relevant Cancel button to stop a pending prompt or upload session. A bot restart clears temporary actions but does not remove saved resources or metadata.',
  'The assistant only explains MiniStore. It cannot perform actions, inspect live logs or health, see private channel history, or know an operation succeeded. For uncertain writes, check the store before retrying to avoid duplicate work.',
  'MiniStore does not record per-user search or browsing history. Download counts are aggregate and are not attributable to a particular person.',
  'Admin permissions do not grant the ability to manage administrator roles or suspend, block, or reactivate accounts; these actions are reserved for the owner.',
] as const;

export const adminAssistantKnowledge = [
  'The /admin command opens the administrator dashboard. Show and explain only actions allowed by the caller permissions listed in the supplied context. Admins cannot promote or demote administrators, change admin permissions, suspend or block users, or reactivate suspended or blocked accounts; those actions are reserved for the configured owner.',
] as const;

const permissionKnowledge: Record<AdminPermission, string[]> = {
  upload_resources: [
    'With upload_resources, /upload starts a new upload to the root folder. An administrator can also upload new resources, add a version from a resource detail screen, and edit resource metadata.',
    'Resource metadata limits: title 1–500 characters; description up to 4,000 characters; up to 20 tags of at most 100 characters each; category label up to 100 characters. Send - to clear description, tags, or category. Categories are labels, not a separate registry.',
    'A version upload accepts one file per action. Previous versions remain downloadable until the resource is permanently deleted.',
    'If upload confirmation fails after a file was sent, check the resource list before retrying because Telegram may have accepted the media.',
  ],
  delete_resources: [
    'With delete_resources, an administrator can move resources to the recycle bin, restore them, and permanently delete them. Permanent deletion cannot be undone and removes stored media and version records.',
    'Folder deletion, restoration, and permanent deletion also require manage_folders.',
    'When restoring a folder, only entries deleted as part of that same folder deletion are restored. Items already in the recycle bin remain there. Restore a deleted parent folder before restoring an individual resource inside it. Name collisions on restore receive a numbered suffix.',
    'If unsure whether an item is needed, restore it instead of permanently deleting it.',
  ],
  manage_folders: [
    'With manage_folders, an administrator can create, rename, and move folders. Folder names are limited to 100 characters and nesting to 10 levels. A folder cannot be moved into itself or one of its descendants.',
    'Folder names share the same case-insensitive naming space as files in their parent; collisions during create, rename, move, or restore receive a numbered suffix.',
    'Folder delete, restore, and permanent-delete actions require both manage_folders and delete_resources.',
  ],
  manage_users: [
    'With manage_users, /users lists users and /requests opens pending access requests. An administrator can view users and requests and approve or reject requests. Users request access by sending /start; after approval they send /start again.',
    'A saved access decision may succeed even if its notification could not be delivered. Check the user or pending-request list before repeating a decision.',
  ],
  view_audit_logs: [
    'With view_audit_logs, an administrator can view recent MiniStore audit activity from the admin tools. Selected resource, folder, and user-management operations are recorded.',
    'The assistant receives only an aggregate count of recent audit events, not the audit records, actor names, identifiers, targets, or metadata.',
  ],
};

export const ownerAssistantKnowledge = [
  'Only the configured owner can promote or demote administrators, change admin permissions, suspend or block users, and reactivate suspended or blocked accounts. The owner has all admin permissions.',
  'MiniStore stores metadata and audit records in the Management Channel and media messages in the Storage Channel. Startup checks Telegram access and rebuilds the in-memory index from channel history.',
  'A temporary health response of HTTP 503 can occur while startup recovery is running. Check service logs and allow the configured retry process to continue. Telegram channel access failures can prevent normal operations.',
  'For Docker operations, use the Compose command documented for the deployment. Rebuild and recreate the container after application-code or dependency changes; changing only .env values requires recreating the container, not rebuilding the image.',
  'The AI assistant provider URL, API key, model, and API format are configured in the environment. The URL, key, and model are required for MiniStore to start. The API key is used only as an HTTP authentication header and is not included in the assistant prompt. Never request, print, or share secret values.',
  'The assistant does not receive live runtime status, logs, channel permissions, environment values, source files, or deployment credentials. It can provide documented troubleshooting steps but cannot diagnose the current machine state.',
] as const;

export function getAssistantKnowledge(role: string, permissions: string[]): string[] {
  const knowledge: string[] = [...sharedAssistantKnowledge];
  if (role === 'admin' || role === 'owner') {
    knowledge.push(...adminAssistantKnowledge);
  }
  if (role === 'owner') {
    knowledge.push(...ownerAssistantKnowledge);
  }

  const grantedPermissions = new Set(permissions);
  for (const [permission, guidance] of Object.entries(permissionKnowledge)) {
    if (role === 'owner' || grantedPermissions.has(permission)) {
      knowledge.push(...guidance);
    }
  }
  return knowledge;
}
