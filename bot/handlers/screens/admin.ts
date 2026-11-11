import { Context, InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config';
import { getUserById, getAllUsers, getPendingRequests } from '../../services/users';
import { getAllResources, getDeletedResources } from '../../services/resources';
import { getDeletedFolders } from '../../services/folders';
import { getAssistantUsageOverview } from '../../services/assistant';
import { AVAILABLE_PERMISSIONS, hasPermission } from '../../services/permissions';
import { canAccessFolder, canAccessResource } from '../../services/visibility';
import { index } from '../../telegram/index';
import { isAdminUser, renderScreen } from './shared';

const config = loadConfig();

export async function showAdminResources(ctx: Context, page = 0): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId || !isAdminUser(telegramId)) return;
  const resources = getAllResources().filter((resource) => canAccessResource(telegramId, resource));
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(resources.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const keyboard = new InlineKeyboard();
  for (const resource of resources.slice(safePage * pageSize, (safePage + 1) * pageSize)) {
    keyboard
      .text(
        `📄 ${resource.title}`.slice(0, 60),
        `lib:resource:${resource.id.slice('resource:'.length)}|admin:resources:${safePage}`,
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
  const folders = index
    .getFolders()
    .filter((folder) => !folder.isDeleted && canAccessFolder(telegramId, folder.id));
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
  if (
    !telegramId ||
    !hasPermission(telegramId, 'manage_folders') ||
    !folder ||
    folder.isDeleted ||
    !canAccessFolder(telegramId, folderId)
  ) {
    await renderScreen(
      ctx,
      'This folder is unavailable.',
      new InlineKeyboard().text('← Folders', 'admin:folders'),
    );
    return;
  }
  const children = index
    .getChildFolders(folderId)
    .filter((child) => canAccessFolder(telegramId, child.id));
  const resources = index
    .getResources()
    .filter(
      (resource) =>
        resource.folderId === folderId &&
        !resource.isDeleted &&
        canAccessResource(telegramId, resource),
    );
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
  if (folder.parentId && canAccessFolder(telegramId, folder.parentId)) {
    keyboard.row().text('← Parent folder', `lib:folder:${folder.parentId.slice('folder:'.length)}`);
  }
  keyboard.row().text('← Folders', 'admin:folders').text('Admin menu', 'admin:back');
  keyboard
    .row()
    .text(
      `🔐 Visibility: ${folder.visibility?.mode ?? 'inherit'}`,
      `visibility:open:folder:${folder.id.slice('folder:'.length)}`,
    );
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
    (resource) =>
      (!resource.folderId || !index.getFolder(resource.folderId)?.isDeleted) &&
      canAccessResource(telegramId, resource),
  );
  const folders = hasPermission(telegramId, 'manage_folders')
    ? getDeletedFolders().filter((folder) => canAccessFolder(telegramId, folder.id))
    : [];
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
