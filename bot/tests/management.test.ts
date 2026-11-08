import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupEnv, resetEnv, createMockUser } from './helpers';

const mtprotoMocks = vi.hoisted(() => ({
  iterateChannelHistory: vi.fn(),
  getChannelMessage: vi.fn(),
  checkChannelReadAccess: vi.fn(),
}));

vi.mock('../telegram/mtproto', () => mtprotoMocks);

describe('Management channel persistence', () => {
  beforeEach(() => {
    setupEnv();
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterAll(() => resetEnv());

  it('rebuilds entity records from channel history with their source message IDs', async () => {
    const user = createMockUser();
    mtprotoMocks.iterateChannelHistory.mockImplementation(async function* () {
      yield { id: 8, message: 'New access request from user' };
      yield { id: 9, message: JSON.stringify(user) };
    });

    const { getAllEntityRecords } = await import('../telegram/management');
    await expect(getAllEntityRecords()).resolves.toEqual([{ entity: user, messageId: 9 }]);
  });

  it('accepts persistent session records without storing bearer tokens', async () => {
    const session = {
      type: 'session',
      id: `session:${'a'.repeat(64)}`,
      telegramId: 12345,
      expiresAt: Date.now() + 60_000,
      revoked: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mtprotoMocks.iterateChannelHistory.mockImplementation(async function* () {
      yield { id: 12, message: JSON.stringify(session) };
    });

    const { getAllEntityRecords } = await import('../telegram/management');
    await expect(getAllEntityRecords()).resolves.toEqual([{ entity: session, messageId: 12 }]);
  });

  it('accepts persistent assistant usage windows without storing prompts', async () => {
    const usage = {
      type: 'assistant_usage',
      id: 'assistant_usage:12345',
      telegramId: 12345,
      requestTimestamps: [new Date().toISOString()],
      windowStartedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mtprotoMocks.iterateChannelHistory.mockImplementation(async function* () {
      yield { id: 14, message: JSON.stringify(usage) };
    });

    const { getAllEntityRecords } = await import('../telegram/management');
    await expect(getAllEntityRecords()).resolves.toEqual([{ entity: usage, messageId: 14 }]);
  });

  it('rejects assistant usage records with an invalid quota window start', async () => {
    mtprotoMocks.iterateChannelHistory.mockImplementation(async function* () {
      yield {
        id: 15,
        message: JSON.stringify({
          type: 'assistant_usage',
          id: 'assistant_usage:12345',
          telegramId: 12345,
          requestTimestamps: [new Date().toISOString()],
          windowStartedAt: 'not-a-date',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      };
    });

    const { getAllEntityRecords } = await import('../telegram/management');
    await expect(getAllEntityRecords()).rejects.toThrow('not a valid MiniStore entity');
  });

  it('restores resource version records from channel history', async () => {
    const version = {
      type: 'resource_version',
      id: 'resource_version:def456-1',
      resourceId: 'resource:def456',
      version: 1,
      fileName: 'document.pdf',
      fileType: 'application/pdf',
      fileSize: 1024,
      storageMessageId: 42,
      storageFileId: 'telegram-file-id',
      uploaderId: 12345,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mtprotoMocks.iterateChannelHistory.mockImplementation(async function* () {
      yield { id: 13, message: JSON.stringify(version) };
    });

    const { getAllEntityRecords } = await import('../telegram/management');
    await expect(getAllEntityRecords()).resolves.toEqual([{ entity: version, messageId: 13 }]);
  });

  it('fails closed on malformed entity-shaped channel messages', async () => {
    mtprotoMocks.iterateChannelHistory.mockImplementation(async function* () {
      yield { id: 10, message: '{"type":"user","id":' };
    });

    const { getAllEntityRecords } = await import('../telegram/management');
    await expect(getAllEntityRecords()).rejects.toThrow('contains malformed entity JSON');
  });

  it('does not silently treat an invalid entity record as a successful read', async () => {
    mtprotoMocks.iterateChannelHistory.mockImplementation(async function* () {
      yield {
        id: 11,
        message: JSON.stringify({ type: 'user', id: 'user:1' }),
      };
    });

    const { getAllEntityRecords } = await import('../telegram/management');
    await expect(getAllEntityRecords()).rejects.toThrow('not a valid MiniStore entity');
  });
});
