import { Context, InlineKeyboard } from 'grammy';
import { loadConfig } from '../config';
import {
  canAccessStore,
  getUserById,
  getAllUsers,
  getPendingRequests,
  isAdmin,
} from '../services/users';
import {
  getAllResources,
  getDeletedResources,
  getResource,
  getResourceVersions,
  searchResources,
} from '../services/resources';
import { formatFileSize } from '../telegram/storage';
import { index } from '../telegram/index';
import { getDeletedFolders } from '../services/folders';
import { getAssistantUsageOverview, isAssistantConfigured } from '../services/assistant';
import { AVAILABLE_PERMISSIONS, hasPermission } from '../services/permissions';
import { textActionState, type TextAction } from './state';

type BrowseSort = 'name' | 'recent';
const config = loadConfig();

export function isAdminUser(telegramId: number): boolean {
  return index.isInitialized() && isAdmin(telegramId);
}

export function addBackButton(keyboard: InlineKeyboard, callbackData = 'lib:home'): InlineKeyboard {
  return keyboard.text('← Menu', callbackData);
}

export function resourceIdFromToken(token: string): string {
  return token.startsWith('resource:') ? token : `resource:${token}`;
}

export function folderIdFromToken(token: string): string {
  return token.startsWith('folder:') ? token : `folder:${token}`;
}

export async function renderScreen(
  ctx: Context,
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  } else {
    await ctx.reply(text, { reply_markup: keyboard });
  }
}

export function getHomeKeyboard(telegramId: number): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text('📂 Browse files', 'lib:browse:root')
    .text('🔍 Search', 'lib:search')
    .row()
    .text('⭐ Favorites', 'lib:favorites')
    .text('👤 Profile', 'lib:profile');
  if (isAssistantConfigured()) {
    keyboard.row().text('🤖 Ask assistant', 'assistant:ask');
  }
  if (isAdminUser(telegramId)) {
    keyboard.row().text('⚙️ Admin tools', 'admin:home');
  }
  return keyboard;
}

export async function showHome(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId || !canAccessStore(telegramId)) {
    await renderScreen(
      ctx,
      'Your MiniStore account is not active. Use /start to check access.',
      new InlineKeyboard(),
    );
    return;
  }
  await renderScreen(ctx, 'MiniStore — choose an action:', getHomeKeyboard(telegramId));
}

