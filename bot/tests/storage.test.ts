/**
 * Unit tests for storage channel utilities (storage/storage.ts).
 * Tests file size formatting for stored Telegram media.
 */

import { describe, it, expect } from 'vitest';
import { setupEnv, resetEnv } from './helpers';

describe('Storage Utilities', () => {
  beforeEach(() => {
    setupEnv();
  });

  afterAll(() => {
    resetEnv();
  });

  describe('formatFileSize', () => {
    async function getFormatFileSize() {
      const mod = await import('../telegram/storage');
      return mod.formatFileSize;
    }

    it('should format bytes', async () => {
      const fn = await getFormatFileSize();
      expect(fn(0)).toBe('0 B');
      expect(fn(500)).toBe('500.0 B');
    });

    it('should format kilobytes', async () => {
      const fn = await getFormatFileSize();
      expect(fn(1024)).toBe('1.0 KB');
      expect(fn(2048)).toBe('2.0 KB');
    });

    it('should format megabytes', async () => {
      const fn = await getFormatFileSize();
      expect(fn(1048576)).toBe('1.0 MB');
    });

    it('should format gigabytes', async () => {
      const fn = await getFormatFileSize();
      expect(fn(1073741824)).toBe('1.0 GB');
    });
  });
});
