import { Context, InlineKeyboard } from 'grammy';
import { index } from '../../telegram/index';
import { isAdmin } from '../../services/users';

export function isAdminUser(telegramId: number): boolean {
  return index.isInitialized() && isAdmin(telegramId);
}

export function addBackButton(keyboard: InlineKeyboard, callbackData = 'lib:home'): InlineKeyboard {
  return keyboard.text('← Menu', callbackData);
}

export function resourceIdFromToken(token: string): string {
  return token.startsWith('resource:') ? token : `resource:${token}`;
}

export function folderIdFromToken(token: string): string {
  return token.startsWith('folder:') ? token : `folder:${token}`;
}

export async function renderScreen(
  ctx: Context,
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  } else {
    await ctx.reply(text, { reply_markup: keyboard });
  }
}
