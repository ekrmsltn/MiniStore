import type { Context } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { privateChatOnly } from '../private-chat';

describe('private chat restriction', () => {
  it('continues processing private chat updates', async () => {
    const next = vi.fn().mockResolvedValue(undefined);
    const ctx = { chat: { type: 'private' } } as Context;

    await privateChatOnly(ctx, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('does not process group messages and replies with private-chat guidance', async () => {
    const next = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      chat: { type: 'group' },
      message: { text: '/store' },
      reply,
    } as unknown as Context;

    await privateChatOnly(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith('Please use MiniStore in a private chat with the bot.');
  });

  it('answers group callbacks without running their actions', async () => {
    const next = vi.fn().mockResolvedValue(undefined);
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      chat: { type: 'supergroup' },
      callbackQuery: { id: 'callback-id' },
      answerCallbackQuery,
    } as unknown as Context;

    await privateChatOnly(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Please use MiniStore in a private chat with the bot.',
    });
  });
});
