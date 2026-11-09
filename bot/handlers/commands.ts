import { Bot, Context, InlineKeyboard } from 'grammy';
import { loadConfig } from '../config';
import logger from '../logger';
import {
  requestAccess,
  canAccessStore,
  getUserById,
  getAllUsers,
  createOwnerRecord,
} from '../services/users';
import { index } from '../telegram/index';
import { notifyAdminsOfAccessRequest } from '../services/notifications';
import { hasPermission } from '../services/permissions';
import {
  cancelAssistantConversation,
  getAssistantUsageStatus,
  isAssistantConfigured,
} from '../services/assistant';
import { promptForUpload, uploadFolderState, uploadVersionState } from './uploads';
import {
  deleteAssistantThinkingMessage,
  formatAssistantUsage,
  replyWithAssistant,
} from './assistant-ui';
import {
  assistantCancelHint,
  assistantFlowActive,
  clearAssistantPromptMessages,
  textActionState,
} from './state';
import {
  getAdminKeyboard,
  getHomeKeyboard,
  isAdminUser,
  promptForText,
  showPendingRequests,
  showHome,
} from './screens';
import { registerCallbackHandlers } from './callbacks';

const config = loadConfig();

export function registerCommandHandlers(bot: Bot<Context>): void {
  /**
   * /start command — entry point for all users.
   */
  bot.command('start', async (ctx) => {
    const user = ctx.from;
    if (!user) return;

    const telegramId = user.id;
    const username = user.username || null;
    const firstName = user.first_name || null;
    const lastName = user.last_name || null;

    logger.info({ userId: telegramId, msg: '/start command received' });

    try {
      if (!index.isInitialized()) {
        return ctx.reply(
          'MiniStore is temporarily unavailable while channel data is being recovered.',
        );
      }

      // OWNER BYPASS: Owner can access immediately without approval
      if (telegramId === config.ownerId) {
        const existing = getUserById(telegramId);
        await createOwnerRecord(telegramId, username, firstName, lastName);
        if (!existing) {
          logger.info({ userId: telegramId, msg: 'Owner record created on /start' });
        }

        return ctx.reply('Welcome, Owner! You have full access to MiniStore.', {
          reply_markup: getHomeKeyboard(telegramId),
        });
      }

      // Check if user already exists
      const existing = getUserById(telegramId);

      if (existing && canAccessStore(telegramId)) {
        return ctx.reply(`Welcome back, ${firstName || 'User'}! Choose an action below.`, {
          reply_markup: getHomeKeyboard(telegramId),
        });
      }

      if (existing && existing.role === 'pending') {
        return ctx.reply(
          'Your access request is pending. An admin will review it soon. If you have not received a decision, please contact an administrator.',
        );
      }

      if (existing && existing.role === 'blocked') {
        return ctx.reply(
          'Your access has been denied. Contact an admin if you believe this is an error.',
        );
      }

      if (existing && existing.role === 'suspended') {
        return ctx.reply('Your account is suspended. Contact an admin for more information.');
      }

      // New user or needs access request
      const request = await requestAccess(telegramId, username, firstName, lastName);
      if (!request.created) {
        return ctx.reply('Your access request is pending. An admin will review it soon.');
      }

      const notification = await notifyAdminsOfAccessRequest(request.user);
      return ctx.reply(
        `Welcome to MiniStore, ${firstName || 'User'}!\n\n` +
          (notification.notified
            ? 'Your access request has been sent to the administrators. You will be notified once it is reviewed.'
            : 'Your access request was saved, but we could not notify an administrator. Please contact an administrator directly.'),
      );
    } catch (err) {
      // If we can't save to the Management Channel, still respond to the user
      logger.error({ err, userId: telegramId, msg: 'Error in /start handler' });

      // For the owner, allow access even if the Management Channel is down
      if (telegramId === config.ownerId) {
        return ctx.reply(
          '⚠️ Warning: Management Channel is temporarily unavailable. Changes may not persist on restart.',
          { reply_markup: getHomeKeyboard(telegramId) },
        );
      }

      // For other users, try to show a helpful message
      return ctx.reply(
        '⚠️ Something went wrong processing your request.\n\n' +
          'The Management Channel may be unavailable. Please try again later or contact the administrator.',
      );
    }
  });

  /**
   * /help command.
   */
  bot.command('help', (ctx) => {
    return ctx.reply(
      '📋 *MiniStore Help*\n\n' +
        '/start — Open the store or request access\n' +
        '/store — Browse files, search, favorites, and profile\n' +
        '/search — Search files by title, tags, or description\n' +
        '/upload — Upload a file to MiniStore (admins)\n' +
        '/ask <question> — Ask the MiniStore assistant (or use its menu button)\n' +
        '/usage — Check your assistant request usage and next reset\n' +
        '/help — Show this help message\n\n' +
        'If you need assistance, contact an administrator.',
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('ask', async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!telegramId || !canAccessStore(telegramId)) {
      return ctx.reply('You need an active MiniStore account to use the assistant.');
    }
    if (!isAssistantConfigured()) {
      return ctx.reply(
        'The MiniStore assistant is not configured. Please contact an administrator.',
      );
    }

    const question = ctx.match.trim();
    assistantFlowActive.add(telegramId);
    if (!question) {
      return promptForText(
        ctx,
        { type: 'assistant-question' },
        `🤖 What would you like help with? Send your question.\n\n${assistantCancelHint}`,
      );
    }

    textActionState.delete(telegramId);
    return replyWithAssistant(ctx, telegramId, question, ctx.message?.message_id);
  });

  bot.command('usage', async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!telegramId || !canAccessStore(telegramId)) {
      return ctx.reply('You need an active MiniStore account to view assistant usage.');
    }
    return ctx.reply(formatAssistantUsage(getAssistantUsageStatus(telegramId)));
  });

  bot.callbackQuery('assistant:ask', async (ctx) => {
    await ctx.answerCallbackQuery();
    const telegramId = ctx.from.id;
    if (!canAccessStore(telegramId)) {
      return ctx.reply('You need an active MiniStore account to use the assistant.');
    }
    if (!isAssistantConfigured()) {
      return ctx.reply(
        'The MiniStore assistant is not configured. Please contact an administrator.',
      );
    }
    assistantFlowActive.add(telegramId);
    return promptForText(
      ctx,
      { type: 'assistant-question' },
      `🤖 What would you like help with? Send your question.\n\n${assistantCancelHint}`,
    );
  });

  bot.command('store', async (ctx) => {
    await showHome(ctx);
  });

  bot.command('search', async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!telegramId || !canAccessStore(telegramId)) {
      return ctx.reply('You do not have access to MiniStore. Use /start to check your account.');
    }
    await promptForText(ctx, { type: 'search' }, 'Send a search phrase to find files.');
  });

  bot.command('upload', async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!telegramId || !hasPermission(telegramId, 'upload_resources')) {
      return ctx.reply('You do not have permission to upload files.');
    }
    await promptForUpload(ctx, telegramId, { type: 'new', folderId: null });
  });

  bot.command('cancel', async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;
    const cancelledAssistant =
      assistantFlowActive.delete(telegramId) ||
      textActionState.get(telegramId)?.type === 'assistant-question';
    cancelAssistantConversation(telegramId);
    clearAssistantPromptMessages(telegramId);
    if (cancelledAssistant) await deleteAssistantThinkingMessage(ctx, telegramId);
    const cancelledUpload = uploadFolderState.delete(telegramId);
    const cancelledVersion = uploadVersionState.delete(telegramId);
    const cancelledTextAction = textActionState.delete(telegramId);
    if (cancelledAssistant && canAccessStore(telegramId)) {
      return ctx.reply('✅ Assistant conversation cancelled. MiniStore — choose an action:', {
        reply_markup: getHomeKeyboard(telegramId),
      });
    }
    const hadPendingAction = cancelledUpload || cancelledVersion || cancelledTextAction;
    await ctx.reply(
      hadPendingAction ? '✅ Pending action cancelled.' : 'There is nothing to cancel.',
    );
  });

  /**
   * /status command — check account status.
   */
  bot.command('status', async (ctx) => {
    const user = ctx.from;
    if (!user) return;

    try {
      if (!index.isInitialized()) {
        return ctx.reply(
          'MiniStore account data is temporarily unavailable. Please try again later.',
        );
      }

      const existing = getUserById(user.id);
      if (!existing) {
        return ctx.reply('You are not registered. Use /start to request access.');
      }

      const statusText =
        `📊 *Your Account Status*\n\n` +
        `Role: ${existing.role}\n` +
        `Status: ${existing.status}\n` +
        `Joined: ${new Date(existing.createdAt).toLocaleDateString()}`;

      if (canAccessStore(user.id)) {
        return ctx.reply(statusText, {
          parse_mode: 'Markdown',
          reply_markup: getHomeKeyboard(user.id),
        });
      }

      return ctx.reply(statusText, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error({ err, msg: 'Error in /status handler' });
      return ctx.reply('⚠️ Something went wrong. Please try again later.');
    }
  });

  // ==================== ADMIN COMMANDS ====================

  /**
   * Check if the user is an admin or owner.
   */
  /**
   * /admin command — admin dashboard menu.
   */
  bot.command('admin', async (ctx) => {
    const user = ctx.from;
    if (!user) return;

    try {
      if (!isAdminUser(user.id)) {
        return ctx.reply('❌ You do not have permission to use admin commands.');
      }

      const text = `🔧 *Admin Dashboard*\n\nSelect an action below:`;
      return ctx.reply(text, {
        parse_mode: 'Markdown',
        reply_markup: getAdminKeyboard(user.id),
      });
    } catch (err) {
      logger.error({ err, msg: 'Error in /admin handler' });
      return ctx.reply('⚠️ Something went wrong. Please try again later.');
    }
  });

  registerCallbackHandlers(bot);

  /**
   * /users command — list users (admin only).
   */
  bot.command('users', async (ctx) => {
    const user = ctx.from;
    if (!user) return;
    if (!isAdminUser(user.id) || !hasPermission(user.id, 'manage_users')) {
      return ctx.reply('❌ You do not have permission to manage users.');
    }

    const users = getAllUsers();
    const text =
      `👥 *All Users (${users.length})*\n\n` +
      users
        .slice(0, 20)
        .map((u) => {
          const name = u.firstName || u.username || `ID:${u.telegramId}`;
          return `• ${name} — ${u.role}`;
        })
        .join('\n');

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: new InlineKeyboard().text('← Admin menu', 'admin:home'),
    });
  });

  /**
   * /requests command — list pending requests (admin only).
   */
  bot.command('requests', async (ctx) => {
    const user = ctx.from;
    if (!user) return;
    if (!isAdminUser(user.id) || !hasPermission(user.id, 'manage_users')) {
      return ctx.reply('❌ You do not have permission to manage access requests.');
    }

    await showPendingRequests(ctx);
  });
}
