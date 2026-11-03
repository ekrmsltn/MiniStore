import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserEntity } from '../models';
import { createMockUser, resetEnv, setupEnv } from './helpers';

let storedUser: UserEntity | undefined;
const saveEntity = vi.fn(async (entity: { type: string }) => {
  if (entity.type === 'user') storedUser = entity as UserEntity;
  return 1;
});
const updateEntity = vi.fn(async (entity: { type: string }) => {
  if (entity.type === 'user') storedUser = entity as UserEntity;
});
const index = {
  isInitialized: vi.fn(() => true),
  getUserByTelegramId: vi.fn(() => storedUser),
  saveEntity,
  updateEntity,
};

describe('Access request service', () => {
  beforeEach(() => {
    setupEnv();
    vi.resetModules();
    vi.clearAllMocks();
    storedUser = undefined;
    index.isInitialized.mockReturnValue(true);
    index.getUserByTelegramId.mockImplementation(() => storedUser);
    saveEntity.mockImplementation(async (entity: { type: string }) => {
      if (entity.type === 'user') storedUser = entity as UserEntity;
      return 1;
    });
    updateEntity.mockImplementation(async (entity: { type: string }) => {
      if (entity.type === 'user') storedUser = entity as UserEntity;
    });
    vi.doMock('../telegram/index', () => ({ index }));
  });

  afterAll(() => resetEnv());

  it.each([
    ['active approved user', 'user', 'active', true],
    ['active administrator', 'admin', 'active', true],
    ['pending request', 'pending', 'inactive', false],
    ['rejected account', 'rejected', 'inactive', false],
    ['suspended account', 'suspended', 'inactive', false],
    ['blocked account', 'blocked', 'inactive', false],
    ['inactive user', 'user', 'inactive', false],
    ['inactive administrator', 'admin', 'inactive', false],
  ] as const)('store access for %s is %s', async (_label, role, status, expected) => {
    storedUser = createMockUser({
      telegramId: 12345,
      role,
      status,
    });
    const { canAccessStore } = await import('../services/users');

    expect(canAccessStore(12345)).toBe(expected);
  });

  it('grants store access to the configured owner only after index initialization', async () => {
    const { canAccessStore } = await import('../services/users');

    expect(canAccessStore(1)).toBe(true);
    index.isInitialized.mockReturnValue(false);
    expect(canAccessStore(1)).toBe(false);
  });

  it('creates a pending user and identifies a newly submitted request', async () => {
    const { requestAccess } = await import('../services/users');
    const result = await requestAccess(12345, 'alice', 'Alice', null);

    expect(result.created).toBe(true);
    expect(result.user.role).toBe('pending');
    expect(result.user.status).toBe('inactive');
  });

  it('does not duplicate pending requests when repeated or concurrently submitted', async () => {
    const { requestAccess } = await import('../services/users');
    const requests = await Promise.all([
      requestAccess(12345, 'alice', 'Alice', null),
      requestAccess(12345, 'alice', 'Alice', null),
    ]);

    expect(requests.filter((request) => request.created)).toHaveLength(1);
    expect(requests.filter((request) => !request.created)).toHaveLength(1);
    expect(saveEntity.mock.calls.filter(([entity]) => entity.type === 'user')).toHaveLength(1);
  });

  it('allows rejected users to submit a fresh request', async () => {
    storedUser = {
      type: 'user',
      id: 'user:12345',
      telegramId: 12345,
      username: 'alice',
      firstName: 'Alice',
      lastName: null,
      role: 'rejected',
      status: 'inactive',
      permissions: [],
      favorites: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const { requestAccess } = await import('../services/users');
    const result = await requestAccess(12345, 'alice', 'Alice', null);

    expect(result.created).toBe(true);
    expect(result.user.role).toBe('pending');
    expect(updateEntity).toHaveBeenCalledOnce();
  });

  it('approves a rejected user from the admin user list and returns active access', async () => {
    storedUser = {
      type: 'user',
      id: 'user:12345',
      telegramId: 12345,
      username: 'alice',
      firstName: 'Alice',
      lastName: null,
      role: 'rejected',
      status: 'inactive',
      permissions: [],
      favorites: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const { approveUser } = await import('../services/users');
    const result = await approveUser(12345, 1);

    expect(result.role).toBe('user');
    expect(result.status).toBe('active');
    expect(updateEntity).toHaveBeenCalledOnce();
  });

  it('does not allow a non-owner to promote users to admin', async () => {
    storedUser = {
      type: 'user',
      id: 'user:12345',
      telegramId: 12345,
      username: 'alice',
      firstName: 'Alice',
      lastName: null,
      role: 'user',
      status: 'active',
      permissions: [],
      favorites: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const { promoteUser } = await import('../services/users');

    await expect(promoteUser(12345, 'admin', 2)).rejects.toThrow('Only the owner');
    expect(updateEntity).not.toHaveBeenCalled();
  });

  it('clears prior permissions when the owner promotes a user to admin', async () => {
    storedUser = {
      type: 'user',
      id: 'user:12345',
      telegramId: 12345,
      username: 'alice',
      firstName: 'Alice',
      lastName: null,
      role: 'user',
      status: 'active',
      permissions: ['manage_users'],
      favorites: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const { promoteUser } = await import('../services/users');

    const result = await promoteUser(12345, 'admin', 1);

    expect(result.role).toBe('admin');
    expect(result.permissions).toEqual([]);
  });
});
