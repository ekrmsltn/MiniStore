import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMockFolder,
  createMockResource,
  createMockUser,
  resetEnv,
  setupEnv,
} from './helpers';

describe('Resource visibility policy', () => {
  const users = [
    createMockUser({ telegramId: 12345 }),
    createMockUser({ id: 'user:54321', telegramId: 54321, role: 'admin' }),
    createMockUser({ id: 'user:67890', telegramId: 67890, status: 'inactive' }),
  ];
  let folders: ReturnType<typeof createMockFolder>[];
  const index = {
    getFolder: vi.fn(),
    getUsers: vi.fn(() => users),
    getUserByTelegramId: vi.fn((telegramId: number) =>
      users.find((user) => user.telegramId === telegramId),
    ),
  };

  beforeEach(() => {
    setupEnv();
    vi.resetModules();
    folders = [];
    index.getFolder.mockImplementation((id: string) => folders.find((folder) => folder.id === id));
    vi.doMock('../telegram/index', () => ({ index }));
  });

  afterAll(() => {
    resetEnv();
  });

  it('defaults legacy resources to public while excluding inactive accounts', async () => {
    const { canAccessResource } = await import('../services/visibility');
    const legacyResource = createMockResource({ folderId: null });

    expect(canAccessResource(12345, legacyResource)).toBe(true);
    expect(canAccessResource(54321, legacyResource)).toBe(true);
    expect(canAccessResource(67890, legacyResource)).toBe(false);
    expect(canAccessResource(1, legacyResource)).toBe(true);
  });

  it('limits private resources to the owner and active admins', async () => {
    const { canAccessResource } = await import('../services/visibility');
    const resource = createMockResource({ folderId: null, visibility: { mode: 'private' } });

    expect(canAccessResource(1, resource)).toBe(true);
    expect(canAccessResource(54321, resource)).toBe(true);
    expect(canAccessResource(12345, resource)).toBe(false);
  });

  it('intersects child visibility with every ancestor instead of widening it', async () => {
    folders = [
      createMockFolder({
        id: 'folder:parent',
        visibility: { mode: 'custom', userIds: [12345] },
      }),
      createMockFolder({
        id: 'folder:child',
        parentId: 'folder:parent',
        visibility: { mode: 'public' },
      }),
    ];
    const { canAccessFolder, canAccessResource } = await import('../services/visibility');
    const resource = createMockResource({
      folderId: 'folder:child',
      visibility: { mode: 'public' },
    });

    expect(canAccessFolder(12345, 'folder:child')).toBe(true);
    expect(canAccessFolder(54321, 'folder:child')).toBe(false);
    expect(canAccessResource(12345, resource)).toBe(true);
    expect(canAccessResource(54321, resource)).toBe(false);
    expect(canAccessFolder(1, 'folder:child')).toBe(true);
  });

  it('applies an edited parent visibility immediately to its descendants', async () => {
    const parent = createMockFolder({
      id: 'folder:parent',
      visibility: { mode: 'custom', userIds: [12345] },
    });
    folders = [
      parent,
      createMockFolder({
        id: 'folder:child',
        parentId: 'folder:parent',
      }),
    ];
    const { canAccessFolder, canAccessResource } = await import('../services/visibility');
    const resource = createMockResource({ folderId: 'folder:child' });

    expect(canAccessFolder(12345, 'folder:child')).toBe(true);
    expect(canAccessResource(12345, resource)).toBe(true);

    parent.visibility = { mode: 'custom', userIds: [54321] };

    expect(canAccessFolder(12345, 'folder:child')).toBe(false);
    expect(canAccessResource(12345, resource)).toBe(false);
    expect(canAccessFolder(54321, 'folder:child')).toBe(true);
    expect(canAccessResource(54321, resource)).toBe(true);
  });
});
