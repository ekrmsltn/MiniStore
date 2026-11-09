/**
 * grammY Bot setup.
 * Configures the Telegram bot with commands and handlers.
 */

import { Bot, BotError, Context } from 'grammy';
import { loadConfig } from './config';
import logger from './logger';
import { privateChatOnly } from './private-chat';
import { registerCommandHandlers } from './handlers/commands';
import { registerTextActionHandlers } from './handlers/text-actions';
import { registerUploadHandlers } from './handlers/uploads';

const config = loadConfig();
const bot = new Bot<Context>(config.botToken);
bot.use(privateChatOnly);
registerUploadHandlers(bot);

// Error handler — log processing and notification failures separately.
bot.catch(async (err: BotError<Context>) => {
  const ctx = err.ctx;
  const updateType = Object.keys(ctx.update).find((key) => key !== 'update_id') ?? 'unknown';
  logger.error({
    err: err.error,
    updateId: ctx.update.update_id,
    updateType,
    msg: 'Bot update failed',
  });
  try {
    if (ctx?.chat?.id) {
      await ctx.reply('⚠️ Something went wrong. Please try again later.');
    }
  } catch (notificationError) {
    logger.warn({
      err: notificationError,
      updateId: ctx.update.update_id,
      updateType,
      msg: 'Could not notify user about bot error',
    });
  }
});

registerCommandHandlers(bot);
registerTextActionHandlers(bot);

export { bot };
