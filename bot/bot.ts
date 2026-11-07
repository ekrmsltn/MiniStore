/**
 * grammY Bot setup.
 * Configures the Telegram bot with commands and handlers.
 */

import { Bot, BotError, Context, GrammyError, InlineKeyboard } from 'grammy';
import { loadConfig } from './config';
import logger from './logger';
import {
  requestAccess,
  canAccessStore,
  getUserById,
  getAllUsers,
  getPendingRequests,
  isAdmin,
  approveUser,
  rejectUser,
  suspendUser,
  blockUser,
  unblockUser,
  promoteUser,
  demoteUser,
  createOwnerRecord,
  addFavorite,
  removeFavorite,
  updateUserPermissions,
} from './services/users';
import {
  createResource,
  createResourceVersion,
  checkDuplicateResource,
  deleteResource,
  getAllResources,
  getDeletedResources,
  getResource,
  getResourceVersion,
  getResourceVersions,
  searchResources,
  trackDownload,
  updateResource,
  restoreResource,
  permanentDeleteResource,
} from './services/resources';
import {
  deleteFile,
  uploadTelegramMedia,
  TelegramMediaKind,
  formatFileSize,
} from './telegram/storage';
import { index } from './telegram/index';
import {
  createFolder,
  deleteFolder,
  getDeletedFolders,
  moveFolder,
  permanentDeleteFolder,
  renameFolder,
  restoreFolder,
} from './services/folders';
import { notifyAdminsOfAccessRequest, notifyUserOfAccessDecision } from './services/notifications';
import { AVAILABLE_PERMISSIONS, hasPermission } from './services/permissions';
import {
  askAssistant,
  AssistantCancelledError,
  AssistantProviderError,
  AssistantUsageStatus,
  cancelAssistantConversation,
  getAssistantUsageOverview,
  getAssistantUsageStatus,
  isAssistantConfigured,
  prepareAssistantReply,
} from './services/assistant';
import { ForbiddenError, RateLimitError, ValidationError } from './errors';
import { privateChatOnly } from './private-chat';

type UploadAction =
  { type: 'new'; folderId: string | null } | { type: 'version'; resourceId: string };

// Keep upload destination and version actions scoped to each user.
const uploadFolderState = new Map<number, string | null>();
const uploadVersionState = new Map<number, string>();
type TextAction =
  | { type: 'search' }
  | { type: 'assistant-question' }
  | { type: 'folder-create'; parentId: string | null }
  | { type: 'folder-rename'; folderId: string }
  | { type: 'resource-rename'; resourceId: string }
  | { type: 'resource-description'; resourceId: string }
  | { type: 'resource-tags'; resourceId: string }
  | { type: 'resource-category'; resourceId: string };
type BrowseSort = 'name' | 'recent';
const textActionState = new Map<number, TextAction>();
const assistantFlowActive = new Set<number>();
const assistantThinkingMessages = new Map<number, { chatId: number; messageId: number }>();
const assistantCancelHint = 'or use /cancel to cancel';

async function promptForUpload(
  ctx: Context,
  telegramId: number,
  action: UploadAction,
): Promise<void> {
  uploadFolderState.delete(telegramId);
  uploadVersionState.delete(telegramId);

  if (action.type === 'version') {
    const resource = index.getResource(action.resourceId);
    if (!resource || resource.isDeleted) {
      await ctx.reply('That resource is no longer available. Return to MiniStore and try again.', {
        reply_markup: new InlineKeyboard().text('← Store', 'lib:home'),
      });
      return;
    }
    uploadVersionState.set(telegramId, resource.id);
    await ctx.reply(
      `Upload a new version of "${resource.title}". Send the replacement file or media.`,
      { reply_markup: new InlineKeyboard().text('Cancel', 'upload:cancel') },
    );
    return;
  }

  if (action.folderId) {
    const folder = index.getFolder(action.folderId);
    if (!folder || folder.isDeleted) {
      await ctx.reply('That folder is no longer available. Return to MiniStore and try again.', {
        reply_markup: new InlineKeyboard().text('← Store', 'lib:home'),
      });
      return;
    }
  }

  uploadFolderState.set(telegramId, action.folderId);
  const folderName = action.folderId ? index.getFolder(action.folderId)?.name || 'Unknown' : 'Root';
  await ctx.reply(
    `📤 Upload files to ${folderName}. Send one or more Telegram-supported files or media, then tap Done.`,
    {
      reply_markup: new InlineKeyboard()
        .text('✅ Done', 'upload:finish')
        .text('Cancel', 'upload:cancel')
        .row(),
    },
  );
}

const config = loadConfig();
const bot = new Bot<Context>(config.botToken);
bot.use(privateChatOnly);

bot.callbackQuery(/^upload:(finish|cancel)$/, async (ctx) => {
  const userId = ctx.from.id;
  const action = ctx.match[1];
  uploadFolderState.delete(userId);
  uploadVersionState.delete(userId);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    action === 'finish' ? '✅ Upload session finished.' : 'Upload session cancelled.',
    { reply_markup: new InlineKeyboard().text('Open store', 'lib:home') },
  );
});

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
    return ctx.reply('The MiniStore assistant is not configured. Please contact an administrator.');
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
  return replyWithAssistant(ctx, telegramId, question);
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
    return ctx.reply('The MiniStore assistant is not configured. Please contact an administrator.');
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
function isAdminUser(telegramId: number): boolean {
  return index.isInitialized() && isAdmin(telegramId);
}

function addBackButton(keyboard: InlineKeyboard, callbackData = 'lib:home'): InlineKeyboard {
  return keyboard.text('← Menu', callbackData);
}

function resourceIdFromToken(token: string): string {
  return token.startsWith('resource:') ? token : `resource:${token}`;
}

function folderIdFromToken(token: string): string {
  return token.startsWith('folder:') ? token : `folder:${token}`;
}

async function renderScreen(ctx: Context, text: string, keyboard: InlineKeyboard): Promise<void> {
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  } else {
    await ctx.reply(text, { reply_markup: keyboard });
  }
}

function getHomeKeyboard(telegramId: number): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text('📂 Browse files', 'lib:browse:root')
    .text('🔍 Search', 'lib:search')
    .row()
    .text('⭐ Favorites', 'lib:favorites')
    .text('👤 Profile', 'lib:profile');
  if (isAssistantConfigured()) {
    keyboard.row().text('🤖 Ask assistant', 'assistant:ask');
  }
  if (isAdminUser(telegramId)) {
    keyboard.row().text('⚙️ Admin tools', 'admin:home');
  }
  return keyboard;
}

async function replyWithAssistant(
  ctx: Context,
  telegramId: number,
  question: string,
): Promise<void> {
  const thinkingMessage = await ctx.reply(`Thinking…\n\n${assistantCancelHint}`);
  if (ctx.chat) {
    assistantThinkingMessages.set(telegramId, {
      chatId: ctx.chat.id,
      messageId: thinkingMessage.message_id,
    });
  }
  try {
    let answer: string;
    try {
      answer = await askAssistant(telegramId, question);
    } catch (error) {
      if (error instanceof AssistantCancelledError) return;
      logger.warn({ err: error, userId: telegramId, msg: 'Assistant request failed' });
      const message =
        error instanceof ValidationError ||
        error instanceof RateLimitError ||
        error instanceof ForbiddenError ||
        error instanceof AssistantProviderError
          ? error.message
          : 'The MiniStore assistant is temporarily unavailable. Please try again later.';
      if (assistantFlowActive.has(telegramId)) {
        textActionState.set(telegramId, { type: 'assistant-question' });
        await ctx.reply(`${message}\n\n${assistantCancelHint}`);
      }
      return;
    }

    if (!assistantFlowActive.has(telegramId)) return;
    textActionState.set(telegramId, { type: 'assistant-question' });
    const usage = getAssistantUsageStatus(telegramId);
    const boundedAnswer = answer.length > 3_600 ? `${answer.slice(0, 3_599)}…` : answer;
    await sendAssistantReply(ctx, `${boundedAnswer}\n\n${formatAssistantUsage(usage)}`);
  } finally {
    await deleteAssistantThinkingMessage(ctx, telegramId);
  }
}

