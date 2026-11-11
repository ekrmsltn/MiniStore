import { Context, GrammyError, InlineKeyboard } from 'grammy';
import logger from '../logger';
import { getResource } from '../services/resources';
import { canAccessResource } from '../services/visibility';
import {
  askAssistantWithResources,
  AssistantCancelledError,
  AssistantProviderError,
  AssistantUsageStatus,
  getAssistantConversationLength,
  getAssistantUsageStatus,
  prepareAssistantReply,
} from '../services/assistant';
import { ForbiddenError, RateLimitError, ValidationError } from '../errors';
import {
  assistantCancelHint,
  assistantFlowActive,
  assistantThinkingMessages,
  AssistantPromptMessage,
  rememberAssistantPrompt,
  textActionState,
} from './state';

export async function replyWithAssistant(
  ctx: Context,
  telegramId: number,
  question: string,
  promptMessageId?: number,
  revision?: AssistantPromptMessage,
): Promise<void> {
  const conversationPrefixLength =
    revision?.conversationPrefixLength ?? getAssistantConversationLength(telegramId);
  const thinkingMessage = await ctx.reply(`Thinking…\n\n${assistantCancelHint}`);
  if (ctx.chat) {
    assistantThinkingMessages.set(telegramId, {
      chatId: ctx.chat.id,
      messageId: thinkingMessage.message_id,
    });
  }
  try {
    let assistantReply: Awaited<ReturnType<typeof askAssistantWithResources>>;
    try {
      assistantReply = await askAssistantWithResources(
        telegramId,
        question,
        revision ? { conversationPrefixLength } : {},
      );
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
    const boundedAnswer =
      assistantReply.answer.length > 3_600
        ? `${assistantReply.answer.slice(0, 3_599)}…`
        : assistantReply.answer;
    const answer = `${boundedAnswer}\n\n${formatAssistantUsage(usage)}`;
    const sentMessage = revision
      ? await editAssistantReply(ctx, revision, answer, assistantReply.resourceIds)
      : await sendAssistantReply(ctx, answer, assistantReply.resourceIds, telegramId);
    const trackedPromptMessageId = promptMessageId ?? revision?.promptMessageId;
    if (trackedPromptMessageId !== undefined && ctx.chat) {
      rememberAssistantPrompt({
        userId: telegramId,
        chatId: ctx.chat.id,
        promptMessageId: trackedPromptMessageId,
        replyMessageId: sentMessage,
        conversationPrefixLength,
      });
    }
  } finally {
    await deleteAssistantThinkingMessage(ctx, telegramId, thinkingMessage.message_id);
  }
}

export function formatAssistantUsage(usage: AssistantUsageStatus): string {
  if (usage.role === 'owner') {
    return 'Assistant usage: unlimited for the configured owner.';
  }

  const reset = usage.resetsAt
    ? ` Your quota resets at ${usage.resetsAt.toISOString()} (UTC).`
    : '';
  return `Assistant usage (fixed 24-hour window): ${usage.used}/${usage.limit} used; ${usage.remaining} remaining.${reset}`;
}

function getAssistantResourceKeyboard(
  resourceIds: string[],
  telegramId: number,
): InlineKeyboard | undefined {
  const resources = resourceIds.flatMap((resourceId) => {
    const resource = getResource(resourceId);
    return resource && !resource.isDeleted && canAccessResource(telegramId, resource)
      ? [resource]
      : [];
  });
  if (resources.length === 0) return undefined;

  const keyboard = new InlineKeyboard();
  for (const resource of resources) {
    const callbackData = `lib:download:${resource.id.slice('resource:'.length)}`;
    if (Buffer.byteLength(callbackData, 'utf8') > 64) continue;
    keyboard.text(`⬇️ Download: ${resource.title}`.slice(0, 60), callbackData).row();
  }
  return keyboard.inline_keyboard.length > 0 ? keyboard : undefined;
}

async function sendAssistantReply(
  ctx: Context,
  answer: string,
  resourceIds: string[] = [],
  telegramId = ctx.from?.id ?? 0,
): Promise<number> {
  const reply = prepareAssistantReply(answer, assistantCancelHint);
  const replyMarkup = getAssistantResourceKeyboard(resourceIds, telegramId);
  const options = {
    ...(reply.parseMode ? { parse_mode: reply.parseMode } : {}),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };
  if (!reply.parseMode) {
    return getSentMessageId(await ctx.reply(reply.text, options));
  }

  try {
    return getSentMessageId(await ctx.reply(reply.text, options));
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
    return getSentMessageId(
      await ctx.reply(prepareAssistantReply(answer, assistantCancelHint, true).text, {
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    );
  }
}

function getSentMessageId(result: Awaited<ReturnType<Context['reply']>>): number {
  if (typeof result === 'boolean') {
    throw new Error('Telegram did not return the assistant reply message');
  }
  return result.message_id;
}

function canReplaceWithNewAssistantReply(error: unknown): error is GrammyError {
  return (
    error instanceof GrammyError &&
    error.error_code === 400 &&
    /message to edit not found|message can(?:not|'t) be edited/i.test(error.description)
  );
}

function isUnchangedAssistantReply(error: unknown): error is GrammyError {
  return error instanceof GrammyError && /message is not modified/i.test(error.description);
}

async function editAssistantReply(
  ctx: Context,
  previousReply: AssistantPromptMessage,
  answer: string,
  resourceIds: string[],
): Promise<number> {
  const reply = prepareAssistantReply(answer, assistantCancelHint);
  const replyMarkup = getAssistantResourceKeyboard(resourceIds, previousReply.userId);
  const options = {
    ...(reply.parseMode ? { parse_mode: reply.parseMode } : {}),
    reply_markup: replyMarkup ?? new InlineKeyboard(),
  };
  if (!reply.parseMode) {
    try {
      const result = await ctx.api.editMessageText(
        previousReply.chatId,
        previousReply.replyMessageId,
        reply.text,
        options,
      );
      return typeof result === 'boolean' ? previousReply.replyMessageId : result.message_id;
    } catch (error) {
      if (isUnchangedAssistantReply(error)) return previousReply.replyMessageId;
      if (!canReplaceWithNewAssistantReply(error)) throw error;
      logger.warn({
        description: error.description,
        userId: previousReply.userId,
        msg: 'Could not replace the previous assistant reply; sending a new reply',
      });
      return sendAssistantReply(ctx, answer, resourceIds);
    }
  }

  try {
    const result = await ctx.api.editMessageText(
      previousReply.chatId,
      previousReply.replyMessageId,
      reply.text,
      options,
    );
    return typeof result === 'boolean' ? previousReply.replyMessageId : result.message_id;
  } catch (error) {
    if (isUnchangedAssistantReply(error)) return previousReply.replyMessageId;
    if (canReplaceWithNewAssistantReply(error)) {
      logger.warn({
        description: error.description,
        userId: previousReply.userId,
        msg: 'Could not replace the previous assistant reply; sending a new reply',
      });
      return sendAssistantReply(ctx, answer, resourceIds);
    }
    if (
      !(error instanceof GrammyError) ||
      error.error_code !== 400 ||
      !/parse entities|message is too long/i.test(error.description)
    ) {
      throw error;
    }

    logger.warn({
      description: error.description,
      userId: previousReply.userId,
      msg: 'Telegram rejected edited assistant reply formatting; retrying as plain text',
    });
    const result = await ctx.api.editMessageText(
      previousReply.chatId,
      previousReply.replyMessageId,
      prepareAssistantReply(answer, assistantCancelHint, true).text,
      { reply_markup: replyMarkup ?? new InlineKeyboard() },
    );
    return typeof result === 'boolean' ? previousReply.replyMessageId : result.message_id;
  }
}

export async function deleteAssistantThinkingMessage(
  ctx: Context,
  telegramId: number,
  expectedMessageId?: number,
): Promise<void> {
  const message = assistantThinkingMessages.get(telegramId);
  if (!message || (expectedMessageId !== undefined && message.messageId !== expectedMessageId))
    return;
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
