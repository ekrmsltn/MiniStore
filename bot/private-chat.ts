import type { Context, MiddlewareFn } from 'grammy';

const privateChatMessage = 'Please use MiniStore in a private chat with the bot.';

export const privateChatOnly: MiddlewareFn<Context> = async (ctx, next) => {
  if (ctx.chat?.type === 'private') {
    await next();
    return;
  }

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: privateChatMessage });
  } else if (ctx.chat && ctx.message) {
    await ctx.reply(privateChatMessage);
  }
};