function formatAssistantUsage(usage: AssistantUsageStatus): string {
  if (usage.role === 'owner') {
    return 'Assistant usage: unlimited for the configured owner.';
  }

  const reset = usage.resetsAt
    ? ` Next request slot resets at ${usage.resetsAt.toISOString()} (UTC).`
    : '';
  return `Assistant usage (rolling 24 hours): ${usage.used}/${usage.limit} used; ${usage.remaining} remaining.${reset}`;
}

async function sendAssistantReply(ctx: Context, answer: string): Promise<void> {
  const reply = prepareAssistantReply(answer, assistantCancelHint);
  if (!reply.parseMode) {
    await ctx.reply(reply.text);
    return;
  }

  try {
    await ctx.reply(reply.text, { parse_mode: reply.parseMode });
  } catch (error) {
    if (
      !(error instanceof GrammyError) ||
      error.error_code !== 400 ||
      !/parse entities|message is too long/i.test(error.description)
    ) {
      throw error;
    }

    logger.warn({
      description: error.description,
      msg: 'Telegram rejected formatted assistant reply; retrying as plain text',
    });
    await ctx.reply(prepareAssistantReply(answer, assistantCancelHint, true).text);
  }
}

async function deleteAssistantThinkingMessage(ctx: Context, telegramId: number): Promise<void> {
  const message = assistantThinkingMessages.get(telegramId);
  if (!message) return;
  assistantThinkingMessages.delete(telegramId);
  try {
    await ctx.api.deleteMessage(message.chatId, message.messageId);
  } catch (error) {
    logger.warn({
      err: error,
      userId: telegramId,
      msg: 'Could not remove assistant status message',
    });
  }
}

async function showHome(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId || !canAccessStore(telegramId)) {
    await renderScreen(
      ctx,
      'Your MiniStore account is not active. Use /start to check access.',
      new InlineKeyboard(),
    );
    return;
  }
  await renderScreen(ctx, 'MiniStore — choose an action:', getHomeKeyboard(telegramId));
}

async function showBrowse(
  ctx: Context,
  folderId: string | null,
  page = 0,
  sort: BrowseSort = 'name',
): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId || !canAccessStore(telegramId)) {
    await renderScreen(ctx, 'You do not have access to MiniStore.', new InlineKeyboard());
    return;
  }

  const folder = folderId ? index.getFolder(folderId) : undefined;
  if (folderId && (!folder || folder.isDeleted)) {
    await renderScreen(ctx, 'That folder is no longer available.', getHomeKeyboard(telegramId));
    return;
  }

  const childFolders = folderId ? index.getChildFolders(folderId) : index.getRootFolders();
  const resources = index
    .getResources()
    .filter((resource) => !resource.isDeleted && resource.folderId === folderId);
  const entries = [
    ...childFolders.map((item) => ({
      kind: 'folder' as const,
      id: item.id,
      name: item.name,
      createdAt: item.createdAt,
    })),
    ...resources.map((item) => ({
      kind: 'resource' as const,
      id: item.id,
      name: item.title,
      createdAt: item.createdAt,
    })),
  ];
  entries.sort((left, right) =>
    sort === 'recent'
      ? right.createdAt.localeCompare(left.createdAt) || left.name.localeCompare(right.name)
      : left.name.localeCompare(right.name),
  );
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
  const requestedPage = Number.isSafeInteger(page) ? page : 0;
  const safePage = Math.min(Math.max(0, requestedPage), pageCount - 1);
  const pageEntries = entries.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const keyboard = new InlineKeyboard();

  for (const entry of pageEntries) {
    const label = `${entry.kind === 'folder' ? '📁' : '📄'} ${entry.name}`.slice(0, 60);
    keyboard
      .text(
        label,
        entry.kind === 'folder'
          ? `lib:browse:${entry.id.slice('folder:'.length)}`
          : `lib:resource:${entry.id.slice('resource:'.length)}`,
      )
      .row();
  }
  const folderToken = folderId?.slice('folder:'.length) || 'root';
  keyboard.text(
    sort === 'name' ? 'Sort: Name' : 'Sort: Newest',
    `lib:sort:${folderToken}:${sort === 'name' ? 'recent' : 'name'}`,
  );
  if (folderId) {
    keyboard.text(
      '⬆️ Up one folder',
      `lib:browse:${folder?.parentId?.slice('folder:'.length) || 'root'}`,
    );
  }
  keyboard.row();
  if (safePage > 0) keyboard.text('‹ Previous', `lib:page:${folderToken}:${safePage - 1}:${sort}`);
  if (safePage + 1 < pageCount)
    keyboard.text('Next ›', `lib:page:${folderToken}:${safePage + 1}:${sort}`);
  if (safePage > 0 || safePage + 1 < pageCount) keyboard.row();
  if (hasPermission(telegramId, 'upload_resources')) {
    keyboard.text('📤 Upload here', `lib:upload:${folderToken}`);
  }
  if (hasPermission(telegramId, 'manage_folders')) {
    keyboard.text('➕ New folder', `lib:folder-create:${folderToken}`);
  }
  if (
    hasPermission(telegramId, 'upload_resources') ||
    hasPermission(telegramId, 'manage_folders')
  ) {
    keyboard.row();
  }
  addBackButton(keyboard);

  const title = folder ? `📁 ${folder.name}` : '📂 MiniStore files';
  const text = entries.length
    ? `${title}\n${entries.length} item${entries.length === 1 ? '' : 's'}${pageCount > 1 ? ` · page ${safePage + 1}/${pageCount}` : ''}`
    : `${title}\nThis folder is empty.`;
  await renderScreen(ctx, text, keyboard);
}

async function showResource(
  ctx: Context,
  resourceId: string,
  back = 'lib:browse:root',
  versionPage = 0,
): Promise<void> {
  const telegramId = ctx.from?.id;
  const resource = getResource(resourceId);
  if (!telegramId || !canAccessStore(telegramId) || !resource || resource.isDeleted) {
    await renderScreen(ctx, 'This file is unavailable.', getHomeKeyboard(telegramId ?? 0));
    return;
  }

  const resourceToken = resource.id.slice('resource:'.length);
  const keyboard = new InlineKeyboard().text('⬇️ Download', `lib:download:${resourceToken}`).row();
  const previousVersions = getResourceVersions(resource.id).filter(
    (version) => version.version !== resource.version,
  );
  const versionPageSize = 5;
  const versionPageCount = Math.ceil(previousVersions.length / versionPageSize);
  const safeVersionPage = Math.min(Math.max(0, versionPage), Math.max(0, versionPageCount - 1));
  for (const version of previousVersions.slice(
    safeVersionPage * versionPageSize,
    (safeVersionPage + 1) * versionPageSize,
  )) {
    keyboard
      .text(
        `⬇️ v${version.version} · ${version.fileName}`.slice(0, 60),
        `lib:download-version:${resourceToken}:${version.version}`,
      )
      .row();
  }
  if (versionPageCount > 1) {
    if (safeVersionPage > 0) {
      keyboard.text('‹ Older', `lib:version-page:${resourceToken}:${safeVersionPage - 1}`);
    }
    if (safeVersionPage + 1 < versionPageCount) {
      keyboard.text('Newer ›', `lib:version-page:${resourceToken}:${safeVersionPage + 1}`);
    }
    keyboard.row();
  }
  const isFavorite = getUserById(telegramId)?.favorites.includes(resource.id) ?? false;
  keyboard
    .text(isFavorite ? '⭐ Remove favorite' : '☆ Add favorite', `lib:favorite:${resourceToken}`)
    .row();
  if (hasPermission(telegramId, 'upload_resources')) {
    keyboard
      .row()
      .text('🔁 Upload new version', `lib:version:${resourceToken}`)
      .text('✏️ Edit metadata', `lib:resource-edit:${resourceToken}`);
  }
  if (hasPermission(telegramId, 'delete_resources')) {
    keyboard.row().text('🗑️ Move to recycle bin', `lib:resource-delete:${resourceToken}`);
  }
  keyboard.row().text('← Back to files', back);

  const size = formatFileSize(resource.fileSize);
  const text =
    `📄 ${resource.title}\n${resource.description ? `\n${resource.description}\n` : '\n'}Type: ${resource.fileType}\nSize: ${size}\nVersion: ${resource.version} · Downloads: ${resource.downloadCount}${resource.categoryId ? `\nCategory: ${resource.categoryId}` : ''}${resource.tags.length ? `\nTags: ${resource.tags.join(', ')}` : ''}`.slice(
      0,
      4000,
    );
  await renderScreen(ctx, text, keyboard);
}

