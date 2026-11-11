import { Bot, Context, InlineKeyboard } from 'grammy';
import { loadConfig } from '../config';
import logger from '../logger';
import { getUserById } from '../services/users';
import {
  createResource,
  createResourceVersion,
  checkDuplicateResource,
} from '../services/resources';
import {
  deleteFile,
  uploadTelegramMedia,
  type TelegramMediaKind,
  formatFileSize,
} from '../telegram/storage';
import { index } from '../telegram/index';
import { hasPermission } from '../services/permissions';
import { canAccessFolder, canAccessResource } from '../services/visibility';
import type { Visibility } from '../models';
import { getAllUsers } from '../services/users';

export type UploadAction =
  { type: 'new'; folderId: string | null } | { type: 'version'; resourceId: string };

// Keep upload destination and version actions scoped to each user.
export const uploadFolderState = new Map<number, string | null>();
export const uploadVersionState = new Map<number, string>();
export const uploadVisibilityState = new Map<number, Visibility>();
export const uploadSetupState = new Map<
  number,
  { folderId: string | null; userIds: Set<number> }
>();
const UPLOAD_CUSTOM_PAGE_SIZE = 8;

export async function promptForUpload(
  ctx: Context,
  telegramId: number,
  action: UploadAction,
): Promise<void> {
  uploadFolderState.delete(telegramId);
  uploadVersionState.delete(telegramId);
  uploadVisibilityState.delete(telegramId);
  uploadSetupState.delete(telegramId);

  if (action.type === 'version') {
    const resource = index.getResource(action.resourceId);
    if (!resource || resource.isDeleted || !canAccessResource(telegramId, resource)) {
      await ctx.reply('That resource is no longer available. Return to MiniStore and try again.', {
        reply_markup: new InlineKeyboard().text('← Store', 'lib:home'),
      });
      return;
    }
    uploadVersionState.set(telegramId, resource.id);
    await ctx.reply(
      `Upload a new version of "${resource.title}". Send the replacement file or media.`,
      { reply_markup: new InlineKeyboard().text('Cancel', 'upload:cancel') },
    );
    return;
  }

  if (action.folderId && !canAccessFolder(telegramId, action.folderId)) {
    await ctx.reply('That folder is no longer available. Return to MiniStore and try again.', {
      reply_markup: new InlineKeyboard().text('← Store', 'lib:home'),
    });
    return;
  }

  uploadSetupState.set(telegramId, { folderId: action.folderId, userIds: new Set() });
  await ctx.reply(
    'Choose who can access the new file. A folder’s rules still apply and may further restrict access.',
    {
      reply_markup: new InlineKeyboard()
        .text('🌐 Public', 'upload:visibility:public')
        .text('🔒 Private', 'upload:visibility:private')
        .row()
        .text('👥 Customize', 'upload:visibility:custom'),
    },
  );
}

function getUploadCustomAccounts() {
  return getAllUsers()
    .filter((user) => user.status === 'active' && (user.role === 'user' || user.role === 'admin'))
    .sort((left, right) =>
      (left.firstName || left.username || '').localeCompare(
        right.firstName || right.username || '',
      ),
    );
}

