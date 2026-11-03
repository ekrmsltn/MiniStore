import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockUser, resetEnv, setupEnv } from './helpers';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  getAllUsers: vi.fn(),
  hasPermission: vi.fn((telegramId: number, permission: string) =>
    telegramId === 1 || (telegramId === 10 && permission === 'manage_users'),
  ),
}));

vi.mock('grammy', () => ({
  Api: class {
    sendMessage = mocks.sendMessage;
  },
}));
vi.mock('../services/users', () => ({
  getAllUsers: mocks.getAllUsers,
}));
vi.mock('../services/permissions', () => ({
  hasPermission: mocks.hasPermission,
}));

describe('Access request notifications', () => {
  beforeEach(() => {
    setupEnv();
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getAllUsers.mockReturnValue([
      createMockUser({ telegramId: 10, role: 'admin', status: 'active' }),
      createMockUser({ telegramId: 11, role: 'admin', status: 'suspended' }),
    ]);
    mocks.sendMessage.mockResolvedValue({});
  });

  afterAll(() => resetEnv());

  it('notifies the owner and active admins with actionable request buttons', async () => {
    const { notifyAdminsOfAccessRequest } = await import('../services/notifications');
    const result = await notifyAdminsOfAccessRequest(createMockUser());

    expect(result).toEqual({ notified: true, recipients: 2, usedChannelFallback: false });
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      1,
      expect.stringContaining('Telegram ID: 12345'),
      expect.objectContaining({
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Approve', callback_data: 'approve:12345' },
              { text: 'Reject', callback_data: 'reject:12345' },
            ],
          ],
        },
      }),
    );
    expect(mocks.sendMessage).not.toHaveBeenCalledWith(11, expect.anything(), expect.anything());
  });

  it('falls back to the Management Channel when direct messages cannot be delivered', async () => {
    mocks.sendMessage.mockRejectedValueOnce(new Error('Bot blocked'))
      .mockRejectedValueOnce(new Error('Bot blocked'))
      .mockResolvedValueOnce({});
    const { notifyAdminsOfAccessRequest } = await import('../services/notifications');

    await expect(notifyAdminsOfAccessRequest(createMockUser())).resolves.toEqual({
      notified: true,
      recipients: 1,
      usedChannelFallback: true,
    });
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(
      '-1009876543210',
      expect.any(String),
      expect.any(Object),
    );
  });

  it('reports inability to notify when both direct and channel messages fail', async () => {
    mocks.sendMessage.mockRejectedValue(new Error('Telegram unavailable'));
    const { notifyAdminsOfAccessRequest } = await import('../services/notifications');

    await expect(notifyAdminsOfAccessRequest(createMockUser())).resolves.toMatchObject({
      notified: false,
      recipients: 0,
    });
  });

  it('returns false if it cannot notify a user of the decision', async () => {
    mocks.sendMessage.mockRejectedValue(new Error('Bot blocked'));
    const { notifyUserOfAccessDecision } = await import('../services/notifications');

    await expect(notifyUserOfAccessDecision(createMockUser(), true)).resolves.toBe(false);
  });

  it('sends an approval decision to the user with instructions to open the bot', async () => {
    const user = createMockUser();
    const { notifyUserOfAccessDecision } = await import('../services/notifications');

    await expect(notifyUserOfAccessDecision(user, true)).resolves.toBe(true);
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      user.telegramId,
      expect.stringContaining('Send /start'),
    );
  });
});