async function showSearchResults(ctx: Context, query: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId || !canAccessStore(telegramId)) return;
  const results = searchResources(query).slice(0, 20);
  const keyboard = new InlineKeyboard();
  for (const resource of results) {
    keyboard
      .text(
        `📄 ${resource.title}`.slice(0, 60),
        `lib:resource:${resource.id.slice('resource:'.length)}`,
      )
      .row();
  }
  keyboard.text('🔍 Search again', 'lib:search');
  addBackButton(keyboard);
  await renderScreen(
    ctx,
    results.length
      ? `Search: ${query}\n${results.length} result${results.length === 1 ? '' : 's'}${results.length === 20 ? ' (showing first 20)' : ''}`
      : `No files found for "${query}".`,
    keyboard,
  );
}

async function showFavorites(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId || !canAccessStore(telegramId)) return;
  const favorites = (getUserById(telegramId)?.favorites ?? [])
    .map((id) => getResource(id))
    .filter((resource) => resource && !resource.isDeleted);
  const keyboard = new InlineKeyboard();
  for (const resource of favorites) {
    if (resource)
      keyboard
        .text(
          `⭐ ${resource.title}`.slice(0, 60),
          `lib:resource:${resource.id.slice('resource:'.length)}`,
        )
        .row();
  }
  addBackButton(keyboard);
  await renderScreen(
    ctx,
    favorites.length ? `⭐ Favorites (${favorites.length})` : 'You have no saved favorites yet.',
    keyboard,
  );
}

async function promptForText(ctx: Context, action: TextAction, message: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  textActionState.set(telegramId, action);
  await ctx.reply(message, {
    reply_markup: new InlineKeyboard().text('Cancel', 'lib:cancel'),
  });
}

async function showAdminResources(ctx: Context, page = 0): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId || !isAdminUser(telegramId)) return;
  const resources = getAllResources();
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(resources.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const keyboard = new InlineKeyboard();
  for (const resource of resources.slice(safePage * pageSize, (safePage + 1) * pageSize)) {
    keyboard
      .text(
        `📄 ${resource.title}`.slice(0, 60),
        `lib:resource:${resource.id.slice('resource:'.length)}`,
      )
      .row();
  }
  if (safePage > 0) keyboard.text('‹ Previous', `admin:resources:${safePage - 1}`);
  if (safePage + 1 < pageCount) keyboard.text('Next ›', `admin:resources:${safePage + 1}`);
  if (safePage > 0 || safePage + 1 < pageCount) keyboard.row();
  if (hasPermission(telegramId, 'upload_resources')) {
    keyboard.text('📤 Upload to root', 'lib:upload:root').text('← Admin menu', 'admin:back');
  } else {
    keyboard.text('← Admin menu', 'admin:back');
  }
  await renderScreen(
    ctx,
    resources.length
      ? `📄 Resources (${resources.length})${pageCount > 1 ? ` · page ${safePage + 1}/${pageCount}` : ''}\nChoose a file to view actions.`
      : 'There are no active resources.',
    keyboard,
  );
}

async function showAdminFolders(ctx: Context, page = 0): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId || !hasPermission(telegramId, 'manage_folders')) return;
  const folders = index.getFolders().filter((folder) => !folder.isDeleted);
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(folders.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const keyboard = new InlineKeyboard();
  for (const folder of folders.slice(safePage * pageSize, (safePage + 1) * pageSize)) {
    keyboard
      .text(`📁 ${folder.name}`.slice(0, 60), `lib:folder:${folder.id.slice('folder:'.length)}`)
      .row();
  }
  if (safePage > 0) keyboard.text('‹ Previous', `admin:folders:${safePage - 1}`);
  if (safePage + 1 < pageCount) keyboard.text('Next ›', `admin:folders:${safePage + 1}`);
  if (safePage > 0 || safePage + 1 < pageCount) keyboard.row();
  keyboard.text('➕ New root folder', 'lib:folder-create:root').text('← Admin menu', 'admin:back');
  await renderScreen(
    ctx,
    folders.length
      ? `📁 Folders (${folders.length})${pageCount > 1 ? ` · page ${safePage + 1}/${pageCount}` : ''}`
      : 'There are no folders yet.',
    keyboard,
  );
}

async function showAdminFolder(ctx: Context, folderId: string): Promise<void> {
  const telegramId = ctx.from?.id;
  const folder = index.getFolder(folderId);
  if (!telegramId || !hasPermission(telegramId, 'manage_folders') || !folder || folder.isDeleted) {
    await renderScreen(
      ctx,
      'This folder is unavailable.',
      new InlineKeyboard().text('← Folders', 'admin:folders'),
    );
    return;
  }
  const children = index.getChildFolders(folderId);
  const resources = index
    .getResources()
    .filter((resource) => resource.folderId === folderId && !resource.isDeleted);
  const keyboard = new InlineKeyboard()
    .text('📂 Browse contents', `lib:browse:${folder.id.slice('folder:'.length)}`)
    .row()
    .text('➕ Add subfolder', `lib:folder-create:${folder.id.slice('folder:'.length)}`)
    .text('✏️ Rename', `lib:folder-rename:${folder.id.slice('folder:'.length)}`)
    .row()
    .text('↔️ Move folder', `lib:folder-move:${folder.id.slice('folder:'.length)}`);
  if (hasPermission(telegramId, 'delete_resources')) {
    keyboard.text('🗑️ Delete', `lib:folder-delete:${folder.id.slice('folder:'.length)}`);
  }
  keyboard.row().text('← Folders', 'admin:folders').text('Admin menu', 'admin:back');
  await renderScreen(
    ctx,
    `📁 ${folder.name}\n${children.length} subfolder${children.length === 1 ? '' : 's'} · ${resources.length} file${resources.length === 1 ? '' : 's'}`,
    keyboard,
  );
}

async function showRecycleBin(ctx: Context, page = 0): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId || !hasPermission(telegramId, 'delete_resources')) return;
  const resources = getDeletedResources().filter(
    (resource) => !resource.folderId || !index.getFolder(resource.folderId)?.isDeleted,
  );
  const folders = hasPermission(telegramId, 'manage_folders') ? getDeletedFolders() : [];
  const entries = [
    ...folders.map((folder) => ({ kind: 'folder' as const, id: folder.id, name: folder.name })),
    ...resources.map((resource) => ({
      kind: 'resource' as const,
      id: resource.id,
      name: resource.title,
    })),
  ];
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const keyboard = new InlineKeyboard();
  for (const entry of entries.slice(safePage * pageSize, (safePage + 1) * pageSize)) {
    const isFolder = entry.kind === 'folder';
    const token = entry.id.slice(isFolder ? 'folder:'.length : 'resource:'.length);
    keyboard
      .text(
        `${isFolder ? '📁' : '📄'} ${entry.name}`.slice(0, 45),
        `lib:trash-${entry.kind}:${token}`,
      )
      .text('Restore', `lib:restore-${entry.kind}:${token}`)
      .row();
  }
  if (safePage > 0) keyboard.text('‹ Previous', `admin:recycle:${safePage - 1}`);
  if (safePage + 1 < pageCount) keyboard.text('Next ›', `admin:recycle:${safePage + 1}`);
  if (safePage > 0 || safePage + 1 < pageCount) keyboard.row();
  keyboard.text('← Admin menu', 'admin:back');
  await renderScreen(
    ctx,
    entries.length
      ? `🗑️ Recycle Bin\n${folders.length} folder tree${folders.length === 1 ? '' : 's'} · ${resources.length} deleted file${resources.length === 1 ? '' : 's'}${pageCount > 1 ? ` · page ${safePage + 1}/${pageCount}` : ''}`
      : 'Recycle Bin is empty.',
    keyboard,
  );
}

