import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockResource, resetEnv, setupEnv } from './helpers';

describe('Resource service', () => {
  let index: {
    getFolder: ReturnType<typeof vi.fn>;
    getFolders: ReturnType<typeof vi.fn>;
    getByType: ReturnType<typeof vi.fn>;
    getResources: ReturnType<typeof vi.fn>;
    getResource: ReturnType<typeof vi.fn>;
    getResourceVersions: ReturnType<typeof vi.fn>;
    saveEntity: ReturnType<typeof vi.fn>;
    updateEntity: ReturnType<typeof vi.fn>;
    deleteEntity: ReturnType<typeof vi.fn>;
  };
  let storage: {
    deleteFile: ReturnType<typeof vi.fn>;
    hasStoredFile: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    setupEnv();
    vi.resetModules();
    index = {
      getFolder: vi.fn().mockReturnValue(undefined),
      getFolders: vi.fn().mockReturnValue([]),
      getByType: vi.fn().mockReturnValue([]),
      getResources: vi.fn().mockReturnValue([]),
      getResource: vi.fn(),
      getResourceVersions: vi.fn().mockReturnValue([]),
      saveEntity: vi.fn().mockResolvedValue(1),
      updateEntity: vi.fn().mockResolvedValue(undefined),
      deleteEntity: vi.fn().mockResolvedValue(undefined),
    };
    storage = {
      deleteFile: vi.fn(),
      hasStoredFile: vi.fn(),
    };
    vi.doMock('../telegram/index', () => ({ index }));
    vi.doMock('../telegram/storage', () => storage);
  });

  afterAll(() => {
    resetEnv();
  });

  it('rejects resources targeting a missing folder before persisting metadata', async () => {
    const { createResource } = await import('../services/resources');

    await expect(
      createResource(
        'Document',
        '',
        [],
        'application/pdf',
        1024,
        'folder:missing',
        1,
        'telegram-file-id',
        12345,
      ),
    ).rejects.toThrow('Active folder folder:missing not found');
    expect(index.saveEntity).not.toHaveBeenCalled();
  });

  it('prevents concurrent creation of duplicate resources for the same Telegram file', async () => {
    const { createResource } = await import('../services/resources');
    const create = () =>
      createResource(
        'Document',
        '',
        [],
        'application/pdf',
        1024,
        null,
        1,
        'telegram-file-id',
        12345,
      );

    const results = await Promise.allSettled([create(), create()]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('automatically suffixes duplicate resource titles and file names', async () => {
    index.getResources.mockReturnValue([
      createMockResource({
        id: 'resource:existing',
        title: 'Document',
        fileName: 'document.pdf',
        folderId: null,
      }),
    ]);
    const { createResource } = await import('../services/resources');

    const created = await createResource(
      'Document',
      '',
      [],
      'application/pdf',
      1024,
      null,
      1,
      'another-telegram-file-id',
      12345,
      'document.pdf',
    );

    expect(created).toMatchObject({
      title: 'Document (1)',
      fileName: 'document (1).pdf',
    });
  });

  it('allocates distinct names for concurrent uploads to the same directory', async () => {
    const savedResources: ReturnType<typeof createMockResource>[] = [];
    index.getResources.mockReturnValue(savedResources);
    index.saveEntity.mockImplementation(async (entity) => {
      if (entity.type === 'resource') savedResources.push(entity);
      return 1;
    });
    const { createResource } = await import('../services/resources');
    const create = (storageFileId: string) =>
      createResource(
        'Concurrent document.pdf',
        '',
        [],
        'application/pdf',
        1024,
        null,
        1,
        storageFileId,
        12345,
      );

    const results = await Promise.all([create('telegram-file-one'), create('telegram-file-two')]);

    expect(results.map((resource) => resource.title).sort()).toEqual([
      'Concurrent document (1).pdf',
      'Concurrent document.pdf',
    ]);
  });

  it('updates, trims, and persists resource metadata', async () => {
    const resource = createMockResource();
    index.getResource.mockReturnValue(resource);
    const { updateResource } = await import('../services/resources');

    await expect(
      updateResource(
        resource.id,
        {
          title: '  Updated title  ',
          description: '  Updated description  ',
          tags: [' alpha ', 'beta'],
          categoryId: '  Reports  ',
        },
        54321,
      ),
    ).resolves.toMatchObject({
      title: 'Updated title',
      description: 'Updated description',
      tags: ['alpha', 'beta'],
      categoryId: 'Reports',
    });
    expect(index.updateEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Updated title',
        description: 'Updated description',
        tags: ['alpha', 'beta'],
        categoryId: 'Reports',
      }),
    );
  });

  it('suffixes a resource title when it conflicts with another entry in the destination folder', async () => {
    const resource = createMockResource();
    index.getResource.mockReturnValue(resource);
    index.getResources.mockReturnValue([
      resource,
      createMockResource({
        id: 'resource:sibling',
        title: 'Updated title',
        fileName: 'sibling.pdf',
        folderId: resource.folderId,
      }),
    ]);
    const { updateResource } = await import('../services/resources');

    const updated = await updateResource(resource.id, { title: 'Updated title' }, 54321);

    expect(updated.title).toBe('Updated title (1)');
  });

  it('restores a resource with a unique name when its original name is now in use', async () => {
    const resource = createMockResource({ isDeleted: true, folderId: null });
    index.getResource.mockReturnValue(resource);
    index.getResources.mockReturnValue([
      resource,
      createMockResource({
        id: 'resource:sibling',
        title: resource.title,
        fileName: 'sibling.pdf',
        folderId: null,
      }),
    ]);
    const { restoreResource } = await import('../services/resources');

    const restored = await restoreResource(resource.id, 54321);

    expect(restored.title).toBe('Test Document (1).pdf');
    expect(restored.isDeleted).toBe(false);
    expect(restored.deletionBatchId).toBeUndefined();
  });

  it.each([
    [{ title: '   ' }, 'Resource title'],
    [{ description: 'x'.repeat(4001) }, 'Resource description'],
    [{ tags: Array.from({ length: 21 }, (_, index) => String(index)) }, 'Resource tags'],
    [{ categoryId: 'x'.repeat(101) }, 'Resource category'],
  ])('rejects invalid metadata updates', async (updates, message) => {
    const resource = createMockResource();
    index.getResource.mockReturnValue(resource);
    const { updateResource } = await import('../services/resources');

    await expect(updateResource(resource.id, updates, 54321)).rejects.toThrow(message);
    expect(index.updateEntity).not.toHaveBeenCalled();
  });

  it('retains the previous file as a version before updating the current resource', async () => {
    const resource = createMockResource();
    index.getResource.mockReturnValue(resource);
    const { createResourceVersion } = await import('../services/resources');

    const updated = await createResourceVersion(
      resource.id,
      {
        fileName: 'updated-document.pdf',
        fileType: 'application/pdf',
        fileSize: 2048,
        storageMessageId: 99,
        storageFileId: 'new-telegram-file-id',
      },
      54321,
    );

    expect(index.saveEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'resource_version',
        resourceId: resource.id,
        version: 1,
        storageMessageId: resource.storageMessageId,
        storageFileId: resource.storageFileId,
      }),
    );
    expect(index.updateEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        id: resource.id,
        version: 2,
        storageMessageId: 99,
        storageFileId: 'new-telegram-file-id',
        currentVersionUploaderId: 54321,
      }),
    );
    expect(updated.version).toBe(2);
  });

  it('includes the active resource in the version history', async () => {
    const resource = createMockResource({
      version: 2,
      fileName: 'current-document.pdf',
      storageMessageId: 99,
      storageFileId: 'current-telegram-file-id',
      currentVersionUploaderId: 54321,
    });
    const previousVersion = {
      type: 'resource_version',
      id: 'resource_version:def456-1',
      resourceId: resource.id,
      version: 1,
      fileName: 'previous-document.pdf',
      fileType: 'application/pdf',
      fileSize: 1024,
      storageMessageId: 42,
      storageFileId: 'previous-telegram-file-id',
      uploaderId: resource.uploaderId,
      createdAt: resource.createdAt,
      updatedAt: resource.updatedAt,
    };
    index.getResource.mockReturnValue(resource);
    index.getResourceVersions.mockReturnValue([previousVersion]);
    const { getResourceVersions } = await import('../services/resources');

    const versions = getResourceVersions(resource.id);

    expect(versions.map((version) => version.version)).toEqual([1, 2]);
    expect(versions[1]).toMatchObject({
      fileName: 'current-document.pdf',
      storageMessageId: 99,
      storageFileId: 'current-telegram-file-id',
      uploaderId: 54321,
    });
  });

  it('deletes every retained version file when permanently deleting a resource', async () => {
    const resource = createMockResource({ isDeleted: true });
    const previousVersion = {
      type: 'resource_version',
      id: 'resource_version:def456-1',
      resourceId: resource.id,
      version: 1,
      fileName: resource.title,
      fileType: resource.fileType,
      fileSize: resource.fileSize,
      storageMessageId: 41,
      storageFileId: 'old-telegram-file-id',
      uploaderId: resource.uploaderId,
      createdAt: resource.createdAt,
      updatedAt: resource.updatedAt,
    };
    index.getResource.mockReturnValue(resource);
    index.getResourceVersions.mockReturnValue([previousVersion]);
    storage.hasStoredFile.mockResolvedValue(true);
    storage.deleteFile.mockResolvedValue(true);
    const { permanentDeleteResource } = await import('../services/resources');

    await permanentDeleteResource(resource.id, 12345);

    expect(storage.deleteFile.mock.calls.map(([messageId]) => messageId)).toEqual([42, 41]);
    expect(index.deleteEntity).toHaveBeenNthCalledWith(1, previousVersion.id);
    expect(index.deleteEntity).toHaveBeenNthCalledWith(2, resource.id);
  });

  it('does not remove a new file if audit persistence fails after the resource update commits', async () => {
    const resource = createMockResource();
    index.getResource.mockReturnValue(resource);
    index.saveEntity.mockImplementation(async (entity) => {
      if (entity.type === 'audit') throw new Error('Audit channel unavailable');
      return 1;
    });
    const { createResourceVersion } = await import('../services/resources');

    await expect(
      createResourceVersion(
        resource.id,
        {
          fileName: 'updated-document.pdf',
          fileType: 'application/pdf',
          fileSize: 2048,
          storageMessageId: 99,
          storageFileId: 'new-telegram-file-id',
        },
        54321,
      ),
    ).rejects.toThrow('Audit channel unavailable');

    expect(index.updateEntity).toHaveBeenCalledWith(
      expect.objectContaining({ storageMessageId: 99, version: 2 }),
    );
    expect(storage.deleteFile).not.toHaveBeenCalled();
  });

  it('keeps resource metadata when deleting its storage message fails', async () => {
    const resource = createMockResource({ isDeleted: true });
    index.getResource.mockReturnValue(resource);
    storage.hasStoredFile.mockResolvedValue(true);
    storage.deleteFile.mockRejectedValue(new Error('Telegram unavailable'));
    const { permanentDeleteResource } = await import('../services/resources');

    await expect(permanentDeleteResource(resource.id, 12345)).rejects.toThrow(
      'Telegram unavailable',
    );

    expect(index.deleteEntity).not.toHaveBeenCalled();
  });
});
