/**
 * Storage Channel operations.
 * Handles uploading, downloading, and managing files
 * in the private Storage Channel.
 */

import { Api, InputFile } from 'grammy';
import { loadConfig } from '../config';
import logger from '../logger';
import { TelegramApiError } from '../errors';
import {
  checkChannelReadAccess,
  getChannelMessage,
  getMtprotoClient,
  hasChannelMessage,
} from './mtproto';
import { assertBotCanPostInChannel } from './channel-access';

const config = loadConfig();
const api = new Api(config.botToken);

/**
 * Maximum file size for bot uploads (50 MB without local server).
 */
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;

export interface FileInfo {
  messageId: number;
  fileId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
}

export type TelegramMediaKind =
  'document' | 'photo' | 'video' | 'audio' | 'animation' | 'voice' | 'video_note' | 'sticker';

interface TelegramStoredMedia {
  file_id: string;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
}

function createFileInfo(
  messageId: number,
  media: TelegramStoredMedia,
  fileName: string,
  mimeType: string,
): FileInfo {
  if (!Number.isSafeInteger(messageId) || messageId <= 0 || !media.file_id) {
    throw new TelegramApiError('Telegram response did not include valid stored-file details');
  }
  return {
    messageId,
    fileId: media.file_id,
    fileName: media.file_name || fileName,
    fileSize: media.file_size || 0,
    mimeType: media.mime_type || mimeType,
  };
}

/**
 * Upload a file to the Storage Channel.
 * Accepts an InputFile and stores it as a document. Existing Telegram media
 * file IDs must use uploadTelegramMedia so their media type is preserved.
 * Returns file info including message ID and file ID.
 */