async function showAdminUsers(ctx: Context, page = 0): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId || !hasPermission(telegramId, 'manage_users')) return;
  const users = getAllUsers().filter((user) => user.telegramId !== config.ownerId);
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(users.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const keyboard = new InlineKeyboard();
  for (const target of users.slice(safePage * pageSize, (safePage + 1) * pageSize)) {
    const name = target.firstName || target.username || String(target.telegramId);
    keyboard
      .text(
        `${target.role === 'pending' ? '⏳' : '👤'} ${name}`.slice(0, 55),
        `lib:user:${target.telegramId}`,
      )
      .row();
  }
  if (safePage > 0) keyboard.text('‹ Previous', `admin:users:${safePage - 1}`);
  if (safePage + 1 < pageCount) keyboard.text('Next ›', `admin:users:${safePage + 1}`);
  if (safePage > 0 || safePage + 1 < pageCount) keyboard.row();
  keyboard.text('⏳ Pending requests', 'admin:requests').text('← Admin menu', 'admin:back');
  await renderScreen(
    ctx,
    `👥 Users (${users.length})${pageCount > 1 ? ` · page ${safePage + 1}/${pageCount}` : ''}`,
    keyboard,
  );
}

async function showAssistantUsageOverview(ctx: Context, page = 0): Promise<void> {
  const ownerId = ctx.from?.id;
  if (ownerId !== config.ownerId) {
    await ctx.reply('❌ Only the owner can view all-user assistant usage.');
    return;
  }

  const overview = getAssistantUsageOverview(ownerId);
  const pageSize = 6;
  const pageCount = Math.max(1, Math.ceil(overview.entries.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const entries = overview.entries.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const lines = entries.map((entry) => {
    const name = entry.name.length > 32 ? `${entry.name.slice(0, 31)}…` : entry.name;
    const identity = `${name} · ${entry.role} (${entry.status})`;
    if (!entry.usage) return identity;
    const reset = entry.usage.resetsAt
      ? ` · next ${entry.usage.resetsAt.toISOString().slice(11, 16)} UTC`
      : '';
    return `${identity}: ${entry.usage.used}/${entry.usage.limit} · ${entry.usage.remaining} left${reset}`;
  });
  const keyboard = new InlineKeyboard();
  if (safePage > 0) keyboard.text('‹ Previous', `admin:usage:${safePage - 1}`);
  if (safePage + 1 < pageCount) keyboard.text('Next ›', `admin:usage:${safePage + 1}`);
  if (safePage > 0 || safePage + 1 < pageCount) keyboard.row();
  keyboard.text('← Admin menu', 'admin:back');

  const summary =
    `📊 Assistant usage · ${overview.totalUsers} accounts\n` +
    `Active users: ${overview.activeUsers} · Active admins: ${overview.activeAdmins}\n` +
    `Pending: ${overview.pendingUsers} · Suspended: ${overview.suspendedUsers} · Blocked: ${overview.blockedUsers}` +
    (pageCount > 1 ? ` · page ${safePage + 1}/${pageCount}` : '');
  await renderScreen(
    ctx,
    `${summary}\n\n${lines.length ? lines.join('\n') : 'No user accounts to show.'}`,
    keyboard,
  );
}

async function showAdminUser(ctx: Context, targetId: number): Promise<void> {
  const actorId = ctx.from?.id;
  const target = getUserById(targetId);
  if (!actorId || !hasPermission(actorId, 'manage_users')) return;
  if (!target) {
    await renderScreen(
      ctx,
      'This user is no longer available.',
      new InlineKeyboard().text('← Users', 'admin:users').text('Admin menu', 'admin:back'),
    );
    return;
  }
  const name =
    [target.firstName, target.lastName].filter(Boolean).join(' ') ||
    target.username ||
    String(targetId);
  const keyboard = new InlineKeyboard();
  if (target.role === 'pending') {
    keyboard
      .text('✅ Approve', `approve:${targetId}`)
      .text('❌ Reject', `reject:${targetId}`)
      .row();
  }
  if (actorId === config.ownerId && target.role === 'user' && target.status === 'active') {
    keyboard.text('⬆️ Promote to admin', `lib:user-action:promote:${targetId}`).row();
  }
  if (actorId === config.ownerId && target.role === 'admin') {
    keyboard
      .text('⬇️ Demote', `lib:user-action:demote:${targetId}`)
      .text('🔑 Permissions', `lib:permissions:${targetId}`)
      .row();
  }
  if (actorId === config.ownerId && target.role !== 'owner' && target.status === 'active') {
    keyboard
      .text('⏸️ Suspend', `lib:user-action:suspend:${targetId}`)
      .text('🚫 Block', `lib:user-action:block:${targetId}`)
      .row();
  } else if (actorId === config.ownerId && ['suspended', 'blocked'].includes(target.status)) {
    keyboard.text('✅ Reactivate', `lib:user-action:unblock:${targetId}`).row();
  }
  keyboard.text('← Users', 'admin:users').text('Admin menu', 'admin:back');
  await renderScreen(ctx, `${name}\nRole: ${target.role} · Status: ${target.status}`, keyboard);
}

async function showAdminPermissions(ctx: Context, targetId: number): Promise<void> {
  const actorId = ctx.from?.id;
  const target = getUserById(targetId);
  if (actorId !== config.ownerId) return;
  if (!target || target.role !== 'admin') {
    await renderScreen(
      ctx,
      'This admin is no longer available.',
      new InlineKeyboard().text('← Users', 'admin:users'),
    );
    return;
  }
  const keyboard = new InlineKeyboard();
  for (const permission of AVAILABLE_PERMISSIONS) {
    const enabled = target.permissions.includes(permission);
    keyboard
      .text(
        `${enabled ? '✅' : '⬜'} ${permission.replaceAll('_', ' ')}`,
        `lib:permission:${targetId}:${permission}`,
      )
      .row();
  }
  keyboard.text('← User', `lib:user:${targetId}`);
  await renderScreen(
    ctx,
    `🔑 Permissions for ${target.firstName || target.username || targetId}\nTap to toggle a permission.`,
    keyboard,
  );
}

async function showAuditLogs(ctx: Context, page = 0): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId || !hasPermission(telegramId, 'view_audit_logs')) return;
  const records = index
    .getAudits()
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(records.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const pageRecords = records.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const keyboard = new InlineKeyboard();
  if (safePage > 0) keyboard.text('‹ Previous', `admin:audit:${safePage - 1}`);
  if (safePage + 1 < pageCount) keyboard.text('Next ›', `admin:audit:${safePage + 1}`);
  if (safePage > 0 || safePage + 1 < pageCount) keyboard.row();
  keyboard.text('← Admin menu', 'admin:back');
  const lines = pageRecords.map(
    (record) =>
      `${new Date(record.timestamp).toLocaleString()} · ${record.action} · ${record.targetId}`,
  );
  await renderScreen(
    ctx,
    lines.length
      ? `📋 Recent activity${pageCount > 1 ? ` · page ${safePage + 1}/${pageCount}` : ''}\n\n${lines.join('\n')}`
      : 'No activity recorded yet.',
    keyboard,
  );
}

function getAdminKeyboard(telegramId: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const canManageUsers = hasPermission(telegramId, 'manage_users');
  const canManageResources =
    hasPermission(telegramId, 'upload_resources') || hasPermission(telegramId, 'delete_resources');
  const canManageFolders = hasPermission(telegramId, 'manage_folders');
  const canDeleteResources = hasPermission(telegramId, 'delete_resources');
  const canViewAudit = hasPermission(telegramId, 'view_audit_logs');

  if (canManageUsers) {
    keyboard.text('👥 Users', 'admin:users').text('⏳ Requests', 'admin:requests').row();
  }
  if (canManageResources) keyboard.text('📄 Resources', 'admin:resources');
  if (canManageFolders) keyboard.text('📁 Folders', 'admin:folders');
  if (canManageResources || canManageFolders) keyboard.row();
  if (canDeleteResources) keyboard.text('🗑️ Recycle Bin', 'admin:recycle');
  if (canViewAudit) keyboard.text('📋 Audit Logs', 'admin:audit');
  if (canDeleteResources || canViewAudit) keyboard.row();
  if (telegramId === config.ownerId) {
    keyboard.text('📊 AI usage overview', 'admin:usage').row();
  }
  keyboard.text('← Store', 'lib:home');
  return keyboard;
}

async function showPendingRequests(ctx: Context, page = 0): Promise<void> {
  const pending = getPendingRequests();
  const pageSize = 5;
  const pageCount = Math.max(1, Math.ceil(pending.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  if (pending.length === 0) {
    await renderScreen(
      ctx,
      'No pending access requests.',
      new InlineKeyboard().text('← Back', 'admin:back'),
    );
    return;
  }

  const requests = pending.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const keyboard = requests.map((requestedUser) => {
    const name =
      [requestedUser.firstName, requestedUser.lastName].filter(Boolean).join(' ').trim() ||
      requestedUser.username ||
      `ID:${requestedUser.telegramId}`;
    const buttonName = name.replace(/\p{Cc}/gu, ' ').slice(0, 30);
    return [
      { text: `Approve ${buttonName}`, callback_data: `approve:${requestedUser.telegramId}` },
      { text: `Reject ${buttonName}`, callback_data: `reject:${requestedUser.telegramId}` },
    ];
  });
  const inlineKeyboard = new InlineKeyboard();
  for (const row of keyboard)
    inlineKeyboard
      .text(row[0].text, row[0].callback_data)
      .text(row[1].text, row[1].callback_data)
      .row();
  if (safePage > 0) inlineKeyboard.text('‹ Previous', `admin:requests:${safePage - 1}`);
  if (safePage + 1 < pageCount) inlineKeyboard.text('Next ›', `admin:requests:${safePage + 1}`);
  if (safePage > 0 || safePage + 1 < pageCount) inlineKeyboard.row();
  inlineKeyboard.text('← Back', 'admin:back');
  await renderScreen(
    ctx,
    `Pending access requests (${pending.length})${pageCount > 1 ? ` · page ${safePage + 1}/${pageCount}` : ''}`,
    inlineKeyboard,
  );
}

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

/**
 * Inline store and admin actions.
 */
bot.on('callback_query:data', async (ctx, next) => {
  const data = ctx.callbackQuery.data;
  const user = ctx.from;
  if (!user) return next();

  const isLibraryAction = data.startsWith('lib:');
  const isAdminLibraryAction =
    data === 'admin:home' ||
    data === 'admin:requests' ||
    data.startsWith('admin:requests:') ||
    data === 'admin:resources' ||
    data.startsWith('admin:resources:') ||
    data === 'admin:folders' ||
    data.startsWith('admin:folders:') ||
    data === 'admin:recycle' ||
    data.startsWith('admin:recycle:') ||
    data === 'admin:audit' ||
    data.startsWith('admin:audit:') ||
    data === 'admin:usage' ||
    data.startsWith('admin:usage:') ||
    data === 'admin:users' ||
    data.startsWith('admin:users:');
  if (!isLibraryAction && !isAdminLibraryAction) return next();

  await ctx.answerCallbackQuery();

  if (isAdminLibraryAction && !isAdminUser(user.id)) {
    await ctx.reply('❌ You do not have permission to use admin tools.');
    return;
  }
  if (isLibraryAction && !canAccessStore(user.id) && data !== 'lib:noop') {
    await ctx.reply('❌ Your account does not have access to MiniStore.');
    return;
  }

  if (data === 'lib:noop') return;
  if (data === 'lib:home') return showHome(ctx);
  if (data === 'lib:browse:root') return showBrowse(ctx, null);
  if (data === 'lib:search') {
    return promptForText(ctx, { type: 'search' }, 'Send a search phrase to find files.');
  }
  if (data === 'lib:favorites') return showFavorites(ctx);
  if (data === 'lib:profile') {
    const account = getUserById(user.id);
    const displayName =
      [account?.firstName, account?.lastName].filter(Boolean).join(' ') ||
      account?.username ||
      String(user.id);
    const keyboard = new InlineKeyboard()
      .text('📂 Browse files', 'lib:browse:root')
      .text('⭐ Favorites', 'lib:favorites')
      .row();
    if (isAdminUser(user.id)) {
      keyboard.text('⚙️ Admin tools', 'admin:home').text('← Menu', 'lib:home');
    } else {
      keyboard.text('← Menu', 'lib:home');
    }
    return renderScreen(
      ctx,
      `${displayName}\nRole: ${account?.role || (user.id === config.ownerId ? 'owner' : 'user')}\nStatus: ${account?.status || 'active'}\nTelegram ID: ${user.id}`,
      keyboard,
    );
  }

  if (data.startsWith('lib:browse:')) {
    const target = data.slice('lib:browse:'.length);
    return showBrowse(ctx, target === 'root' ? null : folderIdFromToken(target));
  }
  if (data.startsWith('lib:page:')) {
    const [, , target, pageText, sortText] = data.split(':');
    return showBrowse(
      ctx,
      target === 'root' ? null : folderIdFromToken(target),
      Number(pageText || 0),
      sortText === 'recent' ? 'recent' : 'name',
    );
  }
  if (data.startsWith('lib:sort:')) {
    const [, , target, sortText] = data.split(':');
    return showBrowse(
      ctx,
      target === 'root' ? null : folderIdFromToken(target),
      0,
      sortText === 'recent' ? 'recent' : 'name',
    );
  }
  if (data.startsWith('lib:resource:')) {
    return showResource(ctx, resourceIdFromToken(data.slice('lib:resource:'.length)));
  }
  if (data.startsWith('lib:download:')) {
    const resourceId = resourceIdFromToken(data.slice('lib:download:'.length));
    const resource = getResource(resourceId);
    if (!resource || resource.isDeleted || !ctx.chat) {
      return renderScreen(
        ctx,
        'This file is unavailable.',
        new InlineKeyboard().text('← Menu', 'lib:home'),
      );
    }
    await ctx.api.copyMessage(ctx.chat.id, config.storageChannelId, resource.storageMessageId);
    await trackDownload(resource.id);
    return;
  }
  if (data.startsWith('lib:download-version:')) {
    const [, , resourceToken, versionText] = data.split(':');
    const resourceId = resourceIdFromToken(resourceToken);
    const resource = getResource(resourceId);
    const versionNumber = Number(versionText);
    const version = Number.isSafeInteger(versionNumber)
      ? getResourceVersion(resourceId, versionNumber)
      : undefined;
    if (!resource || resource.isDeleted || !version || !ctx.chat) {
      return ctx.reply('This file version is unavailable.', {
        reply_markup: new InlineKeyboard().text(
          '← File details',
          `lib:resource:${resourceId.slice('resource:'.length)}`,
        ),
      });
    }
    await ctx.api.copyMessage(ctx.chat.id, config.storageChannelId, version.storageMessageId);
    await trackDownload(resource.id);
    return;
  }
  if (data.startsWith('lib:version-page:')) {
    const [, , resourceToken, pageText] = data.split(':');
    return showResource(ctx, resourceIdFromToken(resourceToken), undefined, Number(pageText || 0));
  }
  if (data.startsWith('lib:favorite:')) {
    const resourceId = resourceIdFromToken(data.slice('lib:favorite:'.length));
    const isFavorite = getUserById(user.id)?.favorites.includes(resourceId) ?? false;
    if (isFavorite) await removeFavorite(user.id, resourceId);
    else await addFavorite(user.id, resourceId);
    return showResource(ctx, resourceId);
  }
  if (data.startsWith('lib:upload:')) {
    const target = data.slice('lib:upload:'.length);
    if (!hasPermission(user.id, 'upload_resources'))
      return ctx.reply('You do not have permission to upload files.');
    return promptForUpload(ctx, user.id, {
      type: 'new',
      folderId: target === 'root' ? null : folderIdFromToken(target),
    });
  }
  if (data.startsWith('lib:version:')) {
    if (!hasPermission(user.id, 'upload_resources'))
      return ctx.reply('You do not have permission to upload versions.');
    const resourceId = resourceIdFromToken(data.slice('lib:version:'.length));
    return promptForUpload(ctx, user.id, { type: 'version', resourceId });
  }
  if (data.startsWith('lib:folder-create:')) {
    if (!hasPermission(user.id, 'manage_folders'))
      return ctx.reply('You do not have permission to manage folders.');
    const target = data.slice('lib:folder-create:'.length);
    return promptForText(
      ctx,
      { type: 'folder-create', parentId: target === 'root' ? null : folderIdFromToken(target) },
      'Send the new folder name.',
    );
  }
  if (data.startsWith('lib:folder-rename:')) {
    if (!hasPermission(user.id, 'manage_folders'))
      return ctx.reply('You do not have permission to manage folders.');
    const folderId = folderIdFromToken(data.slice('lib:folder-rename:'.length));
    const folder = index.getFolder(folderId);
    if (!folder || folder.isDeleted) return ctx.reply('That folder is no longer available.');
    return promptForText(
      ctx,
      { type: 'folder-rename', folderId },
      `Send a new name for "${folder.name}".`,
    );
  }
  if (data.startsWith('lib:folder:')) {
    return showAdminFolder(ctx, folderIdFromToken(data.slice('lib:folder:'.length)));
  }
  if (data.startsWith('lib:folder-move:')) {
    const folderId = folderIdFromToken(data.slice('lib:folder-move:'.length));
    const folder = index.getFolder(folderId);
    if (!folder || folder.isDeleted || !hasPermission(user.id, 'manage_folders')) return;
    const folderToken = folder.id.slice('folder:'.length);
    const keyboard = new InlineKeyboard()
      .text('Root', `lib:folder-move-to:${folderToken}|root`)
      .row();
    for (const target of index
      .getFolders()
      .filter((item) => !item.isDeleted && item.id !== folderId)
      .slice(0, 20)) {
      keyboard
        .text(
          `📁 ${target.name}`.slice(0, 50),
          `lib:folder-move-to:${folderToken}|${target.id.slice('folder:'.length)}`,
        )
        .row();
    }
    keyboard.text('Cancel', `lib:folder:${folderToken}`);
    return renderScreen(ctx, `Move "${folder.name}" to:`, keyboard);
  }
  if (data.startsWith('lib:folder-move-to:')) {
    if (!hasPermission(user.id, 'manage_folders'))
      return ctx.reply('You do not have permission to move folders.');
    const [folderId, target] = data.slice('lib:folder-move-to:'.length).split('|');
    if (!folderId || !target) return;
    await moveFolder(
      folderIdFromToken(folderId),
      target === 'root' ? null : folderIdFromToken(target),
      user.id,
    );
    return showAdminFolder(ctx, folderIdFromToken(folderId));
  }
  if (data.startsWith('lib:folder-delete:')) {
    if (!hasPermission(user.id, 'manage_folders') || !hasPermission(user.id, 'delete_resources')) {
      return ctx.reply('You do not have permission to delete folders.');
    }
    const folderId = folderIdFromToken(data.slice('lib:folder-delete:'.length));
    const folder = index.getFolder(folderId);
    if (!folder || folder.isDeleted) return;
    const keyboard = new InlineKeyboard()
      .text('Confirm delete', `lib:folder-delete-confirm:${folderId}`)
      .text('Cancel', `lib:folder:${folderId}`);
    return renderScreen(
      ctx,
      `Move "${folder.name}" and its contents to the recycle bin?`,
      keyboard,
    );
  }
  if (data.startsWith('lib:folder-delete-confirm:')) {
    if (!hasPermission(user.id, 'manage_folders') || !hasPermission(user.id, 'delete_resources')) {
      return ctx.reply('You do not have permission to delete folders.');
    }
    const folderId = folderIdFromToken(data.slice('lib:folder-delete-confirm:'.length));
    await deleteFolder(folderId, user.id);
    return showAdminFolders(ctx);
  }
  if (data.startsWith('lib:resource-rename:')) {
    if (!hasPermission(user.id, 'upload_resources'))
      return ctx.reply('You do not have permission to edit files.');
    const resourceId = resourceIdFromToken(data.slice('lib:resource-rename:'.length));
    const resource = getResource(resourceId);
    if (!resource || resource.isDeleted) return;
    return promptForText(
      ctx,
      { type: 'resource-rename', resourceId },
      `Send a new title for "${resource.title}".`,
    );
  }
  if (data.startsWith('lib:resource-edit:')) {
    if (!hasPermission(user.id, 'upload_resources')) {
      return ctx.reply('You do not have permission to edit file metadata.');
    }
    const resourceId = resourceIdFromToken(data.slice('lib:resource-edit:'.length));
    const resource = getResource(resourceId);
    if (!resource || resource.isDeleted) {
      return ctx.reply('That file is no longer available.', {
        reply_markup: new InlineKeyboard().text('← Resources', 'admin:resources'),
      });
    }
    const token = resource.id.slice('resource:'.length);
    const keyboard = new InlineKeyboard()
      .text('Title', `lib:resource-rename:${token}`)
      .text('Description', `lib:resource-description:${token}`)
      .row()
      .text('Tags', `lib:resource-tags:${token}`)
      .text('Category', `lib:resource-category:${token}`)
      .row()
      .text('← File details', `lib:resource:${token}`);
    return renderScreen(ctx, `Edit metadata for "${resource.title}"`, keyboard);
  }
  if (data.startsWith('lib:resource-description:')) {
    if (!hasPermission(user.id, 'upload_resources')) {
      return ctx.reply('You do not have permission to edit file metadata.');
    }
    const resourceId = resourceIdFromToken(data.slice('lib:resource-description:'.length));
    return promptForText(
      ctx,
      { type: 'resource-description', resourceId },
      'Send a description (up to 4000 characters), or send - to clear it.',
    );
  }
  if (data.startsWith('lib:resource-tags:')) {
    if (!hasPermission(user.id, 'upload_resources')) {
      return ctx.reply('You do not have permission to edit file metadata.');
    }
    const resourceId = resourceIdFromToken(data.slice('lib:resource-tags:'.length));
    return promptForText(
      ctx,
      { type: 'resource-tags', resourceId },
      'Send comma-separated tags (up to 20, each up to 100 characters), or send - to clear them.',
    );
  }
  if (data.startsWith('lib:resource-category:')) {
    if (!hasPermission(user.id, 'upload_resources')) {
      return ctx.reply('You do not have permission to edit file metadata.');
    }
    const resourceId = resourceIdFromToken(data.slice('lib:resource-category:'.length));
    return promptForText(
      ctx,
      { type: 'resource-category', resourceId },
      'Send a category label (up to 100 characters), or send - to clear it.',
    );
  }
  if (data.startsWith('lib:resource-delete:')) {
    if (!hasPermission(user.id, 'delete_resources'))
      return ctx.reply('You do not have permission to delete files.');
    const resourceId = resourceIdFromToken(data.slice('lib:resource-delete:'.length));
    const resource = getResource(resourceId);
    if (!resource || resource.isDeleted) return;
    const keyboard = new InlineKeyboard()
      .text('Confirm delete', `lib:resource-delete-confirm:${resourceId.slice('resource:'.length)}`)
      .text('Cancel', `lib:resource:${resourceId}`);
    return renderScreen(ctx, `Move "${resource.title}" to the recycle bin?`, keyboard);
  }
  if (data.startsWith('lib:resource-delete-confirm:')) {
    if (!hasPermission(user.id, 'delete_resources'))
      return ctx.reply('You do not have permission to delete files.');
    const resourceId = resourceIdFromToken(data.slice('lib:resource-delete-confirm:'.length));
    await deleteResource(resourceId, user.id);
    return showAdminResources(ctx);
  }
  if (data.startsWith('lib:trash-resource:')) {
    if (!hasPermission(user.id, 'delete_resources'))
      return ctx.reply('You do not have permission to manage the recycle bin.');
    const resourceId = resourceIdFromToken(data.slice('lib:trash-resource:'.length));
    const resource = getResource(resourceId);
    if (!resource?.isDeleted) return;
    const keyboard = new InlineKeyboard()
      .text('♻️ Restore', `lib:restore-resource:${resourceId.slice('resource:'.length)}`)
      .text('Delete permanently', `lib:purge-resource:${resourceId.slice('resource:'.length)}`)
      .row()
      .text('← Recycle bin', 'admin:recycle');
    return renderScreen(ctx, `📄 ${resource.title}\nDeleted ${resource.deletedAt || ''}`, keyboard);
  }
  if (data.startsWith('lib:restore-resource:')) {
    if (!hasPermission(user.id, 'delete_resources'))
      return ctx.reply('You do not have permission to restore files.');
    const resourceId = resourceIdFromToken(data.slice('lib:restore-resource:'.length));
    await restoreResource(resourceId, user.id);
    return showRecycleBin(ctx);
  }
  if (data.startsWith('lib:purge-resource:')) {
    if (!hasPermission(user.id, 'delete_resources'))
      return ctx.reply('You do not have permission to permanently delete files.');
    const resourceId = resourceIdFromToken(data.slice('lib:purge-resource:'.length));
    const keyboard = new InlineKeyboard()
      .text(
        'Confirm permanent delete',
        `lib:purge-resource-confirm:${resourceId.slice('resource:'.length)}`,
      )
      .row()
      .text('Cancel', `lib:trash-resource:${resourceId.slice('resource:'.length)}`);
    return renderScreen(
      ctx,
      'Permanently delete this file and its versions? This cannot be undone.',
      keyboard,
    );
  }
  if (data.startsWith('lib:purge-resource-confirm:')) {
    if (!hasPermission(user.id, 'delete_resources'))
      return ctx.reply('You do not have permission to permanently delete files.');
    const resourceId = resourceIdFromToken(data.slice('lib:purge-resource-confirm:'.length));
    await permanentDeleteResource(resourceId, user.id);
    return showRecycleBin(ctx);
  }
  if (data.startsWith('lib:trash-folder:')) {
    if (!hasPermission(user.id, 'delete_resources') || !hasPermission(user.id, 'manage_folders')) {
      return ctx.reply('You do not have permission to manage deleted folders.');
    }
    const folderId = folderIdFromToken(data.slice('lib:trash-folder:'.length));
    const folder = index.getFolder(folderId);
    if (!folder?.isDeleted) return;
    const keyboard = new InlineKeyboard()
      .text('♻️ Restore tree', `lib:restore-folder:${folderId.slice('folder:'.length)}`)
      .text('Delete permanently', `lib:purge-folder:${folderId.slice('folder:'.length)}`)
      .row()
      .text('← Recycle bin', 'admin:recycle');
    return renderScreen(ctx, `📁 ${folder.name}\nDeleted ${folder.deletedAt || ''}`, keyboard);
  }
  if (data.startsWith('lib:restore-folder:')) {
    if (!hasPermission(user.id, 'delete_resources') || !hasPermission(user.id, 'manage_folders')) {
      return ctx.reply('You do not have permission to restore folders.');
    }
    const folderId = folderIdFromToken(data.slice('lib:restore-folder:'.length));
    await restoreFolder(folderId, user.id);
    return showRecycleBin(ctx);
  }
  if (data.startsWith('lib:purge-folder:')) {
    if (!hasPermission(user.id, 'delete_resources') || !hasPermission(user.id, 'manage_folders')) {
      return ctx.reply('You do not have permission to permanently delete folders.');
    }
    const folderId = folderIdFromToken(data.slice('lib:purge-folder:'.length));
    const keyboard = new InlineKeyboard()
      .text(
        'Confirm permanent delete',
        `lib:purge-folder-confirm:${folderId.slice('folder:'.length)}`,
      )
      .row()
      .text('Cancel', `lib:trash-folder:${folderId.slice('folder:'.length)}`);
    return renderScreen(
      ctx,
      'Permanently delete this folder tree and all files in it? This cannot be undone.',
      keyboard,
    );
  }
  if (data.startsWith('lib:purge-folder-confirm:')) {
    if (!hasPermission(user.id, 'delete_resources') || !hasPermission(user.id, 'manage_folders')) {
      return ctx.reply('You do not have permission to permanently delete folders.');
    }
    const folderId = folderIdFromToken(data.slice('lib:purge-folder-confirm:'.length));
    await permanentDeleteFolder(folderId, user.id);
    return showRecycleBin(ctx);
  }
  if (data.startsWith('lib:user:')) {
    if (!hasPermission(user.id, 'manage_users'))
      return ctx.reply('You do not have permission to manage users.');
    return showAdminUser(ctx, Number(data.slice('lib:user:'.length)));
  }
  if (data.startsWith('lib:user-action:')) {
    const [, , action, targetValue] = data.split(':');
    const targetId = Number(targetValue);
    if (!Number.isSafeInteger(targetId)) return;
    if (user.id !== config.ownerId) return ctx.reply('Only the owner can change user roles.');
    if (action === 'promote') await promoteUser(targetId, 'admin', user.id);
    else if (action === 'demote') await demoteUser(targetId, 'user', user.id);
    else if (action === 'suspend') await suspendUser(targetId, user.id);
    else if (action === 'block') await blockUser(targetId, user.id);
    else if (action === 'unblock') await unblockUser(targetId, user.id);
    return showAdminUser(ctx, targetId);
  }
  if (data.startsWith('lib:permissions:')) {
    if (user.id !== config.ownerId)
      return ctx.reply('Only the owner can manage admin permissions.');
    return showAdminPermissions(ctx, Number(data.slice('lib:permissions:'.length)));
  }
  if (data.startsWith('lib:permission:')) {
    const [, , targetValue, permission] = data.split(':');
    const targetId = Number(targetValue);
    const target = getUserById(targetId);
    if (
      user.id !== config.ownerId ||
      !target ||
      !AVAILABLE_PERMISSIONS.includes(permission as (typeof AVAILABLE_PERMISSIONS)[number])
    )
      return;
    const permissions = target.permissions.includes(permission)
      ? target.permissions.filter((item) => item !== permission)
      : [...target.permissions, permission];
    await updateUserPermissions(targetId, permissions, user.id);
    return showAdminPermissions(ctx, targetId);
  }
  if (data === 'lib:cancel') {
    textActionState.delete(user.id);
    return showHome(ctx);
  }

  if (data === 'admin:home') {
    return renderScreen(ctx, '🔧 Admin tools — choose a section:', getAdminKeyboard(user.id));
  }
  if (data === 'admin:requests' || data.startsWith('admin:requests:')) {
    const page = Number(data.split(':')[2] || 0);
    if (!hasPermission(user.id, 'manage_users')) {
      return ctx.reply('You do not have permission to manage access requests.');
    }
    return showPendingRequests(ctx, page);
  }
  if (data === 'admin:resources' || data.startsWith('admin:resources:')) {
    const page = Number(data.split(':')[2] || 0);
    if (
      !hasPermission(user.id, 'upload_resources') &&
      !hasPermission(user.id, 'delete_resources')
    ) {
      return ctx.reply('You do not have permission to manage resources.');
    }
    return showAdminResources(ctx, page);
  }
  if (data === 'admin:folders' || data.startsWith('admin:folders:')) {
    const page = Number(data.split(':')[2] || 0);
    if (!hasPermission(user.id, 'manage_folders'))
      return ctx.reply('You do not have permission to manage folders.');
    return showAdminFolders(ctx, page);
  }
  if (data === 'admin:recycle' || data.startsWith('admin:recycle:')) {
    const page = Number(data.split(':')[2] || 0);
    return showRecycleBin(ctx, page);
  }
  if (data === 'admin:audit' || data.startsWith('admin:audit:')) {
    const page = Number(data.split(':')[2] || 0);
    return showAuditLogs(ctx, page);
  }
  if (data === 'admin:users' || data.startsWith('admin:users:')) {
    const page = Number(data.split(':')[2] || 0);
    return showAdminUsers(ctx, page);
  }
  if (data === 'admin:usage' || data.startsWith('admin:usage:')) {
    const page = Number(data.split(':')[2] || 0);
    return showAssistantUsageOverview(ctx, page);
  }
  return next();
});

/**
 * Callback query handler for admin actions.
 */
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
          inline_keyboard: [[{ text: 'View remaining requests', callback_data: 'admin:requests' }]],
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
        return replyWithAssistant(ctx, telegramId, value);
      case 'folder-create': {
        if (!hasPermission(telegramId, 'manage_folders')) {
          return ctx.reply('You do not have permission to manage folders.');
        }
        const folder = await createFolder(value, action.parentId, telegramId);
        await ctx.reply(`✅ Created folder "${folder.name}".`);
        return showBrowse(ctx, action.parentId);
      }
      case 'folder-rename': {
        if (!hasPermission(telegramId, 'manage_folders')) {
          return ctx.reply('You do not have permission to manage folders.');
        }
        const folder = await renameFolder(action.folderId, value, telegramId);
        await ctx.reply(`✅ Renamed folder to "${folder.name}".`);
        return showAdminFolder(ctx, folder.id);
      }
      case 'resource-rename': {
        if (!hasPermission(telegramId, 'upload_resources')) {
          return ctx.reply('You do not have permission to edit files.');
        }
        const resource = await updateResource(action.resourceId, { title: value }, telegramId);
        await ctx.reply(`✅ Renamed file to "${resource.title}".`);
        return showResource(ctx, resource.id);
      }
      case 'resource-description': {
        if (!hasPermission(telegramId, 'upload_resources')) {
          return ctx.reply('You do not have permission to edit files.');
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

// ==================== FILE UPLOAD HANDLER ====================

interface IncomingTelegramFile {
  mediaKind: TelegramMediaKind;
  fileId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
}

function normalizeTelegramFile(
  mediaKind: TelegramMediaKind,
  file: {
    file_id: string;
    file_name?: string;
    file_size?: number;
    mime_type?: string;
  },
  fallbackName: string,
  fallbackType: string,
): IncomingTelegramFile {
  return {
    mediaKind,
    fileId: file.file_id,
    fileName: file.file_name || fallbackName,
    fileSize: file.file_size || 0,
    fileType: file.mime_type || fallbackType,
  };
}

function getIncomingTelegramFile(
  message: Context['msg'] | undefined,
): IncomingTelegramFile | undefined {
  if (!message) return undefined;
  if ('document' in message && message.document) {
    return normalizeTelegramFile(
      'document',
      message.document,
      `file_${message.message_id}`,
      'application/octet-stream',
    );
  }
  if ('photo' in message && message.photo?.length) {
    const photo = message.photo[message.photo.length - 1];
    return normalizeTelegramFile('photo', photo, `photo_${message.message_id}.jpg`, 'image/jpeg');
  }
  if ('video' in message && message.video) {
    return normalizeTelegramFile(
      'video',
      message.video,
      `video_${message.message_id}.mp4`,
      'video/mp4',
    );
  }
  if ('audio' in message && message.audio) {
    return normalizeTelegramFile(
      'audio',
      message.audio,
      `audio_${message.message_id}`,
      'audio/mpeg',
    );
  }
  if ('animation' in message && message.animation) {
    return normalizeTelegramFile(
      'animation',
      message.animation,
      `animation_${message.message_id}.mp4`,
      'video/mp4',
    );
  }
  if ('voice' in message && message.voice) {
    return normalizeTelegramFile(
      'voice',
      message.voice,
      `voice_${message.message_id}.ogg`,
      'audio/ogg',
    );
  }
  if ('video_note' in message && message.video_note) {
    return normalizeTelegramFile(
      'video_note',
      message.video_note,
      `video_note_${message.message_id}.mp4`,
      'video/mp4',
    );
  }
  if ('sticker' in message && message.sticker) {
    const sticker = message.sticker;
    const extension = sticker.is_video ? 'webm' : sticker.is_animated ? 'tgs' : 'webp';
    const mimeType = sticker.is_video
      ? 'video/webm'
      : sticker.is_animated
        ? 'application/x-tgsticker'
        : 'image/webp';
    return normalizeTelegramFile(
      'sticker',
      sticker,
      `sticker_${message.message_id}.${extension}`,
      mimeType,
    );
  }
  return undefined;
}

async function handleTelegramFileUpload(ctx: Context): Promise<void> {
  const user = ctx.from;
  if (!user) return;

  const existingUser = getUserById(user.id);
  const isOwner = user.id === config.ownerId;
  if (!isOwner && (!existingUser || !hasPermission(user.id, 'upload_resources'))) {
    await ctx.reply('❌ You do not have permission to upload files.');
    return;
  }

  let uploadedFile: Awaited<ReturnType<typeof uploadTelegramMedia>> | undefined;
  let uploadCommitted = false;
  let versionResourceId: string | undefined;
  try {
    const file = getIncomingTelegramFile(ctx.msg);
    if (!file) {
      await ctx.reply('❌ Telegram did not provide a usable file. Please try sending it again.');
      return;
    }
    const { fileId, fileName, fileSize, fileType } = file;

    if (fileSize > 50 * 1024 * 1024) {
      await ctx.reply('❌ File size exceeds the 50 MB limit.');
      return;
    }

    const duplicate = checkDuplicateResource(fileId);
    if (duplicate) {
      await ctx.reply(`⚠️ This file has already been uploaded as "${duplicate.title}".`);
      return;
    }

    versionResourceId = uploadVersionState.get(user.id);
    if (versionResourceId) {
      const resource = index.getResource(versionResourceId);
      if (!resource || resource.isDeleted) {
        uploadVersionState.delete(user.id);
        await ctx.reply('That resource is no longer available. Return to MiniStore and try again.');
        return;
      }
    }

    const hasUploadSession = uploadFolderState.has(user.id);
    const selectedFolderId = uploadFolderState.get(user.id) || null;
    if (
      selectedFolderId &&
      (!index.getFolder(selectedFolderId) || index.getFolder(selectedFolderId)?.isDeleted)
    ) {
      uploadFolderState.delete(user.id);
      await ctx.reply('That upload folder is no longer available. Start a new upload from /store.');
      return;
    }
    const targetName = versionResourceId
      ? index.getResource(versionResourceId)?.title || 'existing file'
      : selectedFolderId
        ? index.getFolder(selectedFolderId)?.name || 'selected folder'
        : 'Root';

    await ctx.reply(`📥 Received "${fileName}". Uploading to ${targetName}...`);

    const fileInfo = await uploadTelegramMedia(
      file.mediaKind,
      fileId,
      fileName,
      fileSize,
      fileType,
    );
    uploadedFile = fileInfo;
    if (versionResourceId) {
      const resource = await createResourceVersion(
        versionResourceId,
        {
          fileName: fileInfo.fileName,
          fileType: fileInfo.mimeType,
          fileSize: fileInfo.fileSize || fileSize,
          storageMessageId: fileInfo.messageId,
          storageFileId: fileInfo.fileId,
        },
        user.id,
      );
      uploadCommitted = true;
      uploadVersionState.delete(user.id);
      uploadFolderState.delete(user.id);
      await ctx.reply(`✅ Version ${resource.version} uploaded for "${resource.title}".`);
      return;
    }

    const resource = await createResource(
      fileInfo.fileName || fileName,
      '',
      [],
      fileInfo.mimeType || fileType,
      fileInfo.fileSize || fileSize,
      selectedFolderId,
      fileInfo.messageId,
      fileInfo.fileId,
      user.id,
    );
    uploadCommitted = true;

    const folderName = selectedFolderId
      ? index.getFolder(selectedFolderId)?.name || 'Unknown'
      : 'Root';
    await ctx.reply(
      `✅ File uploaded\n\n` +
        `📄 ${resource.fileName || resource.title}\n` +
        `📦 ${formatFileSize(fileInfo.fileSize || fileSize)}\n` +
        `📁 ${folderName}\n` +
        `🆔 ${resource.id}` +
        (hasUploadSession ? '\n\nSend more files or tap Done to finish.' : ''),
      hasUploadSession
        ? {
            reply_markup: new InlineKeyboard()
              .text('✅ Done', 'upload:finish')
              .text('Cancel', 'upload:cancel'),
          }
        : undefined,
    );
  } catch (err) {
    logger.error({ err, userId: user.id, msg: 'Error handling file upload' });
    let linkedResource = false;
    if (uploadedFile && !uploadCommitted) {
      linkedResource = index
        .getResources()
        .some(
          (resource) =>
            resource.storageMessageId === uploadedFile?.messageId ||
            resource.storageFileId === uploadedFile?.fileId ||
            index
              .getResourceVersions(resource.id)
              .some(
                (version) =>
                  version.storageMessageId === uploadedFile?.messageId ||
                  version.storageFileId === uploadedFile?.fileId,
              ),
        );
      if (!linkedResource && !versionResourceId) {
        try {
          await deleteFile(uploadedFile.messageId);
        } catch (cleanupError) {
          logger.error({
            err: cleanupError,
            userId: user.id,
            messageId: uploadedFile.messageId,
            msg: 'Failed to remove an unregistered upload from the Storage Channel',
          });
        }
      }
    }

    if (uploadCommitted || linkedResource) {
      await ctx.reply(
        '⚠️ The file was saved, but its confirmation could not be completed. Check MiniStore before uploading it again.',
      );
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('already exists')) {
      await ctx.reply(`⚠️ ${message}`);
      return;
    }
    await ctx.reply(`❌ Failed to upload the file: ${message}`);
  }
}

/**
 * Handle incoming Telegram files and media as stored documents.
 * The selected destination determines whether this upload creates or versions a resource.
 * Without a pending action, new files are uploaded to root.
 */
bot.on(
  [
    'message:document',
    'message:photo',
    'message:video',
    'message:audio',
    'message:animation',
    'message:voice',
    'message:video_note',
    'message:sticker',
  ],
  handleTelegramFileUpload,
);

export { bot };
