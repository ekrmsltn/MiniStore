import { Context, InlineKeyboard } from 'grammy';
import { canAccessStore, getUserById } from '../services/users';
import { getResource, getResourceVersions, searchResources } from '../services/resources';
import { formatFileSize } from '../telegram/storage';
import { index } from '../telegram/index';
import { isAssistantConfigured } from '../services/assistant';
import { hasPermission } from '../services/permissions';
import { textActionState, type TextAction } from './state';
import { addBackButton, isAdminUser, renderScreen } from './screens/shared';

type BrowseSort = 'name' | 'recent';

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
export {
  showAdminResources,
  showAdminFolders,
  showAdminFolder,
  showRecycleBin,
  showAdminUsers,
  showAssistantUsageOverview,
  showAdminUser,
  showAdminPermissions,
  showAuditLogs,
  getAdminKeyboard,
  showPendingRequests,
} from './screens/admin';
export {
  isAdminUser,
  addBackButton,
  resourceIdFromToken,
  folderIdFromToken,
  renderScreen,
} from './screens/shared';
