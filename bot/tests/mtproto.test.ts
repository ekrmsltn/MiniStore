import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupEnv, resetEnv } from './helpers';

const clientMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  checkAuthorization: vi.fn(),
  getMe: vi.fn(),
  iterDialogs: vi.fn(),
  getEntity: vi.fn(),
  getMessages: vi.fn(),
  iterMessages: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('teleproto', () => ({
  TelegramClient: vi.fn().mockImplementation(function () {
    return clientMocks;
  }),
}));

vi.mock('teleproto/sessions', () => ({
  StringSession: vi.fn(),
}));

describe('MTProto channel reader', () => {
  beforeEach(() => {
    setupEnv();
    vi.resetModules();
    vi.clearAllMocks();
    clientMocks.checkAuthorization.mockResolvedValue(true);
    clientMocks.getMe.mockResolvedValue({ id: 1 });
    clientMocks.connect.mockResolvedValue(undefined);
    clientMocks.iterDialogs.mockReturnValue(
      (async function* () {
        yield { id: -1001234567890n, entity: { id: 123 } };
      })(),
    );
    clientMocks.getEntity.mockRejectedValue(new Error('Entity is not cached'));
    clientMocks.getMessages.mockResolvedValue([]);
    clientMocks.disconnect.mockResolvedValue(undefined);
  });

  afterAll(() => resetEnv());

  it('rejects a session that is not authorized', async () => {
    process.env.TELEGRAM_USER_SESSION = 'invalid-session';
    const { getMtprotoClient } = await import('../telegram/mtproto');
    clientMocks.checkAuthorization.mockResolvedValue(false);

    await expect(getMtprotoClient()).rejects.toThrow('session is not authorized');
    expect(clientMocks.disconnect).toHaveBeenCalledOnce();
  });

  it('rejects a session belonging to an account other than OWNER_ID', async () => {
    process.env.TELEGRAM_USER_SESSION = 'valid-session';
    const { getMtprotoClient } = await import('../telegram/mtproto');
    clientMocks.getMe.mockResolvedValue({ id: 2 });

    await expect(getMtprotoClient()).rejects.toThrow('does not match OWNER_ID');
  });

  it('reads channel history in oldest-first order with bounded request pacing', async () => {
    process.env.TELEGRAM_USER_SESSION = 'authorized-session';
    const history = (async function* () {
      yield { id: 1, message: '{"type":"user"}' };
      yield { id: 2, message: '{"type":"folder"}' };
    })();
    clientMocks.iterMessages.mockReturnValue(history);

    const { iterateChannelHistory } = await import('../telegram/mtproto');
    const messages = [];
    for await (const message of iterateChannelHistory('-1001234567890')) {
      messages.push(message);
    }

    expect(messages.map((message) => message.id)).toEqual([1, 2]);
    expect(clientMocks.iterMessages).toHaveBeenCalledWith(
      { id: 123 },
      { reverse: true, waitTime: 1 },
    );
  });

  it('rejects non-private-channel IDs before requesting Telegram', async () => {
    process.env.TELEGRAM_USER_SESSION = 'authorized-session';
    const { getChannelEntity } = await import('../telegram/mtproto');

    await expect(getChannelEntity('12345')).rejects.toThrow('Invalid private Telegram channel ID');
    expect(clientMocks.iterDialogs).not.toHaveBeenCalled();
  });

  it('checks archived dialogs before active dialogs and rejects channels missing from both', async () => {
    process.env.TELEGRAM_USER_SESSION = 'valid-session';
    clientMocks.iterDialogs.mockReturnValue((async function* () {})());
    const { getChannelEntity } = await import('../telegram/mtproto');

    await expect(getChannelEntity('-1002222222222')).rejects.toThrow(
      'cannot resolve channel -1002222222222',
    );
    expect(clientMocks.iterDialogs).toHaveBeenNthCalledWith(1, {
      limit: undefined,
      archived: true,
    });
    expect(clientMocks.iterDialogs).toHaveBeenNthCalledWith(2, {
      limit: undefined,
      archived: false,
    });
  });

  it('resolves channels from the archived dialog folder', async () => {
    process.env.TELEGRAM_USER_SESSION = 'valid-session';
    clientMocks.iterDialogs.mockReturnValueOnce(
      (async function* () {
        yield { id: -1002222222222n, entity: { id: 456 } };
      })(),
    );
    const { getChannelEntity } = await import('../telegram/mtproto');

    await expect(getChannelEntity('-1002222222222')).resolves.toEqual({ id: 456 });
    expect(clientMocks.iterDialogs).toHaveBeenCalledOnce();
    expect(clientMocks.iterDialogs).toHaveBeenCalledWith({
      limit: undefined,
      archived: true,
    });
  });

  it('falls back to active dialogs when the channel is not archived', async () => {
    process.env.TELEGRAM_USER_SESSION = 'valid-session';
    clientMocks.iterDialogs.mockReturnValueOnce((async function* () {})()).mockReturnValueOnce(
      (async function* () {
        yield { id: -1002222222222n, entity: { id: 456 } };
      })(),
    );
    const { getChannelEntity } = await import('../telegram/mtproto');

    await expect(getChannelEntity('-1002222222222')).resolves.toEqual({ id: 456 });
    expect(clientMocks.iterDialogs).toHaveBeenNthCalledWith(1, {
      limit: undefined,
      archived: true,
    });
    expect(clientMocks.iterDialogs).toHaveBeenNthCalledWith(2, {
      limit: undefined,
      archived: false,
    });
  });

  it('continues to active dialogs when scanning the archive fails', async () => {
    process.env.TELEGRAM_USER_SESSION = 'valid-session';
    clientMocks.iterDialogs
      .mockImplementationOnce(() => {
        throw new Error('Archive folder unavailable');
      })
      .mockReturnValueOnce(
        (async function* () {
          yield { id: -1002222222222n, entity: { id: 456 } };
        })(),
      );
    const { getChannelEntity } = await import('../telegram/mtproto');

    await expect(getChannelEntity('-1002222222222')).resolves.toEqual({ id: 456 });
    expect(clientMocks.iterDialogs).toHaveBeenNthCalledWith(2, {
      limit: undefined,
      archived: false,
    });
  });

  it('uses the MTProto entity cache when a channel is absent from both dialog folders', async () => {
    process.env.TELEGRAM_USER_SESSION = 'valid-session';
    clientMocks.iterDialogs.mockReturnValue((async function* () {})());
    clientMocks.getEntity.mockResolvedValue({ id: 456 });
    const { getChannelEntity } = await import('../telegram/mtproto');

    await expect(getChannelEntity('-1002222222222')).resolves.toEqual({ id: 456 });
    expect(clientMocks.getEntity).toHaveBeenCalledWith(-1002222222222);
  });
});
