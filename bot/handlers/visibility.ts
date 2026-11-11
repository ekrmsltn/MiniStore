import { Bot, Context, InlineKeyboard } from 'grammy';
import { getAllUsers } from '../services/users';
import { updateFolderVisibility } from '../services/folders';
import { updateResourceVisibility } from '../services/resources';
import { canManageFolderVisibility, canManageResourceVisibility } from '../services/visibility';
import { index } from '../telegram/index';
import type { Visibility } from '../models';
import { renderScreen } from './screens/shared';
import { showAdminFolder } from './screens/admin';
import { showResource } from './screens';

type VisibilityTarget = { type: 'resource' | 'folder'; id: string };
const customSelections = new Map<string, Set<number>>();
const CUSTOM_PAGE_SIZE = 8;

function getTarget(type: string, token: string): VisibilityTarget | undefined {
  if (type === 'resource')
    return { type, id: token.startsWith('resource:') ? token : `resource:${token}` };
  if (type === 'folder')
    return { type, id: token.startsWith('folder:') ? token : `folder:${token}` };
  return undefined;
}

function canManageTarget(telegramId: number, target: VisibilityTarget): boolean {
  if (target.type === 'resource') {
    const resource = index.getResource(target.id);
    return Boolean(
      resource && !resource.isDeleted && canManageResourceVisibility(telegramId, resource),
    );
  }
  const folder = index.getFolder(target.id);
  return Boolean(folder && !folder.isDeleted && canManageFolderVisibility(telegramId, folder));
}

function targetKey(telegramId: number, target: VisibilityTarget): string {
  return `${telegramId}:${target.type}:${target.id}`;
}

function targetDescription(target: VisibilityTarget): string {
  return target.type === 'resource' ? 'file' : 'folder';
}

async function showVisibilityMenu(ctx: Context, target: VisibilityTarget): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text(
      '🌐 Public',
      `visibility:set:${target.type}:${target.id.slice(target.type.length + 1)}:public`,
    )
    .text(
      '🔒 Private',
      `visibility:set:${target.type}:${target.id.slice(target.type.length + 1)}:private`,
    )
    .row()
    .text(
      '👥 Customize',
      `visibility:custom:${target.type}:${target.id.slice(target.type.length + 1)}:0`,
    );
  if (target.type === 'folder') {
    keyboard
      .row()
      .text(
        '↩️ Inherit from parent',
        `visibility:inherit:folder:${target.id.slice('folder:'.length)}`,
      );
  }
  keyboard
    .row()
    .text(
      'Cancel',
      target.type === 'resource'
        ? `lib:resource:${target.id.slice('resource:'.length)}`
        : `lib:folder:${target.id.slice('folder:'.length)}`,
    );
  await renderScreen(ctx, `Choose who can access this ${targetDescription(target)}:`, keyboard);
}

function getCustomAccounts() {
  return getAllUsers()
    .filter((user) => user.status === 'active' && (user.role === 'user' || user.role === 'admin'))
    .sort((left, right) =>
      (left.firstName || left.username || '').localeCompare(
        right.firstName || right.username || '',
      ),
    );
}

