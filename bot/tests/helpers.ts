/**
 * Test helpers and utilities for MiniStore tests.
 * Provides mock environment setup, entity factories, and mocked Telegram API.
 */

// Save original env once
export const originalEnv = process.env;

/**
 * Set up test environment variables.
 */
export function setupEnv(overrides: Record<string, string> = {}) {
  process.env = {
    BOT_TOKEN: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
    API_ID: '123',
    API_HASH: 'test_api_hash_value_here_for_testing',
    TELEGRAM_USER_SESSION: 'test-telegram-user-session',
    WEBHOOK_URL: 'https://ministore.example.test/telegram/webhook',
    WEBHOOK_SECRET: 'test-webhook-secret-value-with-32-characters',
    AI_BASE_URL: 'https://ai.example.test/v1',
    API_KEY: 'test-ai-provider-key',
    AI_MODEL: 'test-model',
    STORAGE_CHANNEL_ID: '-1001234567890',
    MANAGEMENT_CHANNEL_ID: '-1009876543210',
    OWNER_ID: '1',
    NODE_ENV: 'test',
    ...overrides,
  };
}

/**
 * Reset environment to original state.
 */
export function resetEnv() {
  process.env = originalEnv;
}

/**
 * Create a mock UserEntity for testing.
 */
export function createMockUser(overrides: any = {}) {
  return {
    type: 'user' as const,
    id: 'user:12345' as `user:${number}`,
    telegramId: 12345,
    username: 'testuser',
    firstName: 'Test',
    lastName: 'User',
    role: 'user' as const,
    status: 'active' as const,
    permissions: [],
    favorites: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create a mock FolderEntity for testing.
 */
export function createMockFolder(overrides: any = {}) {
  return {
    type: 'folder' as const,
    id: 'folder:abc123' as `folder:${string}`,
    name: 'Test Folder',
    parentId: null,
    creatorId: 12345,
    isDeleted: false,
    deletedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create a mock ResourceEntity for testing.
 */
export function createMockResource(overrides: any = {}) {
  return {
    type: 'resource' as const,
    id: 'resource:def456' as `resource:${string}`,
    title: 'Test Document.pdf',
    description: 'A test document',
    tags: ['test', 'document'],
    categoryId: null,
    fileType: 'application/pdf',
    fileSize: 1024,
    folderId: 'folder:abc123' as `folder:${string}` | null,
    storageMessageId: 42,
    storageFileId: 'AgACAgIAAxkB',
    uploaderId: 12345,
    version: 1,
    downloadCount: 0,
    isDeleted: false,
    deletedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create a mock AuditEntity for testing.
 */
export function createMockAudit(overrides: any = {}) {
  return {
    type: 'audit' as const,
    id: 'audit:789' as `audit:${string}`,
    actorId: 12345,
    action: 'user.approved',
    targetId: 'user:67890',
    metadata: { previousStatus: 'pending' },
    timestamp: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}