export async function showBrowse(
  ctx: Context,
  folderId: string | null,
  page = 0,
  sort: BrowseSort = 'name',
): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId || !canAccessStore(telegramId)) {
    await renderScreen(ctx, 'You do not have access to MiniStore.', new InlineKeyboard());
    return;
  }

  const folder = folderId ? index.getFolder(folderId) : undefined;
  if (folderId && (!folder || folder.isDeleted)) {
    await renderScreen(ctx, 'That folder is no longer available.', getHomeKeyboard(telegramId));
    return;
  }

  const childFolders = folderId ? index.getChildFolders(folderId) : index.getRootFolders();
  const resources = index
    .getResources()
    .filter((resource) => !resource.isDeleted && resource.folderId === folderId);
  const entries = [
    ...childFolders.map((item) => ({
      kind: 'folder' as const,
      id: item.id,
      name: item.name,
      createdAt: item.createdAt,
    })),
    ...resources.map((item) => ({
      kind: 'resource' as const,
      id: item.id,
      name: item.title,
      createdAt: item.createdAt,
    })),
  ];
  entries.sort((left, right) =>
    sort === 'recent'
      ? right.createdAt.localeCompare(left.createdAt) || left.name.localeCompare(right.name)
      : left.name.localeCompare(right.name),
  );
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
  const requestedPage = Number.isSafeInteger(page) ? page : 0;
  const safePage = Math.min(Math.max(0, requestedPage), pageCount - 1);
  const pageEntries = entries.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const keyboard = new InlineKeyboard();

  for (const entry of pageEntries) {
    const label = `${entry.kind === 'folder' ? '📁' : '📄'} ${entry.name}`.slice(0, 60);
    keyboard
      .text(
        label,
        entry.kind === 'folder'
          ? `lib:browse:${entry.id.slice('folder:'.length)}`
          : `lib:resource:${entry.id.slice('resource:'.length)}`,
      )
      .row();
  }
  const folderToken = folderId?.slice('folder:'.length) || 'root';
  keyboard.text(
    sort === 'name' ? 'Sort: Name' : 'Sort: Newest',
    `lib:sort:${folderToken}:${sort === 'name' ? 'recent' : 'name'}`,
  );
  if (folderId) {
    keyboard.text(
      '⬆️ Up one folder',
      `lib:browse:${folder?.parentId?.slice('folder:'.length) || 'root'}`,
    );
  }
  keyboard.row();
  if (safePage > 0) keyboard.text('‹ Previous', `lib:page:${folderToken}:${safePage - 1}:${sort}`);
  if (safePage + 1 < pageCount)
    keyboard.text('Next ›', `lib:page:${folderToken}:${safePage + 1}:${sort}`);
  if (safePage > 0 || safePage + 1 < pageCount) keyboard.row();
  if (hasPermission(telegramId, 'upload_resources')) {
    keyboard.text('📤 Upload here', `lib:upload:${folderToken}`);
  }
  if (hasPermission(telegramId, 'manage_folders')) {
    keyboard.text('➕ New folder', `lib:folder-create:${folderToken}`);
  }
  if (
    hasPermission(telegramId, 'upload_resources') ||
    hasPermission(telegramId, 'manage_folders')
  ) {
    keyboard.row();
  }
  addBackButton(keyboard);

  const title = folder ? `📁 ${folder.name}` : '📂 MiniStore files';
  const text = entries.length
    ? `${title}\n${entries.length} item${entries.length === 1 ? '' : 's'}${pageCount > 1 ? ` · page ${safePage + 1}/${pageCount}` : ''}`
    : `${title}\nThis folder is empty.`;
  await renderScreen(ctx, text, keyboard);
}

export async function showResource(
  ctx: Context,
  resourceId: string,
  back = 'lib:browse:root',
  versionPage = 0,
): Promise<void> {
  const telegramId = ctx.from?.id;
  const resource = getResource(resourceId);
  if (!telegramId || !canAccessStore(telegramId) || !resource || resource.isDeleted) {
    await renderScreen(ctx, 'This file is unavailable.', getHomeKeyboard(telegramId ?? 0));
    return;
  }

  const resourceToken = resource.id.slice('resource:'.length);
  const keyboard = new InlineKeyboard().text('⬇️ Download', `lib:download:${resourceToken}`).row();
  const previousVersions = getResourceVersions(resource.id).filter(
    (version) => version.version !== resource.version,
  );
  const versionPageSize = 5;
  const versionPageCount = Math.ceil(previousVersions.length / versionPageSize);
  const safeVersionPage = Math.min(Math.max(0, versionPage), Math.max(0, versionPageCount - 1));
  for (const version of previousVersions.slice(
    safeVersionPage * versionPageSize,
    (safeVersionPage + 1) * versionPageSize,
  )) {
    keyboard
      .text(
        `⬇️ v${version.version} · ${version.fileName}`.slice(0, 60),
        `lib:download-version:${resourceToken}:${version.version}`,
      )
      .row();
  }
  if (versionPageCount > 1) {
    if (safeVersionPage > 0) {
      keyboard.text('‹ Older', `lib:version-page:${resourceToken}:${safeVersionPage - 1}`);
    }
    if (safeVersionPage + 1 < versionPageCount) {
      keyboard.text('Newer ›', `lib:version-page:${resourceToken}:${safeVersionPage + 1}`);
    }
    keyboard.row();
  }
  const isFavorite = getUserById(telegramId)?.favorites.includes(resource.id) ?? false;
  keyboard
    .text(isFavorite ? '⭐ Remove favorite' : '☆ Add favorite', `lib:favorite:${resourceToken}`)
    .row();
  if (hasPermission(telegramId, 'upload_resources')) {
    keyboard
      .row()
      .text('🔁 Upload new version', `lib:version:${resourceToken}`)
      .text('✏️ Edit metadata', `lib:resource-edit:${resourceToken}`);
  }
  if (hasPermission(telegramId, 'delete_resources')) {
    keyboard.row().text('🗑️ Move to recycle bin', `lib:resource-delete:${resourceToken}`);
  }
  keyboard.row().text('← Back to files', back);

  const size = formatFileSize(resource.fileSize);
  const text =
    `📄 ${resource.title}\n${resource.description ? `\n${resource.description}\n` : '\n'}Type: ${resource.fileType}\nSize: ${size}\nVersion: ${resource.version} · Downloads: ${resource.downloadCount}${resource.categoryId ? `\nCategory: ${resource.categoryId}` : ''}${resource.tags.length ? `\nTags: ${resource.tags.join(', ')}` : ''}`.slice(
      0,
      4000,
    );
  await renderScreen(ctx, text, keyboard);
}