async function showCustomAccounts(
  ctx: Context,
  target: VisibilityTarget,
  page: number,
  selected: Set<number>,
): Promise<void> {
  const accounts = getCustomAccounts();
  const pageCount = Math.max(1, Math.ceil(accounts.length / CUSTOM_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const keyboard = new InlineKeyboard();
  for (const account of accounts.slice(
    safePage * CUSTOM_PAGE_SIZE,
    (safePage + 1) * CUSTOM_PAGE_SIZE,
  )) {
    const name =
      [account.firstName, account.lastName].filter(Boolean).join(' ') ||
      account.username ||
      String(account.telegramId);
    const token = target.id.slice(target.type.length + 1);
    keyboard
      .text(
        `${selected.has(account.telegramId) ? '✅' : '⬜'} ${name}`.slice(0, 55),
        `visibility:toggle:${target.type}:${token}:${safePage}:${account.telegramId}`,
      )
      .row();
  }
  if (safePage > 0) {
    keyboard.text(
      '‹ Previous',
      `visibility:custom:${target.type}:${target.id.slice(target.type.length + 1)}:${safePage - 1}`,
    );
  }
  if (safePage + 1 < pageCount) {
    keyboard.text(
      'Next ›',
      `visibility:custom:${target.type}:${target.id.slice(target.type.length + 1)}:${safePage + 1}`,
    );
  }
  if (safePage > 0 || safePage + 1 < pageCount) keyboard.row();
  keyboard
    .text(
      'Save selection',
      `visibility:save:${target.type}:${target.id.slice(target.type.length + 1)}`,
    )
    .text('Cancel', `visibility:open:${target.type}:${target.id.slice(target.type.length + 1)}`);
  const pageLabel = pageCount > 1 ? ` · page ${safePage + 1}/${pageCount}` : '';
  await renderScreen(
    ctx,
    `Select active approved accounts for this ${targetDescription(target)}. The owner always has access.${pageLabel}\nSelected: ${selected.size}`,
    keyboard,
  );
}

function getInitialSelection(target: VisibilityTarget): Set<number> {
  const current =
    target.type === 'resource'
      ? index.getResource(target.id)?.visibility
      : index.getFolder(target.id)?.visibility;
  return new Set(current?.mode === 'custom' ? current.userIds : []);
}

export function registerVisibilityHandlers(bot: Bot<Context>): void {
  bot.callbackQuery(/^visibility:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const actorId = ctx.from.id;
    const [, action, type, token, value, extra] = ctx.callbackQuery.data.split(':');
    const target = getTarget(type ?? '', token ?? '');
    if (!target) return ctx.reply('Invalid visibility action.');

    if (!canManageTarget(actorId, target)) {
      customSelections.delete(targetKey(actorId, target));
      return ctx.reply('You can no longer access or manage this item.');
    }

    if (action === 'open') return showVisibilityMenu(ctx, target);
    if (action === 'custom') {
      const key = targetKey(actorId, target);
      if (!customSelections.has(key)) customSelections.set(key, getInitialSelection(target));
      return showCustomAccounts(ctx, target, Number(value || 0), customSelections.get(key)!);
    }
    if (action === 'toggle') {
      const page = Number(value);
      const telegramId = Number(extra);
      const account = index.getUserByTelegramId(telegramId);
      if (
        !Number.isSafeInteger(page) ||
        !Number.isSafeInteger(telegramId) ||
        !account ||
        account.status !== 'active' ||
        (account.role !== 'user' && account.role !== 'admin')
      ) {
        return ctx.reply('Only active approved accounts can be selected.');
      }
      const key = targetKey(actorId, target);
      const selected = customSelections.get(key) ?? getInitialSelection(target);
      if (selected.has(telegramId)) selected.delete(telegramId);
      else if (selected.size < 200) selected.add(telegramId);
      else return ctx.reply('A customized audience can contain at most 200 accounts.');
      customSelections.set(key, selected);
      return showCustomAccounts(ctx, target, page, selected);
    }
    if (action === 'save') {
      const key = targetKey(actorId, target);
      const selection = customSelections.get(key);
      if (!selection) return showVisibilityMenu(ctx, target);
      const visibility: Visibility = { mode: 'custom', userIds: [...selection] };
      customSelections.delete(key);
      if (target.type === 'resource') {
        await updateResourceVisibility(target.id, visibility, actorId);
        return showResource(ctx, target.id);
      }
      await updateFolderVisibility(target.id, visibility, actorId);
      return showAdminFolder(ctx, target.id);
    }
    if (action === 'set') {
      if (value !== 'public' && value !== 'private') return ctx.reply('Invalid visibility mode.');
      const visibility: Visibility = { mode: value };
      if (target.type === 'resource') {
        await updateResourceVisibility(target.id, visibility, actorId);
        return showResource(ctx, target.id);
      }
      await updateFolderVisibility(target.id, visibility, actorId);
      return showAdminFolder(ctx, target.id);
    }
    if (action === 'inherit' && target.type === 'folder') {
      await updateFolderVisibility(target.id, undefined, actorId);
      return showAdminFolder(ctx, target.id);
    }
    return ctx.reply('Unknown visibility action.');
  });
}
