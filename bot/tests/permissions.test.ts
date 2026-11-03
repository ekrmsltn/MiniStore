import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockUser, resetEnv, setupEnv } from './helpers';

describe('Bot permissions', () => {
  beforeEach(async () => {
    setupEnv();
    vi.resetModules();
    const { index } = await import('../telegram/index');
    index.clear();
  });

  afterAll(() => {
    resetEnv();
  });

  it('grants the owner every permission', async () => {
    const { hasPermission, AVAILABLE_PERMISSIONS } = await import('../services/permissions');

    for (const permission of AVAILABLE_PERMISSIONS) {
      expect(hasPermission(1, permission)).toBe(true);
    }
  });

  it('grants only assigned permissions to active admins', async () => {
    const { index } = await import('../telegram/index');
    const { hasPermission } = await import('../services/permissions');

    index.set(createMockUser({
      telegramId: 12345,
      id: 'user:12345',
      role: 'admin',
      permissions: ['upload_resources'],
    }), null);

    expect(hasPermission(12345, 'upload_resources')).toBe(true);
    expect(hasPermission(12345, 'delete_resources')).toBe(false);
  });

  it('denies permissions to suspended admins', async () => {
    const { index } = await import('../telegram/index');
    const { hasPermission } = await import('../services/permissions');

    index.set(createMockUser({
      telegramId: 12345,
      id: 'user:12345',
      role: 'admin',
      status: 'suspended',
      permissions: ['upload_resources'],
    }), null);

    expect(hasPermission(12345, 'upload_resources')).toBe(false);
  });
});
