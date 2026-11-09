import { Bot, Context } from 'grammy';
import { approveUser, rejectUser } from '../../services/users';
import { notifyUserOfAccessDecision } from '../../services/notifications';
import { hasPermission } from '../../services/permissions';
import logger from '../../logger';
import { isAdminUser, getAdminKeyboard } from '../screens';

export function registerAdminCallbacks(bot: Bot<Context>): void {
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
