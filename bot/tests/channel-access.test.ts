import { describe, expect, it, vi } from 'vitest';
import { assertBotCanPostInChannel, validateBotApiToken } from '../telegram/channel-access';

describe('Telegram channel posting access', () => {
  it('reports an invalid bot token clearly without exposing it', async () => {
    const api = {
      getMe: vi.fn().mockRejectedValue({ error_code: 401 }),
    };

    await expect(validateBotApiToken(api)).rejects.toThrow(
      'Telegram rejected BOT_TOKEN (401 Unauthorized). Replace it with the current token from BotFather.',
    );
  });

  it('surfaces temporary Bot API failures for startup handling', async () => {
    const error = new Error('network unavailable');
    const api = { getMe: vi.fn().mockRejectedValue(error) };

    await expect(validateBotApiToken(api)).rejects.toBe(error);
  });

  it('requires channel administrator posting permission and reuses the bot ID', async () => {
    const getMe = vi.fn().mockResolvedValue({ id: 42 });
    const getChatMember = vi
      .fn()
      .mockResolvedValueOnce({ status: 'administrator', can_post_messages: true })
      .mockResolvedValueOnce({ status: 'administrator', can_post_messages: false })
      .mockResolvedValueOnce({ status: 'member' });
    const api = { getMe, getChatMember };

    await expect(assertBotCanPostInChannel(api, '-100123')).resolves.toBeUndefined();
    await expect(assertBotCanPostInChannel(api, '-100456')).rejects.toThrow(
      'without permission to post',
    );
    await expect(assertBotCanPostInChannel(api, '-100789')).rejects.toThrow(
      'current status is member',
    );

    expect(getMe).toHaveBeenCalledOnce();
    expect(getChatMember).toHaveBeenNthCalledWith(1, '-100123', 42);
    expect(getChatMember).toHaveBeenNthCalledWith(2, '-100456', 42);
    expect(getChatMember).toHaveBeenNthCalledWith(3, '-100789', 42);
  });

  it('accepts a channel creator and surfaces Telegram API failures', async () => {
    vi.resetModules();
    const { assertBotCanPostInChannel: assertAccess } = await import('../telegram/channel-access');
    const api = {
      getMe: vi.fn().mockResolvedValue({ id: 42 }),
      getChatMember: vi
        .fn()
        .mockResolvedValueOnce({ status: 'creator' })
        .mockRejectedValueOnce(new Error('chat not found')),
    };

    await expect(assertAccess(api, '-100123')).resolves.toBeUndefined();
    await expect(assertAccess(api, '-100456')).rejects.toThrow('chat not found');
  });
});
