import { Bot, Context, InlineKeyboard } from 'grammy';
import { loadConfig } from '../config';
import logger from '../logger';
import {
  getUserById,
  canAccessStore,
  approveUser,
  rejectUser,
  promoteUser,
  demoteUser,
  updateUserPermissions,
  suspendUser,
  blockUser,
  unblockUser,
  addFavorite,
  removeFavorite,
} from '../services/users';
import {
  deleteResource,
  getResource,
  getResourceVersion,
  trackDownload,
  restoreResource,
  permanentDeleteResource,
} from '../services/resources';
import {
  deleteFolder,
  moveFolder,
  permanentDeleteFolder,
  restoreFolder,
} from '../services/folders';
import { notifyUserOfAccessDecision } from '../services/notifications';
import { AVAILABLE_PERMISSIONS, hasPermission } from '../services/permissions';
import { index } from '../telegram/index';
import { textActionState } from './state';
import { promptForUpload } from './uploads';
import {
  folderIdFromToken,
  getAdminKeyboard,
  isAdminUser,
  promptForText,
  renderScreen,
  resourceIdFromToken,
  showAdminFolder,
  showAdminFolders,
  showAdminPermissions,
  showAdminResources,
  showAdminUser,
  showAdminUsers,
  showAssistantUsageOverview,
  showAuditLogs,
  showBrowse,
  showFavorites,
  showHome,
  showPendingRequests,
  showRecycleBin,
  showResource,
} from './screens';

const config = loadConfig();

