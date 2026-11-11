import { Bot, Context } from 'grammy';
import logger from '../logger';
import { createFolder, renameFolder } from '../services/folders';
import { updateResource } from '../services/resources';
import { hasPermission } from '../services/permissions';
import { canAccessFolder, canAccessResourceId } from '../services/visibility';
import { replyWithAssistant } from './assistant-ui';
import {
  assistantCancelHint,
  assistantFlowActive,
  assistantPromptMessages,
  getAssistantPromptMessageKey,
  textActionState,
} from './state';
import { showAdminFolder, showBrowse, showResource, showSearchResults } from './screens';

export function registerTextActionHandlers(bot: Bot<Context>): void {
  bot.on('edited_message:text', async (ctx) => {
    const message = ctx.editedMessage;
    const telegramId = ctx.from?.id;
    if (!telegramId || !ctx.chat) return;
    const prompt = assistantPromptMessages.get(
      getAssistantPromptMessageKey(ctx.chat.id, message.message_id),
    );
    if (!prompt || prompt.userId !== telegramId || prompt.chatId !== ctx.chat.id) return;

    const commandEntity = message.entities?.find(
      (entity) => entity.type === 'bot_command' && entity.offset === 0,
    );
    let question = message.text.trim();
    if (commandEntity) {
      if (!/^\/ask(?:@[\w]+)?(?:\s|$)/i.test(question)) return;
      question = question.slice(commandEntity.length).trim();
    }
    if (!question) {
      return ctx.reply('Please edit the message to include a non-empty question.');
    }
    if (!assistantFlowActive.has(telegramId)) return;

    textActionState.delete(telegramId);
    return replyWithAssistant(ctx, telegramId, question, message.message_id, prompt);
  });

  bot.on('message:text', async (ctx) => {
    const commandEntity = ctx.message.entities?.find(
      (entity) => entity.type === 'bot_command' && entity.offset === 0,
    );
    if (commandEntity) {
      return ctx.reply('Unknown command. Use /help to see available commands.');
    }

    const telegramId = ctx.from?.id;
    const action = telegramId ? textActionState.get(telegramId) : undefined;
    if (!telegramId || !action) return;

    const value = ctx.message.text.trim();
    textActionState.delete(telegramId);
    if (!value) {
      if (action.type === 'assistant-question' && assistantFlowActive.has(telegramId)) {
        textActionState.set(telegramId, action);
        return ctx.reply(`Please send a non-empty question.\n\n${assistantCancelHint}`);
      }
      return ctx.reply('Please send a non-empty value. Use /store to continue.');
    }

    try {
      switch (action.type) {
        case 'search':
          return showSearchResults(ctx, value);
        case 'assistant-question':
          return replyWithAssistant(ctx, telegramId, value, ctx.message.message_id);
        case 'folder-create': {
          if (!hasPermission(telegramId, 'manage_folders')) {
            return ctx.reply('You do not have permission to manage folders.');
          }
          if (action.parentId && !canAccessFolder(telegramId, action.parentId)) {
            return ctx.reply('You cannot create a folder inside a folder you cannot access.');
          }
          const folder = await createFolder(value, action.parentId, telegramId);
          await ctx.reply(`✅ Created folder "${folder.name}".`);
          return showBrowse(ctx, action.parentId);
        }
        case 'folder-rename': {
          if (!hasPermission(telegramId, 'manage_folders')) {
            return ctx.reply('You do not have permission to manage folders.');
          }
          if (!canAccessFolder(telegramId, action.folderId)) {
            return ctx.reply('This folder is unavailable.');
          }
          const folder = await renameFolder(action.folderId, value, telegramId);
          await ctx.reply(`✅ Renamed folder to "${folder.name}".`);
          return showAdminFolder(ctx, folder.id);
        }
        case 'resource-rename': {
          if (!hasPermission(telegramId, 'upload_resources')) {
            return ctx.reply('You do not have permission to edit files.');
          }
          if (!canAccessResourceId(telegramId, action.resourceId)) {
            return ctx.reply('This file is unavailable.');
          }
          const resource = await updateResource(action.resourceId, { title: value }, telegramId);
          await ctx.reply(`✅ Renamed file to "${resource.title}".`);
          return showResource(ctx, resource.id);
        }
        case 'resource-description': {
          if (!hasPermission(telegramId, 'upload_resources')) {
            return ctx.reply('You do not have permission to edit files.');
          }
          if (!canAccessResourceId(telegramId, action.resourceId)) {
            return ctx.reply('This file is unavailable.');
          }
          const resource = await updateResource(
            action.resourceId,
            { description: value === '-' ? '' : value },
            telegramId,
          );
          await ctx.reply('✅ Description updated.');
          return showResource(ctx, resource.id);
        }
        case 'resource-tags': {
          if (!hasPermission(telegramId, 'upload_resources')) {
            return ctx.reply('You do not have permission to edit files.');
          }
          if (!canAccessResourceId(telegramId, action.resourceId)) {
            return ctx.reply('This file is unavailable.');
          }
          const tags =
            value === '-'
              ? []
              : value
                  .split(',')
                  .map((tag) => tag.trim())
                  .filter(Boolean);
          const resource = await updateResource(action.resourceId, { tags }, telegramId);
          await ctx.reply('✅ Tags updated.');
          return showResource(ctx, resource.id);
        }
        case 'resource-category': {
          if (!hasPermission(telegramId, 'upload_resources')) {
            return ctx.reply('You do not have permission to edit files.');
          }
          if (!canAccessResourceId(telegramId, action.resourceId)) {
            return ctx.reply('This file is unavailable.');
          }
          const resource = await updateResource(
            action.resourceId,
            { categoryId: value === '-' ? null : value },
            telegramId,
          );
          await ctx.reply('✅ Category updated.');
          return showResource(ctx, resource.id);
        }
      }
    } catch (error) {
      logger.error({
        err: error,
        userId: telegramId,
        action: action.type,
        msg: 'Bot text action failed',
      });
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Could not complete that action: ${message}`);
    }
  });
}
