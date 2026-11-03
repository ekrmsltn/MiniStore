/**
 * Authenticated MTProto client for reading private channel history.
 * The session belongs to the configured owner and must be kept secret.
 */

import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { loadConfig } from '../config';
import { TelegramApiError } from '../errors';
import logger from '../logger';

const config = loadConfig();

let client: TelegramClient | undefined;
let connecting: Promise<TelegramClient> | undefined;
const channelEntities = new Map<string, Parameters<TelegramClient['iterMessages']>[0]>();

async function createClient(): Promise<TelegramClient> {
  if (!config.telegramUserSession) {
    throw new Error('TELEGRAM_USER_SESSION is required to read Telegram channel history');
  }

  const parsedApiId = Number(config.apiId);
  if (!Number.isSafeInteger(parsedApiId) || parsedApiId <= 0) {
    throw new Error('API_ID must be a positive safe integer for MTProto');
  }

  const telegramClient = new TelegramClient(
    new StringSession(config.telegramUserSession),
    parsedApiId,
    config.apiHash,
    { connectionRetries: 5, requestRetries: 3, floodSleepThreshold: 60 },
  );

  try {
    await telegramClient.connect();
    if (!(await telegramClient.checkAuthorization())) {
      await telegramClient.disconnect();
      throw new Error('The configured Telegram user session is not authorized');
    }
    const user = await telegramClient.getMe();
    if (String(user.id) !== String(config.ownerId)) {
      await telegramClient.disconnect();
      throw new Error('The configured Telegram user session does not match OWNER_ID');
    }
    return telegramClient;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === 'The configured Telegram user session is not authorized' ||
        error.message === 'The configured Telegram user session does not match OWNER_ID')
    ) {
      throw error;
    }
    logger.error({ err: error, msg: 'Failed to connect MTProto channel reader' });
    throw new TelegramApiError('Could not connect the authenticated channel reader');
  }
}

export async function getMtprotoClient(): Promise<TelegramClient> {
  if (client) return client;
  if (!connecting) {
    connecting = createClient()
      .then((connectedClient) => {
        client = connectedClient;
        return connectedClient;
      })
      .finally(() => {
        connecting = undefined;
      });
  }
  return connecting;
}

function parseChannelId(channelId: string): number {
  if (!/^-100\d+$/.test(channelId)) {
    throw new Error(`Invalid private Telegram channel ID: ${channelId}`);
  }

  const parsed = Number(channelId);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('Telegram channel ID is outside the safe integer range');
  }
  return parsed;
}

export async function getChannelEntity(channelId: string) {
  const peerId = parseChannelId(channelId);
  const cached = channelEntities.get(channelId);
  if (cached) return cached;

  const telegramClient = await getMtprotoClient();
  const lookupErrors: string[] = [];
  for (const archived of [true, false]) {
    try {
      for await (const dialog of telegramClient.iterDialogs({ limit: undefined, archived })) {
        if (dialog.id?.toString() === String(peerId) && dialog.entity) {
          channelEntities.set(channelId, dialog.entity);
          logger.info({ channelId, archived, msg: 'Telegram channel resolved from dialog folder' });
          return dialog.entity;
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      lookupErrors.push(`${archived ? 'archived' : 'active'} dialogs: ${reason}`);
      logger.warn({ err: error, channelId, archived, msg: 'Telegram channel dialog lookup failed' });
    }
  }

  try {
    const entity = await telegramClient.getEntity(peerId);
    if (entity) {
      channelEntities.set(channelId, entity);
      logger.info({ channelId, msg: 'Telegram channel resolved from the MTProto entity cache' });
      return entity;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    lookupErrors.push(`cached entity: ${reason}`);
    logger.warn({ err: error, channelId, msg: 'Telegram channel cache lookup failed' });
  }

  const lookupDetails = lookupErrors.length ? ` Lookup errors: ${lookupErrors.join('; ')}.` : '';
  throw new Error(
    `Telegram account cannot resolve channel ${channelId} from archived or active dialogs or its entity cache.${lookupDetails} Verify the full -100... channel ID and that the account used by TELEGRAM_USER_SESSION is still a member of this channel.`,
  );
}

export async function* iterateChannelHistory(channelId: string) {
  const telegramClient = await getMtprotoClient();
  const channel = await getChannelEntity(channelId);

  for await (const message of telegramClient.iterMessages(channel, {
    reverse: true,
    waitTime: 1,
  })) {
    yield message;
  }
}

export async function getChannelMessage(channelId: string, messageId: number) {
  const telegramClient = await getMtprotoClient();
  const channel = await getChannelEntity(channelId);
  const messages = await telegramClient.getMessages(channel, { ids: messageId });
  return messages[0];
}

export async function checkChannelReadAccess(channelId: string): Promise<void> {
  const telegramClient = await getMtprotoClient();
  const channel = await getChannelEntity(channelId);
  await telegramClient.getMessages(channel, { limit: 1 });
}

export async function hasChannelMessage(channelId: string, messageId: number): Promise<boolean> {
  const message = await getChannelMessage(channelId, messageId);
  return Boolean(message);
}

export async function disconnectMtprotoClient(): Promise<void> {
  if (!client) return;
  const connectedClient = client;
  client = undefined;
  channelEntities.clear();
  await connectedClient.disconnect();
}