export async function uploadFile(
  file: InputFile,
  fileName: string,
  fileSize: number = 0,
  description?: string,
): Promise<FileInfo> {
  // Validate file size
  if (!Number.isSafeInteger(fileSize) || fileSize < 0 || fileSize > MAX_UPLOAD_SIZE) {
    throw new Error(`File size must be an integer between 0 and ${MAX_UPLOAD_SIZE} bytes.`);
  }

  try {
    const msg = await api.sendDocument(config.storageChannelId, file, {
      caption: (description || fileName).slice(0, 1024),
      disable_notification: true,
    });

    if (!msg.document) {
      throw new TelegramApiError('Uploaded message has no document');
    }

    const fileInfo = createFileInfo(
      msg.message_id,
      msg.document,
      fileName,
      'application/octet-stream',
    );

    logger.info({
      messageId: fileInfo.messageId,
      fileName: fileInfo.fileName,
      fileSize: fileInfo.fileSize,
      msg: 'File uploaded to Storage Channel',
    });

    return fileInfo;
  } catch (err) {
    logger.error({ err, fileName, msg: 'Failed to upload file to Storage Channel' });
    if (err instanceof TelegramApiError) throw err;
    throw new TelegramApiError(
      `Failed to upload file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Store Telegram media without changing its media type. A photo file_id, for
 * example, must be sent with sendPhoto rather than sendDocument.
 */
export async function uploadTelegramMedia(
  mediaKind: TelegramMediaKind,
  fileId: string,
  fileName: string,
  fileSize = 0,
  mimeType = 'application/octet-stream',
  caption = fileName,
): Promise<FileInfo> {
  if (
    !fileId ||
    !fileName.trim() ||
    !Number.isSafeInteger(fileSize) ||
    fileSize < 0 ||
    fileSize > MAX_UPLOAD_SIZE
  ) {
    throw new Error(`File metadata is invalid or the file size exceeds ${MAX_UPLOAD_SIZE} bytes.`);
  }

  try {
    let messageId: number;
    let media: TelegramStoredMedia | undefined;
    switch (mediaKind) {
      case 'document': {
        const message = await api.sendDocument(config.storageChannelId, fileId, {
          caption: caption.slice(0, 1024),
          disable_notification: true,
        });
        messageId = message.message_id;
        media = message.document;
        break;
      }
      case 'photo': {
        const message = await api.sendPhoto(config.storageChannelId, fileId, {
          caption: caption.slice(0, 1024),
          disable_notification: true,
        });
        messageId = message.message_id;
        media = message.photo[message.photo.length - 1];
        break;
      }
      case 'video': {
        const message = await api.sendVideo(config.storageChannelId, fileId, {
          caption: caption.slice(0, 1024),
          disable_notification: true,
        });
        messageId = message.message_id;
        media = message.video;
        break;
      }
      case 'audio': {
        const message = await api.sendAudio(config.storageChannelId, fileId, {
          caption: caption.slice(0, 1024),
          disable_notification: true,
        });
        messageId = message.message_id;
        media = message.audio;
        break;
      }
      case 'animation': {
        const message = await api.sendAnimation(config.storageChannelId, fileId, {
          caption: caption.slice(0, 1024),
          disable_notification: true,
        });
        messageId = message.message_id;
        media = message.animation;
        break;
      }
      case 'voice': {
        const message = await api.sendVoice(config.storageChannelId, fileId, {
          caption: caption.slice(0, 1024),
          disable_notification: true,
        });
        messageId = message.message_id;
        media = message.voice;
        break;
      }
      case 'video_note': {
        const message = await api.sendVideoNote(config.storageChannelId, fileId, {
          disable_notification: true,
        });
        messageId = message.message_id;
        media = message.video_note;
        break;
      }
      case 'sticker': {
        const message = await api.sendSticker(config.storageChannelId, fileId, {
          disable_notification: true,
        });
        messageId = message.message_id;
        media = message.sticker;
        break;
      }
    }

    if (!media) {
      throw new TelegramApiError(`Telegram did not return ${mediaKind} media after upload`);
    }
    const fileInfo = createFileInfo(messageId, media, fileName, mimeType);
    logger.info({
      messageId,
      mediaKind,
      fileName: fileInfo.fileName,
      fileSize: fileInfo.fileSize,
      msg: 'Telegram media uploaded to Storage Channel',
    });
    return fileInfo;
  } catch (err) {
    logger.error({
      err,
      fileName,
      mediaKind,
      msg: 'Failed to upload Telegram media to Storage Channel',
    });
    if (err instanceof TelegramApiError) throw err;
    throw new TelegramApiError(
      `Failed to upload file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Download a file from the Storage Channel. Use the Bot API when it supports
 * the file size, then fall back to MTProto for larger files.
 */
export async function downloadFile(fileId: string, messageId: number): Promise<Buffer> {
  let botApiError: unknown;

  try {
    const file = await api.getFile(fileId);
    if (!file.file_path) {
      throw new TelegramApiError('Bot API did not return a file path');
    }

    const response = await fetch(
      `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!response.ok) {
      throw new TelegramApiError(`Bot API file download failed: HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    logger.info({ messageId, size: buffer.length, msg: 'File downloaded with Bot API' });
    return buffer;
  } catch (error) {
    botApiError = error;
    logger.warn({
      err: error,
      messageId,
      msg: 'Bot API download failed; trying the authenticated channel reader',
    });
  }

  try {
    const message = await getChannelMessage(config.storageChannelId, messageId);
    if (!message) {
      throw new TelegramApiError('Stored file message is missing from the Storage Channel', 404);
    }

    const telegramClient = await getMtprotoClient();
    const downloaded = await telegramClient.downloadMedia(message);
    if (!Buffer.isBuffer(downloaded)) {
      throw new TelegramApiError('Telegram returned no file data');
    }

    const buffer = downloaded;
    logger.info({ messageId, size: buffer.length, msg: 'File downloaded from Telegram' });
    return buffer;
  } catch (mtprotoError) {
    logger.error({
      err: mtprotoError,
      botApiError,
      messageId,
      msg: 'Both Telegram download methods failed',
    });
    const reason =
      mtprotoError instanceof Error ? mtprotoError.message : 'Unknown MTProto download error';
    throw new TelegramApiError(
      `File download failed. Bot API: ${botApiError instanceof Error ? botApiError.message : 'unknown error'}. ` +
        `Channel reader: ${reason}. For larger files, verify the owner Telegram account can access the Storage Channel.`,
    );
  }
}

/**
 * Check whether a stored file's channel message is still available.
 */
export async function hasStoredFile(messageId: number): Promise<boolean> {
  return hasChannelMessage(config.storageChannelId, messageId);
}

/**
 * Delete a file from the Storage Channel by message ID.
 */
export async function deleteFile(messageId: number): Promise<boolean> {
  try {
    await api.deleteMessage(config.storageChannelId, messageId);
    logger.info({ messageId, msg: 'File deleted from Storage Channel' });
    return true;
  } catch (err) {
    logger.error({ err, messageId, msg: 'Failed to delete file from Storage Channel' });
    throw new TelegramApiError(`Failed to delete file: ${(err as Error).message}`);
  }
}

/**
 * Check if the Storage Channel is accessible.
 */
export async function checkChannel(): Promise<boolean> {
  try {
    await assertBotCanPostInChannel(api, config.storageChannelId);
  } catch (err) {
    logger.warn({
      err,
      channelId: config.storageChannelId,
      accessLayer: 'Bot API',
      msg: 'Bot API cannot post to the Storage Channel',
    });
    return false;
  }

  try {
    await checkChannelReadAccess(config.storageChannelId);
    return true;
  } catch (err) {
    logger.warn({
      err,
      channelId: config.storageChannelId,
      accessLayer: 'owner MTProto session',
      msg: 'Owner session cannot read the Storage Channel',
    });
    return false;
  }
}

/**
 * Get human-readable file size.
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
