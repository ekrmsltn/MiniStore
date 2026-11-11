import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockFolder, createMockResource, resetEnv, setupEnv } from './helpers';

describe('Store screen navigation', () => {
  const root = createMockFolder({ id: 'folder:root-folder', name: 'Root folder' });
  const parent = createMockFolder({
    id: 'folder:parent',
    name: 'Parent',
    parentId: root.id,
  });
  const current = createMockFolder({
    id: 'folder:current',
    name: 'Current',
    parentId: parent.id,
  });
  const resource = createMockResource({
    id: 'resource:file',
    title: 'Document',
    folderId: current.id,
  });
  const index = {
    getFolder: vi.fn(),
    getChildFolders: vi.fn(),
    getRootFolders: vi.fn(),
    getResources: vi.fn(),
    isInitialized: vi.fn(() => true),
  };
  const users = {
    canAccessStore: vi.fn(() => true),
    getUserById: vi.fn(() => ({ favorites: [resource.id] })),
    isAdmin: vi.fn(() => false),
  };
  const permissions = { hasPermission: vi.fn(() => false) };
  const visibility = {
    canAccessFolder: vi.fn(() => true),
    canAccessResource: vi.fn(() => true),
  };

  beforeEach(() => {
    setupEnv();
    vi.resetModules();
    index.getFolder.mockImplementation((id: string) =>
      [root, parent, current].find((folder) => folder.id === id),
    );
    index.getChildFolders.mockReturnValue([]);
    index.getRootFolders.mockReturnValue([]);
    index.getResources.mockReturnValue([resource]);
    users.getUserById.mockReturnValue({ favorites: [resource.id] });
    vi.doMock('../telegram/index', () => ({ index }));
    vi.doMock('../services/users', () => users);
    vi.doMock('../services/resources', () => ({
      getResource: (id: string) => (id === resource.id ? resource : undefined),
      getResourceVersions: () => [],
      searchResources: () => [resource],
    }));
    vi.doMock('../services/permissions', () => permissions);
    vi.doMock('../services/visibility', () => visibility);
    vi.doMock('../services/assistant', () => ({ isAssistantConfigured: () => false }));
    vi.doMock('../services/folders', () => ({
      getFolderBreadcrumb: () => [root, parent, current],
    }));
    vi.doMock('../telegram/storage', () => ({ formatFileSize: () => '1 KB' }));
  });

  afterAll(() => resetEnv());

  it('provides ancestor navigation and returns file details to the same folder page', async () => {
    const { showBrowse } = await import('../handlers/screens');
    const ctx = {
      from: { id: 12345 },
      reply: vi.fn(),
    };

    await showBrowse(ctx as never, current.id, 0, 'recent');

    const keyboard = ctx.reply.mock.calls[0][1].reply_markup;
    const buttons = keyboard.inline_keyboard.flat();
    expect(buttons.map((button: { callback_data?: string }) => button.callback_data)).toContain(
      'lib:browse:root',
    );
    expect(buttons.map((button: { callback_data?: string }) => button.callback_data)).toContain(
      'lib:browse:root-folder',
    );
    expect(buttons.map((button: { callback_data?: string }) => button.callback_data)).toContain(
      'lib:browse:parent',
    );
    expect(buttons.map((button: { callback_data?: string }) => button.callback_data)).toContain(
      'lib:resource:file|lib:b:current:0:r',
    );
  });

  it('preserves search and favorites as the return destination from resource details', async () => {
    const { showFavorites, showSearchResults } = await import('../handlers/screens');
    const ctx = {
      from: { id: 12345 },
      reply: vi.fn(),
    };

    await showSearchResults(ctx as never, 'document');
    const searchButton = ctx.reply.mock.calls[0][1].reply_markup.inline_keyboard
      .flat()
      .find((button: { callback_data?: string }) =>
        button.callback_data?.startsWith('lib:resource:'),
      );
    expect(searchButton.callback_data).toMatch(/^lib:resource:file\|lib:search-results:/);

    await showFavorites(ctx as never);
    const favoriteButton = ctx.reply.mock.calls[1][1].reply_markup.inline_keyboard
      .flat()
      .find((button: { callback_data?: string }) =>
        button.callback_data?.startsWith('lib:resource:'),
      );
    expect(favoriteButton.callback_data).toBe('lib:resource:file|lib:favorites');
  });
});
