import { Api } from 'grammy';
import { loadConfig } from '../config';
import logger from '../logger';
import { getAllUsers } from './users';
import { UserEntity } from '../models';
import { hasPermission } from './permissions';

const config = loadConfig();
const api = new Api(config.botToken);

export interface AccessNotificationResult {
  notified: boolean;
  recipients: number;
  usedChannelFallback: boolean;
}

function displayName(user: Pick<UserEntity, 'firstName' | 'lastName' | 'username' | 'telegramId'>): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return (name || (user.username ? `@${user.username}` : `User ${user.telegramId}`))
    .replace(/\p{Cc}/gu, ' ')
    .slice(0, 100);
}

function getAdminIds(): number[] {
  return Array.from(
    new Set([
      config.ownerId,
      ...getAllUsers()
        .filter(
          (user) =>
            user.role === 'admin' &&
            user.status === 'active' &&
            hasPermission(user.telegramId, 'manage_users'),
        )
        .map((user) => user.telegramId),
    ]),
  );
}

export async function notifyAdminsOfAccessRequest(
  user: UserEntity,
): Promise<AccessNotificationResult> {
  const name = displayName(user);
  const message =
    `New MiniStore access request\n\n${name}\nTelegram ID: ${user.telegramId}`;
  const reply_markup = {
    inline_keyboard: [
      [
        { text: 'Approve', callback_data: `approve:${user.telegramId}` },
        { text: 'Reject', callback_data: `reject:${user.telegramId}` },
      ],
    ],
  };
  let recipients = 0;

  await Promise.all(
    getAdminIds().map(async (adminId) => {
      try {
        await api.sendMessage(adminId, message, { reply_markup });
        recipients++;
      } catch (err) {
        logger.warn({
          err,
          adminId,
          requestUserId: user.telegramId,
          msg: 'Could not deliver access request directly to admin',
        });
      }
    }),
  );

  if (recipients > 0) {
    return { notified: true, recipients, usedChannelFallback: false };
  }

  try {
    await api.sendMessage(config.managementChannelId, message, { reply_markup });
    return { notified: true, recipients: 1, usedChannelFallback: true };
  } catch (err) {
    logger.error({
      err,
      requestUserId: user.telegramId,
      msg: 'Could not deliver access request to admins or Management Channel',
    });
    return { notified: false, recipients: 0, usedChannelFallback: false };
  }
}

export async function notifyUserOfAccessDecision(
  user: UserEntity,
  approved: boolean,
): Promise<boolean> {
  const message = approved
    ? 'Your MiniStore access request was approved. Send /start to open MiniStore.'
    : 'Your MiniStore access request was not approved. Contact an administrator if you believe this is a mistake.';

  try {
    await api.sendMessage(user.telegramId, message);
    return true;
  } catch (err) {
    logger.warn({
      err,
      userId: user.telegramId,
      decision: approved ? 'approved' : 'rejected',
      msg: 'Could not notify user about access decision',
    });
    return false;
  }
}