async function showUploadCustomAccounts(
  ctx: Context,
  telegramId: number,
  page: number,
): Promise<void> {
  const setup = uploadSetupState.get(telegramId);
  if (!setup) {
    await ctx.reply('Upload setup expired. Start again with /upload.');
    return;
  }
  const accounts = getUploadCustomAccounts();
  const pageCount = Math.max(1, Math.ceil(accounts.length / UPLOAD_CUSTOM_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const keyboard = new InlineKeyboard();
  for (const account of accounts.slice(
    safePage * UPLOAD_CUSTOM_PAGE_SIZE,
    (safePage + 1) * UPLOAD_CUSTOM_PAGE_SIZE,
  )) {
    const name =
      [account.firstName, account.lastName].filter(Boolean).join(' ') ||
      account.username ||
      String(account.telegramId);
    keyboard
      .text(
        `${setup.userIds.has(account.telegramId) ? '✅' : '⬜'} ${name}`.slice(0, 55),
        `upload:custom:toggle:${safePage}:${account.telegramId}`,
      )
      .row();
  }
  if (safePage > 0) keyboard.text('‹ Previous', `upload:custom:page:${safePage - 1}`);
  if (safePage + 1 < pageCount) keyboard.text('Next ›', `upload:custom:page:${safePage + 1}`);
  if (safePage > 0 || safePage + 1 < pageCount) keyboard.row();
  keyboard.text('Save selection', 'upload:custom:done').text('Cancel', 'upload:cancel');
  await ctx.editMessageText(
    `Select active approved accounts for the new file. The owner always has access.${pageCount > 1 ? ` · page ${safePage + 1}/${pageCount}` : ''}\nSelected: ${setup.userIds.size}`,
    { reply_markup: keyboard },
  );
}

async function startNewUpload(
  ctx: Context,
  telegramId: number,
  visibility: Visibility,
): Promise<void> {
  const setup = uploadSetupState.get(telegramId);
  if (!setup) {
    await ctx.reply('Upload setup expired. Start again with /upload.');
    return;
  }
  if (setup.folderId && !canAccessFolder(telegramId, setup.folderId)) {
    uploadSetupState.delete(telegramId);
    await ctx.reply('You can no longer access the selected folder. Start again from the store.');
    return;
  }
  uploadFolderState.set(telegramId, setup.folderId);
  uploadVisibilityState.set(telegramId, visibility);
  uploadSetupState.delete(telegramId);
  const folderName = setup.folderId ? index.getFolder(setup.folderId)?.name || 'Unknown' : 'Root';
  await ctx.editMessageText(
    `📤 Upload files to ${folderName} (${visibility.mode}). Send one or more Telegram-supported files or media, then tap Done.`,
    {
      reply_markup: new InlineKeyboard()
        .text('✅ Done', 'upload:finish')
        .text('Cancel', 'upload:cancel'),
    },
  );
}

const config = loadConfig();

export function registerUploadHandlers(bot: Bot<Context>): void {
  bot.callbackQuery(/^upload:(finish|cancel)$/, async (ctx) => {
    const userId = ctx.from.id;
    const action = ctx.match[1];
    uploadFolderState.delete(userId);
    uploadVersionState.delete(userId);
    uploadVisibilityState.delete(userId);
    uploadSetupState.delete(userId);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      action === 'finish' ? '✅ Upload session finished.' : 'Upload session cancelled.',
      { reply_markup: new InlineKeyboard().text('Open store', 'lib:home') },
    );
  });

  bot.callbackQuery(/^upload:visibility:(public|private|custom)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id;
    const setup = uploadSetupState.get(userId);
    if (!setup) return ctx.reply('Upload setup expired. Start again with /upload.');
    const mode = ctx.match[1];
    if (mode === 'custom') return showUploadCustomAccounts(ctx, userId, 0);
    return startNewUpload(
      ctx,
      userId,
      mode === 'public' ? { mode: 'public' } : { mode: 'private' },
    );
  });

  bot.callbackQuery(/^upload:custom:(page|toggle|done)(?::(\d+))?(?::(\d+))?$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id;
    const [, action, first, second] = ctx.match;
    const setup = uploadSetupState.get(userId);
    if (!setup) return ctx.reply('Upload setup expired. Start again with /upload.');
    if (action === 'page') return showUploadCustomAccounts(ctx, userId, Number(first));
    if (action === 'toggle') {
      const page = Number(first);
      const selectedId = Number(second);
      const account = index.getUserByTelegramId(selectedId);
      if (
        !Number.isSafeInteger(page) ||
        !Number.isSafeInteger(selectedId) ||
        !account ||
        account.status !== 'active' ||
        (account.role !== 'user' && account.role !== 'admin')
      ) {
        return ctx.reply('Only active approved accounts can be selected.');
      }
      if (setup.userIds.has(selectedId)) setup.userIds.delete(selectedId);
      else if (setup.userIds.size < 200) setup.userIds.add(selectedId);
      else return ctx.reply('A customized audience can contain at most 200 accounts.');
      return showUploadCustomAccounts(ctx, userId, page);
    }
    if (action === 'done') {
      return startNewUpload(ctx, userId, { mode: 'custom', userIds: [...setup.userIds] });
    }
  });

  // ==================== FILE UPLOAD HANDLER ====================

  interface IncomingTelegramFile {
    mediaKind: TelegramMediaKind;
    fileId: string;
    fileName: string;
    fileSize: number;
    fileType: string;
  }

  function normalizeTelegramFile(
    mediaKind: TelegramMediaKind,
    file: {
      file_id: string;
      file_name?: string;
      file_size?: number;
      mime_type?: string;
    },
    fallbackName: string,
    fallbackType: string,
  ): IncomingTelegramFile {
    return {
      mediaKind,
      fileId: file.file_id,
      fileName: file.file_name || fallbackName,
      fileSize: file.file_size || 0,
      fileType: file.mime_type || fallbackType,
    };
  }

  function getIncomingTelegramFile(
    message: Context['msg'] | undefined,
  ): IncomingTelegramFile | undefined {
    if (!message) return undefined;
    if ('document' in message && message.document) {
      return normalizeTelegramFile(
        'document',
        message.document,
        `file_${message.message_id}`,
        'application/octet-stream',
      );
    }
    if ('photo' in message && message.photo?.length) {
      const photo = message.photo[message.photo.length - 1];
      return normalizeTelegramFile('photo', photo, `photo_${message.message_id}.jpg`, 'image/jpeg');
    }
    if ('video' in message && message.video) {
      return normalizeTelegramFile(
        'video',
        message.video,
        `video_${message.message_id}.mp4`,
        'video/mp4',
      );
    }
    if ('audio' in message && message.audio) {
      return normalizeTelegramFile(
        'audio',
        message.audio,
        `audio_${message.message_id}`,
        'audio/mpeg',
      );
    }
    if ('animation' in message && message.animation) {
      return normalizeTelegramFile(
        'animation',
        message.animation,
        `animation_${message.message_id}.mp4`,
        'video/mp4',
      );
    }
    if ('voice' in message && message.voice) {
      return normalizeTelegramFile(
        'voice',
        message.voice,
        `voice_${message.message_id}.ogg`,
        'audio/ogg',
      );
    }
    if ('video_note' in message && message.video_note) {
      return normalizeTelegramFile(
        'video_note',
        message.video_note,
        `video_note_${message.message_id}.mp4`,
        'video/mp4',
      );
    }
    if ('sticker' in message && message.sticker) {
      const sticker = message.sticker;
      const extension = sticker.is_video ? 'webm' : sticker.is_animated ? 'tgs' : 'webp';
      const mimeType = sticker.is_video
        ? 'video/webm'
        : sticker.is_animated
          ? 'application/x-tgsticker'
          : 'image/webp';
      return normalizeTelegramFile(
        'sticker',
        sticker,
        `sticker_${message.message_id}.${extension}`,
        mimeType,
      );
    }
    return undefined;
  }

  async function handleTelegramFileUpload(ctx: Context): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const existingUser = getUserById(user.id);
    const isOwner = user.id === config.ownerId;
    if (!isOwner && (!existingUser || !hasPermission(user.id, 'upload_resources'))) {
      await ctx.reply('❌ You do not have permission to upload files.');
      return;
    }

    let uploadedFile: Awaited<ReturnType<typeof uploadTelegramMedia>> | undefined;
    let uploadCommitted = false;
    let versionResourceId: string | undefined;
    let uploadVisibility: Visibility | undefined;
    try {
      const file = getIncomingTelegramFile(ctx.msg);
      if (!file) {
        await ctx.reply('❌ Telegram did not provide a usable file. Please try sending it again.');
        return;
      }
      const { fileId, fileName, fileSize, fileType } = file;
      versionResourceId = uploadVersionState.get(user.id);
      const hasUploadSession = uploadFolderState.has(user.id);
      uploadVisibility = uploadVisibilityState.get(user.id);
      if (!versionResourceId && (!hasUploadSession || !uploadVisibility)) {
        await ctx.reply(
          'Start an upload with /upload or the Upload button and choose its visibility first.',
        );
        return;
      }

      if (fileSize > 50 * 1024 * 1024) {
        await ctx.reply('❌ File size exceeds the 50 MB limit.');
        return;
      }

      const duplicate = checkDuplicateResource(fileId);
      if (duplicate) {
        await ctx.reply(`⚠️ This file has already been uploaded as "${duplicate.title}".`);
        return;
      }

      if (versionResourceId) {
        const resource = index.getResource(versionResourceId);
        if (!resource || resource.isDeleted || !canAccessResource(user.id, resource)) {
          uploadVersionState.delete(user.id);
          await ctx.reply(
            'That resource is no longer available. Return to MiniStore and try again.',
          );
          return;
        }
      }

      const selectedFolderId = uploadFolderState.get(user.id) || null;
      if (
        selectedFolderId &&
        (!index.getFolder(selectedFolderId) ||
          index.getFolder(selectedFolderId)?.isDeleted ||
          !canAccessFolder(user.id, selectedFolderId))
      ) {
        uploadFolderState.delete(user.id);
        await ctx.reply(
          'That upload folder is no longer available. Start a new upload from /store.',
        );
        return;
      }
      const targetName = versionResourceId
        ? index.getResource(versionResourceId)?.title || 'existing file'
        : selectedFolderId
          ? index.getFolder(selectedFolderId)?.name || 'selected folder'
          : 'Root';

      await ctx.reply(`📥 Received "${fileName}". Uploading to ${targetName}...`);

      const fileInfo = await uploadTelegramMedia(
        file.mediaKind,
        fileId,
        fileName,
        fileSize,
        fileType,
      );
      uploadedFile = fileInfo;
      if (versionResourceId) {
        const resource = await createResourceVersion(
          versionResourceId,
          {
            fileName: fileInfo.fileName,
            fileType: fileInfo.mimeType,
            fileSize: fileInfo.fileSize || fileSize,
            storageMessageId: fileInfo.messageId,
            storageFileId: fileInfo.fileId,
          },
          user.id,
        );
        uploadCommitted = true;
        uploadVersionState.delete(user.id);
        uploadFolderState.delete(user.id);
        await ctx.reply(`✅ Version ${resource.version} uploaded for "${resource.title}".`);
        return;
      }

      const resource = await createResource(
        fileInfo.fileName || fileName,
        '',
        [],
        fileInfo.mimeType || fileType,
        fileInfo.fileSize || fileSize,
        selectedFolderId,
        fileInfo.messageId,
        fileInfo.fileId,
        user.id,
        fileInfo.fileName || fileName,
        uploadVisibility,
      );
      uploadCommitted = true;

      const folderName = selectedFolderId
        ? index.getFolder(selectedFolderId)?.name || 'Unknown'
        : 'Root';
      await ctx.reply(
        `✅ File uploaded\n\n` +
          `📄 ${resource.fileName || resource.title}\n` +
          `📦 ${formatFileSize(fileInfo.fileSize || fileSize)}\n` +
          `📁 ${folderName}\n` +
          `🆔 ${resource.id}` +
          (hasUploadSession ? '\n\nSend more files or tap Done to finish.' : ''),
        hasUploadSession
          ? {
              reply_markup: new InlineKeyboard()
                .text('✅ Done', 'upload:finish')
                .text('Cancel', 'upload:cancel'),
            }
          : undefined,
      );
    } catch (err) {
      logger.error({ err, userId: user.id, msg: 'Error handling file upload' });
      let linkedResource = false;
      if (uploadedFile && !uploadCommitted) {
        linkedResource = index
          .getResources()
          .some(
            (resource) =>
              resource.storageMessageId === uploadedFile?.messageId ||
              resource.storageFileId === uploadedFile?.fileId ||
              index
                .getResourceVersions(resource.id)
                .some(
                  (version) =>
                    version.storageMessageId === uploadedFile?.messageId ||
                    version.storageFileId === uploadedFile?.fileId,
                ),
          );
        if (!linkedResource && !versionResourceId) {
          try {
            await deleteFile(uploadedFile.messageId);
          } catch (cleanupError) {
            logger.error({
              err: cleanupError,
              userId: user.id,
              messageId: uploadedFile.messageId,
              msg: 'Failed to remove an unregistered upload from the Storage Channel',
            });
          }
        }
      }

      if (uploadCommitted || linkedResource) {
        await ctx.reply(
          '⚠️ The file was saved, but its confirmation could not be completed. Check MiniStore before uploading it again.',
        );
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('already exists')) {
        await ctx.reply(`⚠️ ${message}`);
        return;
      }
      await ctx.reply(`❌ Failed to upload the file: ${message}`);
    }
  }

  /**
   * Handle incoming Telegram files and media as stored documents.
   * The selected destination determines whether this upload creates or versions a resource.
   * Without a pending action, new files are uploaded to root.
   */
  bot.on(
    [
      'message:document',
      'message:photo',
      'message:video',
      'message:audio',
      'message:animation',
      'message:voice',
      'message:video_note',
      'message:sticker',
    ],
    handleTelegramFileUpload,
  );
}