export async function showSearchResults(ctx: Context, query: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId || !canAccessStore(telegramId)) return;
  const results = searchResources(query).slice(0, 20);
  const keyboard = new InlineKeyboard();
  for (const resource of results) {
    keyboard
      .text(
        `📄 ${resource.title}`.slice(0, 60),
        `lib:resource:${resource.id.slice('resource:'.length)}`,
      )
      .row();
  }
  keyboard.text('🔍 Search again', 'lib:search');
  addBackButton(keyboard);
  await renderScreen(
    ctx,
    results.length
      ? `Search: ${query}\n${results.length} result${results.length === 1 ? '' : 's'}${results.length === 20 ? ' (showing first 20)' : ''}`
      : `No files found for "${query}".`,
    keyboard,
  );
}

export async function showFavorites(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId || !canAccessStore(telegramId)) return;
  const favorites = (getUserById(telegramId)?.favorites ?? [])
    .map((id) => getResource(id))
    .filter((resource) => resource && !resource.isDeleted);
  const keyboard = new InlineKeyboard();
  for (const resource of favorites) {
    if (resource)
      keyboard
        .text(
          `⭐ ${resource.title}`.slice(0, 60),
          `lib:resource:${resource.id.slice('resource:'.length)}`,
        )
        .row();
  }
  addBackButton(keyboard);
  await renderScreen(
    ctx,
    favorites.length ? `⭐ Favorites (${favorites.length})` : 'You have no saved favorites yet.',
    keyboard,
  );
}

export async function promptForText(
  ctx: Context,
  action: TextAction,
  message: string,
): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  textActionState.set(telegramId, action);
  await ctx.reply(message, {
    reply_markup: new InlineKeyboard().text('Cancel', 'lib:cancel'),
  });
}

export async function showAdminResources(ctx: Context, page = 0): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId || !isAdminUser(telegramId)) return;
  const resources = getAllResources();
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(resources.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const keyboard = new InlineKeyboard();
  for (const resource of resources.slice(safePage * pageSize, (safePage + 1) * pageSize)) {
    keyboard
      .text(
        `📄 ${resource.title}`.slice(0, 60),
        `lib:resource:${resource.id.slice('resource:'.length)}`,
      )
      .row();
  }
  if (safePage > 0) keyboard.text('‹ Previous', `admin:resources:${safePage - 1}`);
  if (safePage + 1 < pageCount) keyboard.text('Next ›', `admin:resources:${safePage + 1}`);
  if (safePage > 0 || safePage + 1 < pageCount) keyboard.row();
  if (hasPermission(telegramId, 'upload_resources')) {
    keyboard.text('📤 Upload to root', 'lib:upload:root').text('← Admin menu', 'admin:back');
  } else {
    keyboard.text('← Admin menu', 'admin:back');
  }
  await renderScreen(
    ctx,
    resources.length
      ? `📄 Resources (${resources.length})${pageCount > 1 ? ` · page ${safePage + 1}/${pageCount}` : ''}\nChoose a file to view actions.`
      : 'There are no active resources.',
    keyboard,
  );
}

