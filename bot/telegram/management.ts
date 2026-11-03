/**
 * Management Channel operations.
 * Handles sending, editing, deleting, and retrieving messages
 * in the Management Channel for persistent entity storage.
 *
 */

import { Api } from 'grammy';
import { loadConfig } from '../config';
import logger from '../logger';
import { Entity, EntityType } from '../models';
import { TelegramApiError } from '../errors';
import { checkChannelReadAccess, getChannelMessage, iterateChannelHistory } from './mtproto';
import { assertBotCanPostInChannel } from './channel-access';

const config = loadConfig();
const api = new Api(config.botToken);

/**
 * Send a new message to the Management Channel with entity JSON.
 * Returns the message ID for reference.
 */
export async function sendEntity(entity: Entity): Promise<number> {
  const json = JSON.stringify(entity);

  // Check if JSON fits in Telegram's 4096 character limit
  if (json.length > 4096) {
    throw new Error(
      `Entity JSON exceeds Telegram message limit (${json.length}/4096 chars). ` +
        `Consider splitting metadata or truncating fields.`,
    );
  }

  try {
    const msg = await api.sendMessage(config.managementChannelId, json);
    logger.info({
      entityId: entity.id,
      messageId: msg.message_id,
      msg: 'Entity stored in Management Channel',
    });
    return msg.message_id;
  } catch (err) {
    logger.error({ err, entityId: entity.id, msg: 'Failed to send entity to Management Channel' });
    throw new TelegramApiError(`Failed to store entity: ${(err as Error).message}`);
  }
}

/**
 * Edit an existing message in the Management Channel.
 * Used to update entity records.
 */
export async function editEntity(messageId: number, entity: Entity): Promise<boolean> {
  const json = JSON.stringify(entity);

  if (json.length > 4096) {
    throw new Error(`Entity JSON exceeds Telegram message limit (${json.length}/4096 chars).`);
  }

  try {
    await api.editMessageText(config.managementChannelId, messageId, json);
    logger.info({ entityId: entity.id, messageId, msg: 'Entity updated in Management Channel' });
    return true;
  } catch (err) {
    logger.error({
      err,
      entityId: entity.id,
      messageId,
      msg: 'Failed to edit entity in Management Channel',
    });
    throw new TelegramApiError(`Failed to update entity: ${(err as Error).message}`);
  }
}

/**
 * Delete a message from the Management Channel.
 * Used for permanent deletion of entities.
 */
export async function deleteEntity(messageId: number): Promise<boolean> {
  try {
    await api.deleteMessage(config.managementChannelId, messageId);
    logger.info({ messageId, msg: 'Entity deleted from Management Channel' });
    return true;
  } catch (err) {
    logger.error({ err, messageId, msg: 'Failed to delete entity from Management Channel' });
    throw new TelegramApiError(`Failed to delete entity: ${(err as Error).message}`);
  }
}

/**
 * Get a message from the Management Channel by message ID.
 * Returns the parsed entity or null if not found.
 */
export async function getEntity(messageId: number): Promise<Entity | null> {
  const message = await getChannelMessage(config.managementChannelId, messageId);
  if (!message?.message) return null;
  return parseEntity(message.message, message.id);
}

/**
 * Read records directly from Telegram history. The in-memory index is rebuilt
 * from these authoritative channel messages on each process start.
 */
export interface EntityRecord {
  entity: Entity;
  messageId: number;
}

