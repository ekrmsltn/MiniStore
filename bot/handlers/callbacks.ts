import { Bot, Context } from 'grammy';
import { registerAdminCallbacks } from './callbacks/admin';
import { registerStoreCallbacks } from './callbacks/store';

export function registerCallbackHandlers(bot: Bot<Context>): void {
  registerStoreCallbacks(bot);
  registerAdminCallbacks(bot);
}