export async function showAdminFolders(ctx: Context, page = 0): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId || !hasPermission(telegramId, 'manage_folders')) return;
  const folders = index.getFolders().filter((folder) => !folder.isDeleted);
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(folders.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const keyboard = new InlineKeyboard();
  for (const folder of folders.slice(safePage * pageSize, (safePage + 1) * pageSize)) {
    keyboard
      .text(`📁 ${folder.name}`.slice(0, 60), `lib:folder:${folder.id.slice('folder:'.length)}`)
      .row();
  }
  if (safePage > 0) keyboard.text('‹ Previous', `admin:folders:${safePage - 1}`);
  if (safePage + 1 < pageCount) keyboard.text('Next ›', `admin:folders:${safePage + 1}`);
  if (safePage > 0 || safePage + 1 < pageCount) keyboard.row();
  keyboard.text('➕ New root folder', 'lib:folder-create:root').text('← Admin menu', 'admin:back');
  await renderScreen(
    ctx,
    folders.length
      ? `📁 Folders (${folders.length})${pageCount > 1 ? ` · page ${safePage + 1}/${pageCount}` : ''}`
      : 'There are no folders yet.',
    keyboard,
  );
}

export async function showAdminFolder(ctx: Context, folderId: string): Promise<void> {
  const telegramId = ctx.from?.id;
  const folder = index.getFolder(folderId);
  if (!telegramId || !hasPermission(telegramId, 'manage_folders') || !folder || folder.isDeleted) {
    await renderScreen(
      ctx,
      'This folder is unavailable.',
      new InlineKeyboard().text('← Folders', 'admin:folders'),
    );
    return;
  }
  const children = index.getChildFolders(folderId);
  const resources = index
    .getResources()
    .filter((resource) => resource.folderId === folderId && !resource.isDeleted);
  const keyboard = new InlineKeyboard()
    .text('📂 Browse contents', `lib:browse:${folder.id.slice('folder:'.length)}`)
    .row()
    .text('➕ Add subfolder', `lib:folder-create:${folder.id.slice('folder:'.length)}`)
    .text('✏️ Rename', `lib:folder-rename:${folder.id.slice('folder:'.length)}`)
    .row()
    .text('↔️ Move folder', `lib:folder-move:${folder.id.slice('folder:'.length)}`);
  if (hasPermission(telegramId, 'delete_resources')) {
    keyboard.text('🗑️ Delete', `lib:folder-delete:${folder.id.slice('folder:'.length)}`);
  }
  keyboard.row().text('← Folders', 'admin:folders').text('Admin menu', 'admin:back');
  await renderScreen(
    ctx,
    `📁 ${folder.name}\n${children.length} subfolder${children.length === 1 ? '' : 's'} · ${resources.length} file${resources.length === 1 ? '' : 's'}`,
    keyboard,
  );
}

