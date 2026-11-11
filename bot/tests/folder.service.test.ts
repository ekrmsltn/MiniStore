import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMockFolder,
  createMockResource,
  createMockUser,
  resetEnv,
  setupEnv,
} from './helpers';

describe('Folder service', () => {
  let folders: ReturnType<typeof createMockFolder>[];
  let resources: ReturnType<typeof createMockResource>[];
  let index: {
    getFolder: ReturnType<typeof vi.fn>;
    getFolders: ReturnType<typeof vi.fn>;
    getResources: ReturnType<typeof vi.fn>;
    getResource: ReturnType<typeof vi.fn>;
    getResourceVersions: ReturnType<typeof vi.fn>;
    getUsers: ReturnType<typeof vi.fn>;
    getUserByTelegramId: ReturnType<typeof vi.fn>;
    updateEntity: ReturnType<typeof vi.fn>;
    saveEntity: ReturnType<typeof vi.fn>;
    deleteEntity: ReturnType<typeof vi.fn>;
  };
  let storage: {
    deleteFile: ReturnType<typeof vi.fn>;
    hasStoredFile: ReturnType<typeof vi.fn>;
  };
  let users: ReturnType<typeof createMockUser>[];

  beforeEach(() => {
    setupEnv();
    vi.resetModules();
    users = [createMockUser()];
    folders = [
      createMockFolder({ id: 'folder:root', name: 'Root' }),
      createMockFolder({ id: 'folder:child', name: 'Child', parentId: 'folder:root' }),
    ];
    resources = [createMockResource({ id: 'resource:file', folderId: 'folder:child' })];
    index = {
      getFolder: vi.fn((id: string) => folders.find((folder) => folder.id === id)),
      getFolders: vi.fn(() => folders),
      getResources: vi.fn(() => resources),
      getResource: vi.fn((id: string) => resources.find((resource) => resource.id === id)),
      getResourceVersions: vi.fn().mockReturnValue([]),
      getUsers: vi.fn(() => users),
      getUserByTelegramId: vi.fn((id: number) => users.find((user) => user.telegramId === id)),
      updateEntity: vi.fn().mockResolvedValue(undefined),
      saveEntity: vi.fn().mockResolvedValue(1),
      deleteEntity: vi.fn().mockResolvedValue(undefined),
    };
    storage = {
      deleteFile: vi.fn().mockResolvedValue(true),
      hasStoredFile: vi.fn().mockResolvedValue(true),
    };
    vi.doMock('../telegram/index', () => ({ index }));
    vi.doMock('../telegram/storage', () => storage);
  });

  afterAll(() => {
    resetEnv();
  });

  it('soft-deletes the complete active folder tree and its resources together', async () => {
    const { deleteFolder } = await import('../services/folders');

    await deleteFolder('folder:root', 12345);

    const deletedEntities = index.updateEntity.mock.calls.map(([entity]) => entity);
    expect(deletedEntities.map((entity) => entity.id)).toEqual([
      'folder:child',
      'resource:file',
      'folder:root',
    ]);
    expect(new Set(deletedEntities.map((entity) => entity.deletedAt)).size).toBe(1);
    expect(deletedEntities.every((entity) => entity.isDeleted)).toBe(true);
  });

  it('refuses a tree mutation when any contained resource is not accessible', async () => {
    resources[0] = {
      ...resources[0],
      visibility: { mode: 'custom', userIds: [54321] },
    };
    users.push(createMockUser({ telegramId: 54321, id: 'user:54321' }));
    const { deleteFolder } = await import('../services/folders');

    await expect(deleteFolder('folder:root', 12345)).rejects.toThrow(
      'You cannot manage a folder tree containing files you cannot access',
    );
    expect(index.updateEntity).not.toHaveBeenCalled();
  });

  it('restores only the contents deleted with the folder tree', async () => {
    const deletedAt = '2026-01-01T00:00:00.000Z';
    folders = folders.map((folder) => ({
      ...folder,
      isDeleted: true,
      deletedAt,
      deletionBatchId: 'batch-1',
    }));
    resources = [
      { ...resources[0], isDeleted: true, deletedAt, deletionBatchId: 'batch-1' },
      createMockResource({
        id: 'resource:older-trash',
        folderId: 'folder:child',
        isDeleted: true,
        deletedAt: '2025-12-31T23:59:00.000Z',
      }),
    ];
    const { restoreFolder } = await import('../services/folders');

    await restoreFolder('folder:root', 12345);

    const restoredIds = index.updateEntity.mock.calls.map(([entity]) => entity.id);
    expect(restoredIds).toEqual(['folder:root', 'folder:child', 'resource:file']);
    expect(index.updateEntity).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'resource:file', isDeleted: false, deletedAt: null }),
    );
    expect(index.updateEntity).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'resource:older-trash', isDeleted: false }),
    );
  });

  it('automatically suffixes duplicate folder names in the same parent', async () => {
    folders.push(
      createMockFolder({
        id: 'folder:existing',
        name: 'Projects',
        parentId: 'folder:root',
      }),
    );
    const { createFolder } = await import('../services/folders');

    const created = await createFolder('Projects', 'folder:root', 12345);

    expect(created.name).toBe('Projects (1)');
  });

  it('tags only active descendants in a folder deletion batch', async () => {
    resources = [{ ...resources[0], isDeleted: true, deletedAt: '2025-12-31T23:59:00.000Z' }];
    const { deleteFolder } = await import('../services/folders');

    const deletedRoot = await deleteFolder('folder:root', 12345);
    const deletedEntities = index.updateEntity.mock.calls.map(([entity]) => entity);

    expect(deletedRoot.deletionBatchId).toBeTruthy();
    expect(
      deletedEntities.every((entity) => entity.deletionBatchId === deletedRoot.deletionBatchId),
    ).toBe(true);
    expect(deletedEntities.map((entity) => entity.id)).toEqual(['folder:child', 'folder:root']);
  });

  it('restores legacy folder trees using their shared deletion timestamp', async () => {
    const deletedAt = '2025-11-01T10:00:00.000Z';
    folders = folders.map((folder) => ({ ...folder, isDeleted: true, deletedAt }));
    resources = [{ ...resources[0], isDeleted: true, deletedAt }];
    const { restoreFolder } = await import('../services/folders');

    await restoreFolder('folder:root', 12345);

    expect(index.updateEntity.mock.calls.map(([entity]) => entity.id)).toEqual([
      'folder:root',
      'folder:child',
      'resource:file',
    ]);
  });

  it('permanently deletes files from storage before removing a deleted folder tree', async () => {
    folders = folders.map((folder) => ({ ...folder, isDeleted: true }));
    resources = [{ ...resources[0], isDeleted: true }];
    const { permanentDeleteFolder } = await import('../services/folders');

    await permanentDeleteFolder('folder:root', 12345);

    expect(storage.deleteFile).toHaveBeenCalledWith(resources[0].storageMessageId);
    expect(index.deleteEntity).toHaveBeenCalledWith(resources[0].id);
    expect(index.deleteEntity).toHaveBeenCalledWith('folder:child');
    expect(index.deleteEntity).toHaveBeenCalledWith('folder:root');
  });
});