export function registerCallbackHandlers(bot: Bot<Context>): void {
  /**
   * Inline store and admin actions.
   */
  bot.on('callback_query:data', async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    const user = ctx.from;
    if (!user) return next();

    const isLibraryAction = data.startsWith('lib:');
    const isAdminLibraryAction =
      data === 'admin:home' ||
      data === 'admin:requests' ||
      data.startsWith('admin:requests:') ||
      data === 'admin:resources' ||
      data.startsWith('admin:resources:') ||
      data === 'admin:folders' ||
      data.startsWith('admin:folders:') ||
      data === 'admin:recycle' ||
      data.startsWith('admin:recycle:') ||
      data === 'admin:audit' ||
      data.startsWith('admin:audit:') ||
      data === 'admin:usage' ||
      data.startsWith('admin:usage:') ||
      data === 'admin:users' ||
      data.startsWith('admin:users:');
    if (!isLibraryAction && !isAdminLibraryAction) return next();

    await ctx.answerCallbackQuery();

    if (isAdminLibraryAction && !isAdminUser(user.id)) {
      await ctx.reply('❌ You do not have permission to use admin tools.');
      return;
    }
    if (isLibraryAction && !canAccessStore(user.id) && data !== 'lib:noop') {
      await ctx.reply('❌ Your account does not have access to MiniStore.');
      return;
    }

    if (data === 'lib:noop') return;
    if (data === 'lib:home') return showHome(ctx);
    if (data === 'lib:browse:root') return showBrowse(ctx, null);
    if (data === 'lib:search') {
      return promptForText(ctx, { type: 'search' }, 'Send a search phrase to find files.');
    }
    if (data === 'lib:favorites') return showFavorites(ctx);
    if (data === 'lib:profile') {
      const account = getUserById(user.id);
      const displayName =
        [account?.firstName, account?.lastName].filter(Boolean).join(' ') ||
        account?.username ||
        String(user.id);
      const keyboard = new InlineKeyboard()
        .text('📂 Browse files', 'lib:browse:root')
        .text('⭐ Favorites', 'lib:favorites')
        .row();
      if (isAdminUser(user.id)) {
        keyboard.text('⚙️ Admin tools', 'admin:home').text('← Menu', 'lib:home');
      } else {
        keyboard.text('← Menu', 'lib:home');
      }
      return renderScreen(
        ctx,
        `${displayName}\nRole: ${account?.role || (user.id === config.ownerId ? 'owner' : 'user')}\nStatus: ${account?.status || 'active'}\nTelegram ID: ${user.id}`,
        keyboard,
      );
    }

    if (data.startsWith('lib:browse:')) {
      const target = data.slice('lib:browse:'.length);
      return showBrowse(ctx, target === 'root' ? null : folderIdFromToken(target));
    }
    if (data.startsWith('lib:page:')) {
      const [, , target, pageText, sortText] = data.split(':');
      return showBrowse(
        ctx,
        target === 'root' ? null : folderIdFromToken(target),
        Number(pageText || 0),
        sortText === 'recent' ? 'recent' : 'name',
      );
    }
    if (data.startsWith('lib:sort:')) {
      const [, , target, sortText] = data.split(':');
      return showBrowse(
        ctx,
        target === 'root' ? null : folderIdFromToken(target),
        0,
        sortText === 'recent' ? 'recent' : 'name',
      );
    }
    if (data.startsWith('lib:resource:')) {
      return showResource(ctx, resourceIdFromToken(data.slice('lib:resource:'.length)));
    }
    if (data.startsWith('lib:download:')) {
      const resourceId = resourceIdFromToken(data.slice('lib:download:'.length));
      const resource = getResource(resourceId);
      if (!resource || resource.isDeleted || !ctx.chat) {
        return renderScreen(
          ctx,
          'This file is unavailable.',
          new InlineKeyboard().text('← Menu', 'lib:home'),
        );
      }
      await ctx.api.copyMessage(ctx.chat.id, config.storageChannelId, resource.storageMessageId);
      await trackDownload(resource.id);
      return;
    }
    if (data.startsWith('lib:download-version:')) {
      const [, , resourceToken, versionText] = data.split(':');
      const resourceId = resourceIdFromToken(resourceToken);
      const resource = getResource(resourceId);
      const versionNumber = Number(versionText);
      const version = Number.isSafeInteger(versionNumber)
        ? getResourceVersion(resourceId, versionNumber)
        : undefined;
      if (!resource || resource.isDeleted || !version || !ctx.chat) {
        return ctx.reply('This file version is unavailable.', {
          reply_markup: new InlineKeyboard().text(
            '← File details',
            `lib:resource:${resourceId.slice('resource:'.length)}`,
          ),
        });
      }
      await ctx.api.copyMessage(ctx.chat.id, config.storageChannelId, version.storageMessageId);
      await trackDownload(resource.id);
      return;
    }
    if (data.startsWith('lib:version-page:')) {
      const [, , resourceToken, pageText] = data.split(':');
      return showResource(
        ctx,
        resourceIdFromToken(resourceToken),
        undefined,
        Number(pageText || 0),
      );
    }
    if (data.startsWith('lib:favorite:')) {
      const resourceId = resourceIdFromToken(data.slice('lib:favorite:'.length));
      const isFavorite = getUserById(user.id)?.favorites.includes(resourceId) ?? false;
      if (isFavorite) await removeFavorite(user.id, resourceId);
      else await addFavorite(user.id, resourceId);
      return showResource(ctx, resourceId);
    }
    if (data.startsWith('lib:upload:')) {
      const target = data.slice('lib:upload:'.length);
      if (!hasPermission(user.id, 'upload_resources'))
        return ctx.reply('You do not have permission to upload files.');
      return promptForUpload(ctx, user.id, {
        type: 'new',
        folderId: target === 'root' ? null : folderIdFromToken(target),
      });
    }
    if (data.startsWith('lib:version:')) {
      if (!hasPermission(user.id, 'upload_resources'))
        return ctx.reply('You do not have permission to upload versions.');
      const resourceId = resourceIdFromToken(data.slice('lib:version:'.length));
      return promptForUpload(ctx, user.id, { type: 'version', resourceId });
    }
    if (data.startsWith('lib:folder-create:')) {
      if (!hasPermission(user.id, 'manage_folders'))
        return ctx.reply('You do not have permission to manage folders.');
      const target = data.slice('lib:folder-create:'.length);
      return promptForText(
        ctx,
        { type: 'folder-create', parentId: target === 'root' ? null : folderIdFromToken(target) },
        'Send the new folder name.',
      );
    }
    if (data.startsWith('lib:folder-rename:')) {
      if (!hasPermission(user.id, 'manage_folders'))
        return ctx.reply('You do not have permission to manage folders.');
      const folderId = folderIdFromToken(data.slice('lib:folder-rename:'.length));
      const folder = index.getFolder(folderId);
      if (!folder || folder.isDeleted) return ctx.reply('That folder is no longer available.');
      return promptForText(
        ctx,
        { type: 'folder-rename', folderId },
        `Send a new name for "${folder.name}".`,
      );
    }
    if (data.startsWith('lib:folder:')) {
      return showAdminFolder(ctx, folderIdFromToken(data.slice('lib:folder:'.length)));
    }
    if (data.startsWith('lib:folder-move:')) {
      const folderId = folderIdFromToken(data.slice('lib:folder-move:'.length));
      const folder = index.getFolder(folderId);
      if (!folder || folder.isDeleted || !hasPermission(user.id, 'manage_folders')) return;
      const folderToken = folder.id.slice('folder:'.length);
      const keyboard = new InlineKeyboard()
        .text('Root', `lib:folder-move-to:${folderToken}|root`)
        .row();
      for (const target of index
        .getFolders()
        .filter((item) => !item.isDeleted && item.id !== folderId)
        .slice(0, 20)) {
        keyboard
          .text(
            `📁 ${target.name}`.slice(0, 50),
            `lib:folder-move-to:${folderToken}|${target.id.slice('folder:'.length)}`,
          )
          .row();
      }
      keyboard.text('Cancel', `lib:folder:${folderToken}`);
      return renderScreen(ctx, `Move "${folder.name}" to:`, keyboard);
    }
    if (data.startsWith('lib:folder-move-to:')) {
      if (!hasPermission(user.id, 'manage_folders'))
        return ctx.reply('You do not have permission to move folders.');
      const [folderId, target] = data.slice('lib:folder-move-to:'.length).split('|');
      if (!folderId || !target) return;
      await moveFolder(
        folderIdFromToken(folderId),
        target === 'root' ? null : folderIdFromToken(target),
        user.id,
      );
      return showAdminFolder(ctx, folderIdFromToken(folderId));
    }
    if (data.startsWith('lib:folder-delete:')) {
      if (
        !hasPermission(user.id, 'manage_folders') ||
        !hasPermission(user.id, 'delete_resources')
      ) {
        return ctx.reply('You do not have permission to delete folders.');
      }
      const folderId = folderIdFromToken(data.slice('lib:folder-delete:'.length));
      const folder = index.getFolder(folderId);
      if (!folder || folder.isDeleted) return;
      const keyboard = new InlineKeyboard()
        .text('Confirm delete', `lib:folder-delete-confirm:${folderId}`)
        .text('Cancel', `lib:folder:${folderId}`);
      return renderScreen(
        ctx,
        `Move "${folder.name}" and its contents to the recycle bin?`,
        keyboard,
      );
    }
    if (data.startsWith('lib:folder-delete-confirm:')) {
      if (
        !hasPermission(user.id, 'manage_folders') ||
        !hasPermission(user.id, 'delete_resources')
      ) {
        return ctx.reply('You do not have permission to delete folders.');
      }
      const folderId = folderIdFromToken(data.slice('lib:folder-delete-confirm:'.length));
      await deleteFolder(folderId, user.id);
      return showAdminFolders(ctx);
    }
    if (data.startsWith('lib:resource-rename:')) {
      if (!hasPermission(user.id, 'upload_resources'))
        return ctx.reply('You do not have permission to edit files.');
      const resourceId = resourceIdFromToken(data.slice('lib:resource-rename:'.length));
      const resource = getResource(resourceId);
      if (!resource || resource.isDeleted) return;
      return promptForText(
        ctx,
        { type: 'resource-rename', resourceId },
        `Send a new title for "${resource.title}".`,
      );
    }
    if (data.startsWith('lib:resource-edit:')) {
      if (!hasPermission(user.id, 'upload_resources')) {
        return ctx.reply('You do not have permission to edit file metadata.');
      }
      const resourceId = resourceIdFromToken(data.slice('lib:resource-edit:'.length));
      const resource = getResource(resourceId);
      if (!resource || resource.isDeleted) {
        return ctx.reply('That file is no longer available.', {
          reply_markup: new InlineKeyboard().text('← Resources', 'admin:resources'),
        });
      }
      const token = resource.id.slice('resource:'.length);
      const keyboard = new InlineKeyboard()
        .text('Title', `lib:resource-rename:${token}`)
        .text('Description', `lib:resource-description:${token}`)
        .row()
        .text('Tags', `lib:resource-tags:${token}`)
        .text('Category', `lib:resource-category:${token}`)
        .row()
        .text('← File details', `lib:resource:${token}`);
      return renderScreen(ctx, `Edit metadata for "${resource.title}"`, keyboard);
    }
    if (data.startsWith('lib:resource-description:')) {
      if (!hasPermission(user.id, 'upload_resources')) {
        return ctx.reply('You do not have permission to edit file metadata.');
      }
      const resourceId = resourceIdFromToken(data.slice('lib:resource-description:'.length));
      return promptForText(
        ctx,
        { type: 'resource-description', resourceId },
        'Send a description (up to 4000 characters), or send - to clear it.',
      );
    }
    if (data.startsWith('lib:resource-tags:')) {
      if (!hasPermission(user.id, 'upload_resources')) {
        return ctx.reply('You do not have permission to edit file metadata.');
      }
      const resourceId = resourceIdFromToken(data.slice('lib:resource-tags:'.length));
      return promptForText(
        ctx,
        { type: 'resource-tags', resourceId },
        'Send comma-separated tags (up to 20, each up to 100 characters), or send - to clear them.',
      );
    }
    if (data.startsWith('lib:resource-category:')) {
      if (!hasPermission(user.id, 'upload_resources')) {
        return ctx.reply('You do not have permission to edit file metadata.');
      }
      const resourceId = resourceIdFromToken(data.slice('lib:resource-category:'.length));
      return promptForText(
        ctx,
        { type: 'resource-category', resourceId },
        'Send a category label (up to 100 characters), or send - to clear it.',
      );
    }
    if (data.startsWith('lib:resource-delete:')) {
      if (!hasPermission(user.id, 'delete_resources'))
        return ctx.reply('You do not have permission to delete files.');
      const resourceId = resourceIdFromToken(data.slice('lib:resource-delete:'.length));
      const resource = getResource(resourceId);
      if (!resource || resource.isDeleted) return;
      const keyboard = new InlineKeyboard()
        .text(
          'Confirm delete',
          `lib:resource-delete-confirm:${resourceId.slice('resource:'.length)}`,
        )
        .text('Cancel', `lib:resource:${resourceId}`);
      return renderScreen(ctx, `Move "${resource.title}" to the recycle bin?`, keyboard);
    }
    if (data.startsWith('lib:resource-delete-confirm:')) {
      if (!hasPermission(user.id, 'delete_resources'))
        return ctx.reply('You do not have permission to delete files.');
      const resourceId = resourceIdFromToken(data.slice('lib:resource-delete-confirm:'.length));
      await deleteResource(resourceId, user.id);
      return showAdminResources(ctx);
    }
    if (data.startsWith('lib:trash-resource:')) {
      if (!hasPermission(user.id, 'delete_resources'))
        return ctx.reply('You do not have permission to manage the recycle bin.');
      const resourceId = resourceIdFromToken(data.slice('lib:trash-resource:'.length));
      const resource = getResource(resourceId);
      if (!resource?.isDeleted) return;
      const keyboard = new InlineKeyboard()
        .text('♻️ Restore', `lib:restore-resource:${resourceId.slice('resource:'.length)}`)
        .text('Delete permanently', `lib:purge-resource:${resourceId.slice('resource:'.length)}`)
        .row()
        .text('← Recycle bin', 'admin:recycle');
      return renderScreen(
        ctx,
        `📄 ${resource.title}\nDeleted ${resource.deletedAt || ''}`,
        keyboard,
      );
    }
    if (data.startsWith('lib:restore-resource:')) {
      if (!hasPermission(user.id, 'delete_resources'))
        return ctx.reply('You do not have permission to restore files.');
      const resourceId = resourceIdFromToken(data.slice('lib:restore-resource:'.length));
      await restoreResource(resourceId, user.id);
      return showRecycleBin(ctx);
    }
    if (data.startsWith('lib:purge-resource:')) {
      if (!hasPermission(user.id, 'delete_resources'))
        return ctx.reply('You do not have permission to permanently delete files.');
      const resourceId = resourceIdFromToken(data.slice('lib:purge-resource:'.length));
      const keyboard = new InlineKeyboard()
        .text(
          'Confirm permanent delete',
          `lib:purge-resource-confirm:${resourceId.slice('resource:'.length)}`,
        )
        .row()
        .text('Cancel', `lib:trash-resource:${resourceId.slice('resource:'.length)}`);
      return renderScreen(
        ctx,
        'Permanently delete this file and its versions? This cannot be undone.',
        keyboard,
      );
    }
    if (data.startsWith('lib:purge-resource-confirm:')) {
      if (!hasPermission(user.id, 'delete_resources'))
        return ctx.reply('You do not have permission to permanently delete files.');
      const resourceId = resourceIdFromToken(data.slice('lib:purge-resource-confirm:'.length));
      await permanentDeleteResource(resourceId, user.id);
      return showRecycleBin(ctx);
    }
    if (data.startsWith('lib:trash-folder:')) {
      if (
        !hasPermission(user.id, 'delete_resources') ||
        !hasPermission(user.id, 'manage_folders')
      ) {
        return ctx.reply('You do not have permission to manage deleted folders.');
      }
      const folderId = folderIdFromToken(data.slice('lib:trash-folder:'.length));
      const folder = index.getFolder(folderId);
      if (!folder?.isDeleted) return;
      const keyboard = new InlineKeyboard()
        .text('♻️ Restore tree', `lib:restore-folder:${folderId.slice('folder:'.length)}`)
        .text('Delete permanently', `lib:purge-folder:${folderId.slice('folder:'.length)}`)
        .row()
        .text('← Recycle bin', 'admin:recycle');
      return renderScreen(ctx, `📁 ${folder.name}\nDeleted ${folder.deletedAt || ''}`, keyboard);
    }
    if (data.startsWith('lib:restore-folder:')) {
      if (
        !hasPermission(user.id, 'delete_resources') ||
        !hasPermission(user.id, 'manage_folders')
      ) {
        return ctx.reply('You do not have permission to restore folders.');
      }
      const folderId = folderIdFromToken(data.slice('lib:restore-folder:'.length));
      await restoreFolder(folderId, user.id);
      return showRecycleBin(ctx);
    }
    if (data.startsWith('lib:purge-folder:')) {
      if (
        !hasPermission(user.id, 'delete_resources') ||
        !hasPermission(user.id, 'manage_folders')
      ) {
        return ctx.reply('You do not have permission to permanently delete folders.');
      }
      const folderId = folderIdFromToken(data.slice('lib:purge-folder:'.length));
      const keyboard = new InlineKeyboard()
        .text(
          'Confirm permanent delete',
          `lib:purge-folder-confirm:${folderId.slice('folder:'.length)}`,
        )
        .row()
        .text('Cancel', `lib:trash-folder:${folderId.slice('folder:'.length)}`);
      return renderScreen(
        ctx,
        'Permanently delete this folder tree and all files in it? This cannot be undone.',
        keyboard,
      );
    }
    if (data.startsWith('lib:purge-folder-confirm:')) {
      if (
        !hasPermission(user.id, 'delete_resources') ||
        !hasPermission(user.id, 'manage_folders')
      ) {
        return ctx.reply('You do not have permission to permanently delete folders.');
      }
      const folderId = folderIdFromToken(data.slice('lib:purge-folder-confirm:'.length));
      await permanentDeleteFolder(folderId, user.id);
      return showRecycleBin(ctx);
    }
    if (data.startsWith('lib:user:')) {
      if (!hasPermission(user.id, 'manage_users'))
        return ctx.reply('You do not have permission to manage users.');
      return showAdminUser(ctx, Number(data.slice('lib:user:'.length)));
    }
    if (data.startsWith('lib:user-action:')) {
      const [, , action, targetValue] = data.split(':');
      const targetId = Number(targetValue);
      if (!Number.isSafeInteger(targetId)) return;
      if (user.id !== config.ownerId) return ctx.reply('Only the owner can change user roles.');
      if (action === 'promote') await promoteUser(targetId, 'admin', user.id);
      else if (action === 'demote') await demoteUser(targetId, 'user', user.id);
      else if (action === 'suspend') await suspendUser(targetId, user.id);
      else if (action === 'block') await blockUser(targetId, user.id);
      else if (action === 'unblock') await unblockUser(targetId, user.id);
      return showAdminUser(ctx, targetId);
    }
    if (data.startsWith('lib:permissions:')) {
      if (user.id !== config.ownerId)
        return ctx.reply('Only the owner can manage admin permissions.');
      return showAdminPermissions(ctx, Number(data.slice('lib:permissions:'.length)));
    }
    if (data.startsWith('lib:permission:')) {
      const [, , targetValue, permission] = data.split(':');
      const targetId = Number(targetValue);
      const target = getUserById(targetId);
      if (
        user.id !== config.ownerId ||
        !target ||
        !AVAILABLE_PERMISSIONS.includes(permission as (typeof AVAILABLE_PERMISSIONS)[number])
      )
        return;
      const permissions = target.permissions.includes(permission)
        ? target.permissions.filter((item) => item !== permission)
        : [...target.permissions, permission];
      await updateUserPermissions(targetId, permissions, user.id);
      return showAdminPermissions(ctx, targetId);
    }
    if (data === 'lib:cancel') {
      textActionState.delete(user.id);
      return showHome(ctx);
    }

    if (data === 'admin:home') {
      return renderScreen(ctx, '🔧 Admin tools — choose a section:', getAdminKeyboard(user.id));
    }
    if (data === 'admin:requests' || data.startsWith('admin:requests:')) {
      const page = Number(data.split(':')[2] || 0);
      if (!hasPermission(user.id, 'manage_users')) {
        return ctx.reply('You do not have permission to manage access requests.');
      }
      return showPendingRequests(ctx, page);
    }
    if (data === 'admin:resources' || data.startsWith('admin:resources:')) {
      const page = Number(data.split(':')[2] || 0);
      if (
        !hasPermission(user.id, 'upload_resources') &&
        !hasPermission(user.id, 'delete_resources')
      ) {
        return ctx.reply('You do not have permission to manage resources.');
      }
      return showAdminResources(ctx, page);
    }
    if (data === 'admin:folders' || data.startsWith('admin:folders:')) {
      const page = Number(data.split(':')[2] || 0);
      if (!hasPermission(user.id, 'manage_folders'))
        return ctx.reply('You do not have permission to manage folders.');
      return showAdminFolders(ctx, page);
    }
    if (data === 'admin:recycle' || data.startsWith('admin:recycle:')) {
      const page = Number(data.split(':')[2] || 0);
      return showRecycleBin(ctx, page);
    }
    if (data === 'admin:audit' || data.startsWith('admin:audit:')) {
      const page = Number(data.split(':')[2] || 0);
      return showAuditLogs(ctx, page);
    }
    if (data === 'admin:users' || data.startsWith('admin:users:')) {
      const page = Number(data.split(':')[2] || 0);
      return showAdminUsers(ctx, page);
    }
    if (data === 'admin:usage' || data.startsWith('admin:usage:')) {
      const page = Number(data.split(':')[2] || 0);
      return showAssistantUsageOverview(ctx, page);
    }
    return next();
  });

  /**
   * Callback query handler for admin actions.
   */
  bot.on('callback_query:data', async (ctx) => {
    const callbackData = ctx.callbackQuery.data;
    const user = ctx.from;
    await ctx.answerCallbackQuery();

    if (callbackData.startsWith('approve:') || callbackData.startsWith('reject:')) {
      if (!isAdminUser(user.id) || !hasPermission(user.id, 'manage_users')) {
        return ctx.reply('❌ You do not have permission to manage access requests.');
      }
      const approved = callbackData.startsWith('approve:');
      const telegramId = Number(callbackData.substring(approved ? 8 : 7));
      if (!Number.isSafeInteger(telegramId) || telegramId <= 0) {
        return ctx.reply('Invalid access request.');
      }

      let updated;
      try {
        updated = approved
          ? await approveUser(telegramId, user.id)
          : await rejectUser(telegramId, user.id);
      } catch (err) {
        logger.warn({ err, actorId: user.id, targetId: telegramId, msg: 'Access decision failed' });
        await ctx.reply(`Could not process this request: ${(err as Error).message}`);
        return;
      }

      const notified = await notifyUserOfAccessDecision(updated, approved);
      const decisionMessage =
        `${approved ? 'Approved' : 'Rejected'} access for ${updated.firstName || updated.username || telegramId}.` +
        (notified
          ? ' The user was notified.'
          : ' The decision was saved, but the user could not be notified.');
      try {
        await ctx.editMessageText(decisionMessage, {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'View remaining requests', callback_data: 'admin:requests' }],
            ],
          },
        });
      } catch (err) {
        logger.warn({
          err,
          actorId: user.id,
          targetId: telegramId,
          msg: 'Could not update access notification message',
        });
        await ctx.reply(decisionMessage);
      }
      return;
    }

    if (callbackData === 'admin:back') {
      if (!isAdminUser(user.id)) {
        return ctx.reply('❌ You do not have permission to use admin tools.');
      }
      return ctx.editMessageText('🔧 *Admin Dashboard*\n\nSelect an action below:', {
        parse_mode: 'Markdown',
        reply_markup: getAdminKeyboard(user.id),
      });
    }
  });
}