export async function showRecycleBin(ctx: Context, page = 0): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId || !hasPermission(telegramId, 'delete_resources')) return;
  const resources = getDeletedResources().filter(
    (resource) => !resource.folderId || !index.getFolder(resource.folderId)?.isDeleted,
  );
  const folders = hasPermission(telegramId, 'manage_folders') ? getDeletedFolders() : [];
  const entries = [
    ...folders.map((folder) => ({ kind: 'folder' as const, id: folder.id, name: folder.name })),
    ...resources.map((resource) => ({
      kind: 'resource' as const,
      id: resource.id,
      name: resource.title,
    })),
  ];
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const keyboard = new InlineKeyboard();
  for (const entry of entries.slice(safePage * pageSize, (safePage + 1) * pageSize)) {
    const isFolder = entry.kind === 'folder';
    const token = entry.id.slice(isFolder ? 'folder:'.length : 'resource:'.length);
    keyboard
      .text(
        `${isFolder ? '📁' : '📄'} ${entry.name}`.slice(0, 45),
        `lib:trash-${entry.kind}:${token}`,
      )
      .text('Restore', `lib:restore-${entry.kind}:${token}`)
      .row();
  }
  if (safePage > 0) keyboard.text('‹ Previous', `admin:recycle:${safePage - 1}`);
  if (safePage + 1 < pageCount) keyboard.text('Next ›', `admin:recycle:${safePage + 1}`);
  if (safePage > 0 || safePage + 1 < pageCount) keyboard.row();
  keyboard.text('← Admin menu', 'admin:back');
  await renderScreen(
    ctx,
    entries.length
      ? `🗑️ Recycle Bin\n${folders.length} folder tree${folders.length === 1 ? '' : 's'} · ${resources.length} deleted file${resources.length === 1 ? '' : 's'}${pageCount > 1 ? ` · page ${safePage + 1}/${pageCount}` : ''}`
      : 'Recycle Bin is empty.',
    keyboard,
  );
}

export async function showAdminUsers(ctx: Context, page = 0): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId || !hasPermission(telegramId, 'manage_users')) return;
  const users = getAllUsers().filter((user) => user.telegramId !== config.ownerId);
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(users.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const keyboard = new InlineKeyboard();
  for (const target of users.slice(safePage * pageSize, (safePage + 1) * pageSize)) {
    const name = target.firstName || target.username || String(target.telegramId);
    keyboard
      .text(
        `${target.role === 'pending' ? '⏳' : '👤'} ${name}`.slice(0, 55),
        `lib:user:${target.telegramId}`,
      )
      .row();
  }
  if (safePage > 0) keyboard.text('‹ Previous', `admin:users:${safePage - 1}`);
  if (safePage + 1 < pageCount) keyboard.text('Next ›', `admin:users:${safePage + 1}`);
  if (safePage > 0 || safePage + 1 < pageCount) keyboard.row();
  keyboard.text('⏳ Pending requests', 'admin:requests').text('← Admin menu', 'admin:back');
  await renderScreen(
    ctx,
    `👥 Users (${users.length})${pageCount > 1 ? ` · page ${safePage + 1}/${pageCount}` : ''}`,
    keyboard,
  );
}

