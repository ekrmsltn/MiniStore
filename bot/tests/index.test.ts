/**
 * Unit tests for the in-memory entity index (storage/index.ts).
 * Tests CRUD operations, search, pagination, and consistency checks.
 */

import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setupEnv,
  resetEnv,
  createMockUser,
  createMockFolder,
  createMockResource,
  createMockAudit,
} from './helpers';
import { Entity } from '../models';

const pauseTelegramUpdates = vi.fn().mockResolvedValue(undefined);
const resumeTelegramUpdates = vi.fn();

describe('Entity Index', () => {
  beforeEach(() => {
    setupEnv();
    vi.resetModules();
    // Mock the management channel to return empty entities
    const getAllEntityRecords = vi.fn().mockResolvedValue([]);
    vi.doMock('../telegram/management', () => ({
      getAllEntityRecords,
      iterateEntityRecords: async function* () {
        for (const record of await getAllEntityRecords()) {
          yield record;
        }
      },
      getAllEntities: vi.fn().mockResolvedValue([]),
      sendEntity: vi.fn().mockResolvedValue(1),
      editEntity: vi.fn().mockResolvedValue(true),
      deleteEntity: vi.fn().mockResolvedValue(true),
      getEntity: vi.fn().mockResolvedValue(null),
    }));
    pauseTelegramUpdates.mockClear();
    resumeTelegramUpdates.mockClear();
    vi.doMock('../webhook', () => ({
      pauseTelegramUpdates,
      resumeTelegramUpdates,
    }));
  });

  afterAll(() => {
    resetEnv();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  async function getIndex() {
    const { index } = await import('../telegram/index');
    return index;
  }

  describe('Basic CRUD', () => {
    it('should set and get an entity', async () => {
      const idx = await getIndex();
      const user = createMockUser();
      idx.set(user, 1);
      const found = idx.get('user:12345');
      expect(found).toEqual(user);
    });

    it('should return undefined for non-existent entity', async () => {
      const idx = await getIndex();
      const found = idx.get('user:99999');
      expect(found).toBeUndefined();
    });

    it('should delete an entity', async () => {
      const idx = await getIndex();
      const user = createMockUser();
      idx.set(user, 1);
      const deleted = idx.delete('user:12345');
      expect(deleted).toBe(true);
      expect(idx.get('user:12345')).toBeUndefined();
    });

    it('should return false when deleting non-existent entity', async () => {
      const idx = await getIndex();
      const deleted = idx.delete('user:99999');
      expect(deleted).toBe(false);
    });

    it('should update an existing entity', async () => {
      const idx = await getIndex();
      const user = createMockUser();
      idx.set(user, 1);
      const updated = createMockUser({ firstName: 'Updated' });
      idx.set(updated, 1);
      const found = idx.get('user:12345');
      expect(found?.firstName).toBe('Updated');
    });
  });

  describe('Type-based queries', () => {
    it('should get users by type', async () => {
      const idx = await getIndex();
      const user1 = createMockUser({ telegramId: 1, id: 'user:1' as `user:${number}` });
      const user2 = createMockUser({ telegramId: 2, id: 'user:2' as `user:${number}` });
      const folder = createMockFolder();
      idx.set(user1, 1);
      idx.set(user2, 2);
      idx.set(folder, 3);
      const users = idx.getUsers();
      expect(users).toHaveLength(2);
      expect(users.every((u) => u.type === 'user')).toBe(true);
    });

    it('should get folders by type', async () => {
      const idx = await getIndex();
      const folder1 = createMockFolder({ id: 'folder:1' as `folder:${string}` });
      const folder2 = createMockFolder({ id: 'folder:2' as `folder:${string}` });
      idx.set(folder1, 1);
      idx.set(folder2, 2);
      const folders = idx.getFolders();
      expect(folders).toHaveLength(2);
    });

    it('should get resources by type', async () => {
      const idx = await getIndex();
      const resource = createMockResource();
      idx.set(resource, 1);
      const resources = idx.getResources();
      expect(resources).toHaveLength(1);
    });

    it('should get audits by type', async () => {
      const idx = await getIndex();
      const audit = createMockAudit();
      idx.set(audit, 1);
      const audits = idx.getAudits();
      expect(audits).toHaveLength(1);
    });
  });

  describe('User queries', () => {
    it('should find user by Telegram ID', async () => {
      const idx = await getIndex();
      const user = createMockUser();
      idx.set(user, 1);
      const found = idx.getUserByTelegramId(12345);
      expect(found?.telegramId).toBe(12345);
    });

    it('should return undefined for unknown Telegram ID', async () => {
      const idx = await getIndex();
      const found = idx.getUserByTelegramId(99999);
      expect(found).toBeUndefined();
    });
  });

  describe('Folder queries', () => {
    it('should get root folders', async () => {
      const idx = await getIndex();
      const root = createMockFolder({ id: 'folder:root' as `folder:${string}`, parentId: null });
      const child = createMockFolder({
        id: 'folder:child' as `folder:${string}`,
        parentId: 'folder:root' as `folder:${string}`,
      });
      idx.set(root, 1);
      idx.set(child, 2);
      const roots = idx.getRootFolders();
      expect(roots).toHaveLength(1);
      expect(roots[0].id).toBe('folder:root');
    });

    it('should exclude deleted folders from root folders', async () => {
      const idx = await getIndex();
      const deleted = createMockFolder({
        id: 'folder:deleted' as `folder:${string}`,
        parentId: null,
        isDeleted: true,
      });
      const active = createMockFolder({
        id: 'folder:active' as `folder:${string}`,
        parentId: null,
        isDeleted: false,
      });
      idx.set(deleted, 1);
      idx.set(active, 2);
      const roots = idx.getRootFolders();
      expect(roots).toHaveLength(1);
      expect(roots[0].id).toBe('folder:active');
    });

    it('should get child folders', async () => {
      const idx = await getIndex();
      const parent = createMockFolder({ id: 'folder:parent' as `folder:${string}` });
      const child1 = createMockFolder({
        id: 'folder:c1' as `folder:${string}`,
        parentId: 'folder:parent' as `folder:${string}`,
      });
      const child2 = createMockFolder({
        id: 'folder:c2' as `folder:${string}`,
        parentId: 'folder:parent' as `folder:${string}`,
      });
      idx.set(parent, 1);
      idx.set(child1, 2);
      idx.set(child2, 3);
      const children = idx.getChildFolders('folder:parent');
      expect(children).toHaveLength(2);
    });

    it('should exclude deleted folders from child folders', async () => {
      const idx = await getIndex();
      const child = createMockFolder({
        id: 'folder:child' as `folder:${string}`,
        parentId: 'folder:parent' as `folder:${string}`,
        isDeleted: true,
      });
      idx.set(child, 1);
      const children = idx.getChildFolders('folder:parent');
      expect(children).toHaveLength(0);
    });
  });

  describe('Resource queries', () => {
    it('should get resources in a folder', async () => {
      const idx = await getIndex();
      const r1 = createMockResource({
        id: 'resource:1' as `resource:${string}`,
        folderId: 'folder:test' as `folder:${string}`,
      });
      const r2 = createMockResource({
        id: 'resource:2' as `resource:${string}`,
        folderId: 'folder:test' as `folder:${string}`,
      });
      const r3 = createMockResource({
        id: 'resource:3' as `resource:${string}`,
        folderId: 'folder:other' as `folder:${string}`,
      });
      idx.set(r1, 1);
      idx.set(r2, 2);
      idx.set(r3, 3);
      const resources = idx.getResourcesInFolder('folder:test');
      expect(resources).toHaveLength(2);
    });

    it('should exclude deleted resources from folder query', async () => {
      const idx = await getIndex();
      const active = createMockResource({
        id: 'resource:active' as `resource:${string}`,
        folderId: 'folder:test' as `folder:${string}`,
        isDeleted: false,
      });
      const deleted = createMockResource({
        id: 'resource:deleted' as `resource:${string}`,
        folderId: 'folder:test' as `folder:${string}`,
        isDeleted: true,
      });
      idx.set(active, 1);
      idx.set(deleted, 2);
      const resources = idx.getResourcesInFolder('folder:test');
      expect(resources).toHaveLength(1);
      expect(resources[0].id).toBe('resource:active');
    });
  });

  describe('Search', () => {
    it('should search by title', async () => {
      const idx = await getIndex();
      const r1 = createMockResource({
        id: 'resource:1' as `resource:${string}`,
        title: 'Annual Report 2024',
      });
      const r2 = createMockResource({
        id: 'resource:2' as `resource:${string}`,
        title: 'Budget Plan',
      });
      idx.set(r1, 1);
      idx.set(r2, 2);
      const results = idx.searchResources('Annual');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Annual Report 2024');
    });

    it('should search by tags', async () => {
      const idx = await getIndex();
      const r1 = createMockResource({
        id: 'resource:1' as `resource:${string}`,
        title: 'Document',
        tags: ['pdf', 'report'],
      });
      const r2 = createMockResource({
        id: 'resource:2' as `resource:${string}`,
        title: 'Image',
        tags: ['png', 'photo'],
      });
      idx.set(r1, 1);
      idx.set(r2, 2);
      const results = idx.searchResources('pdf');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('resource:1');
    });

    it('should search by description', async () => {
      const idx = await getIndex();
      const r1 = createMockResource({
        id: 'resource:1' as `resource:${string}`,
        title: 'Doc',
        description: 'Contains confidential information',
      });
      idx.set(r1, 1);
      const results = idx.searchResources('confidential');
      expect(results).toHaveLength(1);
    });

    it('should be case-insensitive', async () => {
      const idx = await getIndex();
      const r1 = createMockResource({
        id: 'resource:1' as `resource:${string}`,
        title: 'Annual Report',
      });
      idx.set(r1, 1);
      expect(idx.searchResources('annual')).toHaveLength(1);
      expect(idx.searchResources('ANNUAL')).toHaveLength(1);
      expect(idx.searchResources('Annual')).toHaveLength(1);
    });

    it('should exclude deleted resources', async () => {
      const idx = await getIndex();
      const deleted = createMockResource({
        id: 'resource:1' as `resource:${string}`,
        title: 'Deleted Report',
        isDeleted: true,
      });
      idx.set(deleted, 1);
      const results = idx.searchResources('Deleted');
      expect(results).toHaveLength(0);
    });
  });

  describe('Recently Added', () => {
    it('should return recently added resources sorted by date', async () => {
      const idx = await getIndex();
      const old = createMockResource({
        id: 'resource:old' as `resource:${string}`,
        createdAt: '2024-01-01T00:00:00.000Z',
      });
      const new_ = createMockResource({
        id: 'resource:new' as `resource:${string}`,
        createdAt: '2024-12-01T00:00:00.000Z',
      });
      idx.set(old, 1);
      idx.set(new_, 2);
      const recent = idx.getRecentlyAdded(10);
      expect(recent[0].id).toBe('resource:new');
    });

    it('should respect the limit', async () => {
      const idx = await getIndex();
      for (let i = 0; i < 5; i++) {
        idx.set(
          createMockResource({
            id: `resource:${i}` as `resource:${string}`,
            createdAt: new Date(Date.now() - i * 1000).toISOString(),
          }),
          i + 1,
        );
      }
      const recent = idx.getRecentlyAdded(2);
      expect(recent).toHaveLength(2);
    });

    it('should exclude deleted resources', async () => {
      const idx = await getIndex();
      const active = createMockResource({
        id: 'resource:active' as `resource:${string}`,
        isDeleted: false,
      });
      const deleted = createMockResource({
        id: 'resource:deleted' as `resource:${string}`,
        isDeleted: true,
      });
      idx.set(active, 1);
      idx.set(deleted, 2);
      const recent = idx.getRecentlyAdded(10);
      expect(recent).toHaveLength(1);
      expect(recent[0].id).toBe('resource:active');
    });
  });

  describe('Resource filtering', () => {
    it('should return all non-deleted resources', async () => {
      const idx = await getIndex();
      idx.set(
        createMockResource({ id: 'resource:1' as `resource:${string}`, isDeleted: false }),
        1,
      );
      idx.set(createMockResource({ id: 'resource:2' as `resource:${string}`, isDeleted: true }), 2);
      const resources = idx.getResources().filter((r) => !r.isDeleted);
      expect(resources).toHaveLength(1);
    });

    it('should return all non-deleted folders', async () => {
      const idx = await getIndex();
      idx.set(createMockFolder({ id: 'folder:1' as `folder:${string}`, isDeleted: false }), 1);
      idx.set(createMockFolder({ id: 'folder:2' as `folder:${string}`, isDeleted: true }), 2);
      const folders = idx.getFolders().filter((f) => !f.isDeleted);
      expect(folders).toHaveLength(1);
    });
  });

  describe('Index management', () => {
    it('rebuilds indexed entities with their Telegram message IDs', async () => {
      const idx = await getIndex();
      const user = createMockUser();
      const management = await import('../telegram/management');
      vi.mocked(management.getAllEntityRecords).mockResolvedValue([
        { entity: user, messageId: 44 },
      ]);

      await idx.build();

      expect(idx.getWithMessageId(user.id)?.messageId).toBe(44);
    });

    it('removes stale in-memory entities when rebuilding from channel history', async () => {
      const idx = await getIndex();
      const staleUser = createMockUser({ telegramId: 99, id: 'user:99' as `user:${number}` });
      idx.set(staleUser, 12);
      const management = await import('../telegram/management');
      vi.mocked(management.getAllEntityRecords).mockResolvedValue([]);

      await idx.build();

      expect(idx.get(staleUser.id)).toBeUndefined();
      expect(idx.size()).toBe(0);
      expect(idx.isInitialized()).toBe(true);
    });

    it('does not silently update an entity that has no Telegram message ID', async () => {
      const idx = await getIndex();
      const user = createMockUser();
      idx.set(user, null);

      await expect(idx.updateEntity({ ...user, firstName: 'Updated' })).rejects.toThrow(
        'Telegram message ID is unavailable',
      );
    });

    it('prevents concurrent saves from creating duplicate channel records', async () => {
      const idx = await getIndex();
      const user = createMockUser();
      const management = await import('../telegram/management');

      const messageIds = await Promise.all([idx.saveEntity(user), idx.saveEntity(user)]);

      expect(messageIds).toEqual([1, 1]);
      expect(management.sendEntity).toHaveBeenCalledOnce();
    });

    it('should report correct size', async () => {
      const idx = await getIndex();
      expect(idx.size()).toBe(0);
      idx.set(createMockUser(), 1);
      expect(idx.size()).toBe(1);
      idx.set(createMockFolder(), 2);
      expect(idx.size()).toBe(2);
    });

    it('should clear the index', async () => {
      const idx = await getIndex();
      idx.set(createMockUser(), 1);
      idx.set(createMockFolder(), 2);
      idx.clear();
      expect(idx.size()).toBe(0);
      expect(idx.isInitialized()).toBe(false);
    });

    it('should track initialization state', async () => {
      const idx = await getIndex();
      expect(idx.isInitialized()).toBe(false);
      await idx.build();
      expect(idx.isInitialized()).toBe(true);
    });

    it('should get entity with message ID', async () => {
      const idx = await getIndex();
      const user = createMockUser();
      idx.set(user, 42);
      const withMsg = idx.getWithMessageId('user:12345');
      expect(withMsg?.messageId).toBe(42);
      expect(withMsg?.entity).toEqual(user);
    });
  });

  describe('Consistency check', () => {
    it('pauses updates while rebuilding after a consistency discrepancy', async () => {
      vi.useFakeTimers();
      const idx = await getIndex();
      const user = createMockUser();
      idx.set(user, 1);
      const management = await import('../telegram/management');
      vi.mocked(management.getAllEntityRecords).mockResolvedValue([]);
      const { startConsistencyChecks } = await import('../telegram/index');
      const stopChecks = startConsistencyChecks(1_000);

      await vi.advanceTimersByTimeAsync(1_000);

      expect(pauseTelegramUpdates).toHaveBeenCalledOnce();
      expect(resumeTelegramUpdates).toHaveBeenCalledOnce();
      expect(idx.get(user.id)).toBeUndefined();
      expect(idx.isInitialized()).toBe(true);

      stopChecks();
    });

    it('keeps updates paused after a failed rebuild and resumes after recovery', async () => {
      vi.useFakeTimers();
      const idx = await getIndex();
      const management = await import('../telegram/management');
      vi.mocked(management.getAllEntityRecords)
        .mockRejectedValueOnce(new Error('temporary channel history failure'))
        .mockResolvedValueOnce([]);
      const { startConsistencyChecks } = await import('../telegram/index');
      const stopChecks = startConsistencyChecks(1_000);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(pauseTelegramUpdates).toHaveBeenCalledOnce();
      expect(resumeTelegramUpdates).not.toHaveBeenCalled();
      expect(idx.isInitialized()).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(pauseTelegramUpdates).toHaveBeenCalledTimes(2);
      expect(resumeTelegramUpdates).toHaveBeenCalledOnce();
      expect(idx.isInitialized()).toBe(true);

      stopChecks();
    });

    it('should detect missing entities', async () => {
      const idx = await getIndex();
      idx.set(createMockUser(), 1);
      // getAllEntities returns empty (mocked), so the user is "extra" in index
      const result = await idx.consistencyCheck();
      expect(result.extra).toContain('user:12345');
    });

    it('should return empty when consistent', async () => {
      const idx = await getIndex();
      // Both index and channel are empty
      const result = await idx.consistencyCheck();
      expect(result.missing).toHaveLength(0);
      expect(result.extra).toHaveLength(0);
    });
  });
});