function parseEntity(text: string, messageId: number): Entity | null {
  if (!text.trimStart().startsWith('{')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    logger.warn({ err: error, messageId, msg: 'Failed to parse entity JSON' });
    throw new Error(`Management message ${messageId} contains malformed entity JSON`);
  }

  if (!isEntityRecord(parsed)) {
    logger.error({ messageId, msg: 'Management message has an invalid entity shape' });
    throw new Error(`Management message ${messageId} is not a valid MiniStore entity`);
  }
  return parsed;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isEntityRecord(value: unknown): value is Entity {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string'
  ) {
    return false;
  }

  switch (record.type) {
    case 'user':
      return (
        record.id.startsWith('user:') &&
        typeof record.telegramId === 'number' &&
        ['owner', 'admin', 'user', 'pending', 'rejected', 'suspended', 'blocked'].includes(
          String(record.role),
        ) &&
        ['active', 'inactive', 'suspended', 'blocked'].includes(String(record.status)) &&
        isStringArray(record.permissions) &&
        isStringArray(record.favorites)
      );
    case 'folder':
      return (
        record.id.startsWith('folder:') &&
        typeof record.name === 'string' &&
        (record.parentId === null || typeof record.parentId === 'string') &&
        typeof record.creatorId === 'number' &&
        typeof record.isDeleted === 'boolean' &&
        (record.deletedAt === null || typeof record.deletedAt === 'string') &&
        (record.deletionBatchId === undefined || typeof record.deletionBatchId === 'string')
      );
    case 'resource':
      return (
        record.id.startsWith('resource:') &&
        typeof record.title === 'string' &&
        typeof record.description === 'string' &&
        isStringArray(record.tags) &&
        typeof record.fileType === 'string' &&
        typeof record.fileSize === 'number' &&
        (record.fileName === undefined || typeof record.fileName === 'string') &&
        (record.folderId === null || typeof record.folderId === 'string') &&
        typeof record.storageMessageId === 'number' &&
        typeof record.storageFileId === 'string' &&
        typeof record.uploaderId === 'number' &&
        (record.currentVersionUploaderId === undefined ||
          typeof record.currentVersionUploaderId === 'number') &&
        typeof record.version === 'number' &&
        typeof record.downloadCount === 'number' &&
        typeof record.isDeleted === 'boolean' &&
        (record.deletedAt === null || typeof record.deletedAt === 'string') &&
        (record.deletionBatchId === undefined || typeof record.deletionBatchId === 'string')
      );
    case 'resource_version':
      return (
        record.id.startsWith('resource_version:') &&
        typeof record.resourceId === 'string' &&
        record.resourceId.startsWith('resource:') &&
        typeof record.version === 'number' &&
        Number.isSafeInteger(record.version) &&
        Number(record.version) > 0 &&
        typeof record.fileName === 'string' &&
        typeof record.fileType === 'string' &&
        typeof record.fileSize === 'number' &&
        Number.isSafeInteger(record.fileSize) &&
        Number(record.fileSize) >= 0 &&
        typeof record.storageMessageId === 'number' &&
        Number.isSafeInteger(record.storageMessageId) &&
        Number(record.storageMessageId) > 0 &&
        typeof record.storageFileId === 'string' &&
        typeof record.uploaderId === 'number' &&
        Number.isSafeInteger(record.uploaderId)
      );
    case 'audit':
      return (
        record.id.startsWith('audit:') &&
        typeof record.actorId === 'number' &&
        typeof record.action === 'string' &&
        typeof record.targetId === 'string' &&
        typeof record.metadata === 'object' &&
        record.metadata !== null &&
        typeof record.timestamp === 'string'
      );
    case 'session':
      return (
        record.id.startsWith('session:') &&
        typeof record.telegramId === 'number' &&
        Number.isSafeInteger(record.telegramId) &&
        typeof record.expiresAt === 'number' &&
        Number.isSafeInteger(record.expiresAt) &&
        typeof record.revoked === 'boolean'
      );
    case 'assistant_usage':
      return (
        record.id === `assistant_usage:${record.telegramId}` &&
        Number.isSafeInteger(record.telegramId) &&
        Array.isArray(record.requestTimestamps) &&
        record.requestTimestamps.every(
          (timestamp) => typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)),
        )
      );
    default:
      return false;
  }
}

export async function* iterateEntityRecords(): AsyncGenerator<EntityRecord> {
  let count = 0;
  for await (const message of iterateChannelHistory(config.managementChannelId)) {
    if (!message.message) continue;
    const entity = parseEntity(message.message, message.id);
    if (entity) {
      count += 1;
      yield { entity, messageId: message.id };
    }
  }
  logger.info({ count, msg: 'Finished reading entities from Telegram history' });
}

export async function getAllEntityRecords(): Promise<EntityRecord[]> {
  const records: EntityRecord[] = [];
  for await (const record of iterateEntityRecords()) {
    records.push(record);
  }
  return records;
}

export async function getAllEntities(): Promise<Entity[]> {
  return (await getAllEntityRecords()).map(({ entity }) => entity);
}

/**
 * Get messages of a specific type from the Management Channel.
 */
export async function getEntitiesByType(type: EntityType): Promise<Entity[]> {
  const all = await getAllEntities();
  return all.filter((e) => e.type === type);
}

/**
 * Check if the Management Channel is accessible.
 */
export async function checkChannel(): Promise<boolean> {
  try {
    await assertBotCanPostInChannel(api, config.managementChannelId);
  } catch (err) {
    logger.warn({
      err,
      channelId: config.managementChannelId,
      accessLayer: 'Bot API',
      msg: 'Bot API cannot post to the Management Channel',
    });
    return false;
  }

  try {
    await checkChannelReadAccess(config.managementChannelId);
    return true;
  } catch (err) {
    logger.warn({
      err,
      channelId: config.managementChannelId,
      accessLayer: 'owner MTProto session',
      msg: 'Owner session cannot read the Management Channel',
    });
    return false;
  }
}