export async function showAssistantUsageOverview(ctx: Context, page = 0): Promise<void> {
  const ownerId = ctx.from?.id;
  if (ownerId !== config.ownerId) {
    await ctx.reply('❌ Only the owner can view all-user assistant usage.');
    return;
  }

  const overview = getAssistantUsageOverview(ownerId);
  const pageSize = 6;
  const pageCount = Math.max(1, Math.ceil(overview.entries.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const entries = overview.entries.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const lines = entries.map((entry) => {
    const name = entry.name.length > 32 ? `${entry.name.slice(0, 31)}…` : entry.name;
    const identity = `${name} · ${entry.role} (${entry.status})`;
    if (!entry.usage) return identity;
    const reset = entry.usage.resetsAt
      ? ` · next ${entry.usage.resetsAt.toISOString().slice(11, 16)} UTC`
      : '';
    return `${identity}: ${entry.usage.used}/${entry.usage.limit} · ${entry.usage.remaining} left${reset}`;
  });
  const keyboard = new InlineKeyboard();
  if (safePage > 0) keyboard.text('‹ Previous', `admin:usage:${safePage - 1}`);
  if (safePage + 1 < pageCount) keyboard.text('Next ›', `admin:usage:${safePage + 1}`);
  if (safePage > 0 || safePage + 1 < pageCount) keyboard.row();
  keyboard.text('← Admin menu', 'admin:back');

  const summary =
    `📊 Assistant usage · ${overview.totalUsers} accounts\n` +
    `Active users: ${overview.activeUsers} · Active admins: ${overview.activeAdmins}\n` +
    `Pending: ${overview.pendingUsers} · Suspended: ${overview.suspendedUsers} · Blocked: ${overview.blockedUsers}` +
    (pageCount > 1 ? ` · page ${safePage + 1}/${pageCount}` : '');
  await renderScreen(
    ctx,
    `${summary}\n\n${lines.length ? lines.join('\n') : 'No user accounts to show.'}`,
    keyboard,
  );
}

export async function showAdminUser(ctx: Context, targetId: number): Promise<void> {
  const actorId = ctx.from?.id;
  const target = getUserById(targetId);
  if (!actorId || !hasPermission(actorId, 'manage_users')) return;
  if (!target) {
    await renderScreen(
      ctx,
      'This user is no longer available.',
      new InlineKeyboard().text('← Users', 'admin:users').text('Admin menu', 'admin:back'),
    );
    return;
  }
  const name =
    [target.firstName, target.lastName].filter(Boolean).join(' ') ||
    target.username ||
    String(targetId);
  const keyboard = new InlineKeyboard();
  if (target.role === 'pending') {
    keyboard
      .text('✅ Approve', `approve:${targetId}`)
      .text('❌ Reject', `reject:${targetId}`)
      .row();
  }
  if (actorId === config.ownerId && target.role === 'user' && target.status === 'active') {
    keyboard.text('⬆️ Promote to admin', `lib:user-action:promote:${targetId}`).row();
  }
  if (actorId === config.ownerId && target.role === 'admin') {
    keyboard
      .text('⬇️ Demote', `lib:user-action:demote:${targetId}`)
      .text('🔑 Permissions', `lib:permissions:${targetId}`)
      .row();
  }
  if (actorId === config.ownerId && target.role !== 'owner' && target.status === 'active') {
    keyboard
      .text('⏸️ Suspend', `lib:user-action:suspend:${targetId}`)
      .text('🚫 Block', `lib:user-action:block:${targetId}`)
      .row();
  } else if (actorId === config.ownerId && ['suspended', 'blocked'].includes(target.status)) {
    keyboard.text('✅ Reactivate', `lib:user-action:unblock:${targetId}`).row();
  }
  keyboard.text('← Users', 'admin:users').text('Admin menu', 'admin:back');
  await renderScreen(ctx, `${name}\nRole: ${target.role} · Status: ${target.status}`, keyboard);
}

export async function showAdminPermissions(ctx: Context, targetId: number): Promise<void> {
  const actorId = ctx.from?.id;
  const target = getUserById(targetId);
  if (actorId !== config.ownerId) return;
  if (!target || target.role !== 'admin') {
    await renderScreen(
      ctx,
      'This admin is no longer available.',
      new InlineKeyboard().text('← Users', 'admin:users'),
    );
    return;
  }
  const keyboard = new InlineKeyboard();
  for (const permission of AVAILABLE_PERMISSIONS) {
    const enabled = target.permissions.includes(permission);
    keyboard
      .text(
        `${enabled ? '✅' : '⬜'} ${permission.replaceAll('_', ' ')}`,
        `lib:permission:${targetId}:${permission}`,
      )
      .row();
  }
  keyboard.text('← User', `lib:user:${targetId}`);
  await renderScreen(
    ctx,
    `🔑 Permissions for ${target.firstName || target.username || targetId}\nTap to toggle a permission.`,
    keyboard,
  );
}

export async function showAuditLogs(ctx: Context, page = 0): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId || !hasPermission(telegramId, 'view_audit_logs')) return;
  const records = index
    .getAudits()
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(records.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const pageRecords = records.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const keyboard = new InlineKeyboard();
  if (safePage > 0) keyboard.text('‹ Previous', `admin:audit:${safePage - 1}`);
  if (safePage + 1 < pageCount) keyboard.text('Next ›', `admin:audit:${safePage + 1}`);
  if (safePage > 0 || safePage + 1 < pageCount) keyboard.row();
  keyboard.text('← Admin menu', 'admin:back');
  const lines = pageRecords.map(
    (record) =>
      `${new Date(record.timestamp).toLocaleString()} · ${record.action} · ${record.targetId}`,
  );
  await renderScreen(
    ctx,
    lines.length
      ? `📋 Recent activity${pageCount > 1 ? ` · page ${safePage + 1}/${pageCount}` : ''}\n\n${lines.join('\n')}`
      : 'No activity recorded yet.',
    keyboard,
  );
}

export function getAdminKeyboard(telegramId: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const canManageUsers = hasPermission(telegramId, 'manage_users');
  const canManageResources =
    hasPermission(telegramId, 'upload_resources') || hasPermission(telegramId, 'delete_resources');
  const canManageFolders = hasPermission(telegramId, 'manage_folders');
  const canDeleteResources = hasPermission(telegramId, 'delete_resources');
  const canViewAudit = hasPermission(telegramId, 'view_audit_logs');

  if (canManageUsers) {
    keyboard.text('👥 Users', 'admin:users').text('⏳ Requests', 'admin:requests').row();
  }
  if (canManageResources) keyboard.text('📄 Resources', 'admin:resources');
  if (canManageFolders) keyboard.text('📁 Folders', 'admin:folders');
  if (canManageResources || canManageFolders) keyboard.row();
  if (canDeleteResources) keyboard.text('🗑️ Recycle Bin', 'admin:recycle');
  if (canViewAudit) keyboard.text('📋 Audit Logs', 'admin:audit');
  if (canDeleteResources || canViewAudit) keyboard.row();
  if (telegramId === config.ownerId) {
    keyboard.text('📊 AI usage overview', 'admin:usage').row();
  }
  keyboard.text('← Store', 'lib:home');
  return keyboard;
}

export async function showPendingRequests(ctx: Context, page = 0): Promise<void> {
  const pending = getPendingRequests();
  const pageSize = 5;
  const pageCount = Math.max(1, Math.ceil(pending.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  if (pending.length === 0) {
    await renderScreen(
      ctx,
      'No pending access requests.',
      new InlineKeyboard().text('← Back', 'admin:back'),
    );
    return;
  }

  const requests = pending.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const keyboard = requests.map((requestedUser) => {
    const name =
      [requestedUser.firstName, requestedUser.lastName].filter(Boolean).join(' ').trim() ||
      requestedUser.username ||
      `ID:${requestedUser.telegramId}`;
    const buttonName = name.replace(/\p{Cc}/gu, ' ').slice(0, 30);
    return [
      { text: `Approve ${buttonName}`, callback_data: `approve:${requestedUser.telegramId}` },
      { text: `Reject ${buttonName}`, callback_data: `reject:${requestedUser.telegramId}` },
    ];
  });
  const inlineKeyboard = new InlineKeyboard();
  for (const row of keyboard)
    inlineKeyboard
      .text(row[0].text, row[0].callback_data)
      .text(row[1].text, row[1].callback_data)
      .row();
  if (safePage > 0) inlineKeyboard.text('‹ Previous', `admin:requests:${safePage - 1}`);
  if (safePage + 1 < pageCount) inlineKeyboard.text('Next ›', `admin:requests:${safePage + 1}`);
  if (safePage > 0 || safePage + 1 < pageCount) inlineKeyboard.row();
  inlineKeyboard.text('← Back', 'admin:back');
  await renderScreen(
    ctx,
    `Pending access requests (${pending.length})${pageCount > 1 ? ` · page ${safePage + 1}/${pageCount}` : ''}`,
    inlineKeyboard,
  );
}
