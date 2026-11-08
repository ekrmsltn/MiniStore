/**
 * Unit tests for configuration.
 * Tests environment variable validation and defaults.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupEnv, resetEnv } from './helpers';

describe('Configuration', () => {
  beforeEach(() => {
    setupEnv();
    vi.resetModules();
  });

  afterAll(() => {
    resetEnv();
  });

  describe('loadConfig', () => {
    it('should load valid config', async () => {
      const { loadConfig } = await import('../config');
      const config = loadConfig();
      expect(config.botToken).toBe('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11');
      expect(config.ownerId).toBe(1);
      expect(config.port).toBe(3000);
      expect(config.nodeEnv).toBe('test');
      expect(config.telegramUserSession).toBe('test-telegram-user-session');
    });

    it('should use default port', async () => {
      const { loadConfig } = await import('../config');
      const config = loadConfig();
      expect(config.port).toBe(3000);
    });

    it('should use custom port', async () => {
      process.env.PORT = '8080';
      vi.resetModules();
      const { loadConfig } = await import('../config');
      const config = loadConfig();
      expect(config.port).toBe(8080);
    });

    it('requires an AI provider configuration to start MiniStore', async () => {
      delete process.env.AI_BASE_URL;
      delete process.env.API_KEY;
      delete process.env.AI_MODEL;
      delete process.env.AI_API_FORMAT;
      vi.resetModules();
      const { loadConfig } = await import('../config');

      expect(() => loadConfig()).toThrow(
        'AI_BASE_URL, API_KEY, and AI_MODEL are required to start MiniStore',
      );
      expect(loadConfig({ requireAI: false })).toMatchObject({
        aiBaseUrl: null,
        apiKey: null,
        aiModel: null,
        aiApiFormat: 'openai-compatible',
      });
    });

    it('rejects example AI credentials at runtime', async () => {
      process.env.API_KEY = 'replace_with_your_provider_key';
      vi.resetModules();
      const { loadConfig } = await import('../config');

      expect(() => loadConfig()).toThrow(
        'Replace the AI example values with your provider configuration',
      );

      process.env.API_KEY = 'test-ai-provider-key';
      process.env.AI_BASE_URL = 'https://api.example.com/v1';
      vi.resetModules();
      const { loadConfig: loadExampleUrlConfig } = await import('../config');

      expect(() => loadExampleUrlConfig()).toThrow(
        'Replace the AI example values with your provider configuration',
      );
    });

    it('loads provider settings without requiring a specific AI vendor', async () => {
      process.env.AI_BASE_URL = 'https://ai.example.test/v1';
      process.env.API_KEY = 'test-ai-provider-key';
      process.env.AI_MODEL = 'provider-selected-model';
      process.env.AI_API_FORMAT = 'anthropic';
      vi.resetModules();
      const { loadConfig } = await import('../config');

      expect(loadConfig()).toMatchObject({
        aiBaseUrl: 'https://ai.example.test/v1',
        apiKey: 'test-ai-provider-key',
        aiModel: 'provider-selected-model',
        aiApiFormat: 'anthropic',
      });
    });

    it('requires the AI base URL, key, and model together', async () => {
      delete process.env.AI_BASE_URL;
      delete process.env.AI_MODEL;
      vi.resetModules();
      const { loadConfig } = await import('../config');

      expect(() => loadConfig()).toThrow(
        'AI_BASE_URL, API_KEY, and AI_MODEL must all be set together',
      );
    });

    it('rejects insecure remote AI endpoints in production', async () => {
      process.env.NODE_ENV = 'production';
      process.env.AI_BASE_URL = 'http://ai.example.test/v1';
      process.env.API_KEY = 'test-ai-provider-key';
      process.env.AI_MODEL = 'provider-selected-model';
      vi.resetModules();
      const { loadConfig } = await import('../config');

      expect(() => loadConfig()).toThrow('AI_BASE_URL must use HTTPS in production');
    });

    it('should throw on missing BOT_TOKEN', async () => {
      delete process.env.BOT_TOKEN;
      vi.resetModules();
      const { loadConfig } = await import('../config');
      expect(() => loadConfig()).toThrow('Missing required environment variable: BOT_TOKEN');
    });

    it('should throw on missing OWNER_ID', async () => {
      delete process.env.OWNER_ID;
      vi.resetModules();
      const { loadConfig } = await import('../config');
      expect(() => loadConfig()).toThrow('Missing required environment variable: OWNER_ID');
    });

    it('should throw when the required owner session is missing', async () => {
      delete process.env.TELEGRAM_USER_SESSION;
      vi.resetModules();
      const { loadConfig } = await import('../config');
      expect(() => loadConfig()).toThrow(
        'Missing required environment variable: TELEGRAM_USER_SESSION',
      );
    });

    it('allows the session-generation command to load config before an owner session exists', async () => {
      delete process.env.TELEGRAM_USER_SESSION;
      vi.resetModules();
      const { loadConfig } = await import('../config');

      expect(loadConfig({ requireTelegramUserSession: false }).telegramUserSession).toBeNull();
    });

    it('requires webhook settings for bot startup', async () => {
      delete process.env.WEBHOOK_URL;
      delete process.env.WEBHOOK_SECRET;
      vi.resetModules();
      const { loadConfig } = await import('../config');

      expect(() => loadConfig()).toThrow(
        'WEBHOOK_URL and WEBHOOK_SECRET are required to run in webhook mode',
      );
      expect(loadConfig({ requireWebhook: false }).webhookUrl).toBeNull();
    });

    it('derives the webhook URL from the Render service URL when no override is set', async () => {
      delete process.env.WEBHOOK_URL;
      process.env.RENDER_EXTERNAL_URL = 'https://ministore.example.onrender.com/';
      vi.resetModules();
      const { loadConfig } = await import('../config');

      expect(loadConfig().webhookUrl).toBe(
        'https://ministore.example.onrender.com/telegram/webhook',
      );
    });

    it('prefers an explicit webhook URL over the Render service URL', async () => {
      process.env.RENDER_EXTERNAL_URL = 'https://ministore.example.onrender.com';
      process.env.WEBHOOK_URL = 'https://custom.example.com/telegram/webhook';
      vi.resetModules();
      const { loadConfig } = await import('../config');

      expect(loadConfig().webhookUrl).toBe('https://custom.example.com/telegram/webhook');
    });

    it('requires a public HTTPS webhook URL on the configured route', async () => {
      process.env.WEBHOOK_URL = 'http://ministore.example.test/telegram/webhook';
      vi.resetModules();
      const { loadConfig } = await import('../config');

      expect(() => loadConfig()).toThrow(
        'WEBHOOK_URL must be HTTPS and end with /telegram/webhook',
      );
    });

    it('rejects weak or unsupported webhook secrets', async () => {
      process.env.WEBHOOK_SECRET = 'short';
      vi.resetModules();
      const { loadConfig } = await import('../config');

      expect(() => loadConfig()).toThrow(
        'WEBHOOK_SECRET must be 32-256 characters using only letters, numbers, "_" or "-"',
      );
    });

    it('should throw on invalid BOT_TOKEN format', async () => {
      process.env.BOT_TOKEN = 'invalid-token';
      vi.resetModules();
      const { loadConfig } = await import('../config');
      expect(() => loadConfig()).toThrow('BOT_TOKEN format is invalid');
    });

    it('rejects a non-positive OWNER_ID', async () => {
      process.env.OWNER_ID = 'not-a-number';
      vi.resetModules();
      const { loadConfig } = await import('../config');
      expect(() => loadConfig()).toThrow('OWNER_ID must be a positive safe integer');
    });

    it('rejects malformed private channel IDs before startup', async () => {
      process.env.MANAGEMENT_CHANNEL_ID = '12345';
      vi.resetModules();
      const { loadConfig } = await import('../config');
      expect(() => loadConfig()).toThrow(
        'MANAGEMENT_CHANNEL_ID must be a valid -100... channel ID',
      );
    });

    it('rejects invalid ports rather than silently using the default', async () => {
      process.env.PORT = 'not-a-port';
      vi.resetModules();
      const { loadConfig } = await import('../config');
      expect(() => loadConfig()).toThrow('PORT must be a safe integer');
    });

    it('rejects ports outside the valid TCP range', async () => {
      process.env.PORT = '65536';
      vi.resetModules();
      const { loadConfig } = await import('../config');
      expect(() => loadConfig()).toThrow('PORT must be an integer between 1 and 65535');
    });
  });
});
