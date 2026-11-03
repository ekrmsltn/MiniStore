/**
 * Application configuration loaded from environment variables.
 * Validates required fields at startup.
 * Includes security-related settings.
 */

// Load .env file FIRST, before any other code accesses environment variables.
// Load environment values before modules initialize their clients.
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

export const TELEGRAM_WEBHOOK_PATH = '/telegram/webhook';

// Find .env at the repository root from source, compiled, or package cwd.
// Skip in test environment — tests set process.env directly via helpers
if (process.env.NODE_ENV !== 'test') {
  const envPath = [
    path.resolve(__dirname, '../.env'),
    path.resolve(__dirname, '../../.env'),
    path.resolve(process.cwd(), '../.env'),
    path.resolve(process.cwd(), '.env'),
  ].find((candidate) => fs.existsSync(candidate));
  if (envPath) {
    dotenv.config({ path: envPath });
  }
}

export interface AppConfig {
  botToken: string;
  apiId: string;
  apiHash: string;
  telegramUserSession: string | null;
  webhookUrl: string | null;
  webhookSecret: string | null;
  storageChannelId: string;
  managementChannelId: string;
  ownerId: number;
  port: number;
  nodeEnv: string;
  aiBaseUrl: string | null;
  apiKey: string | null;
  aiModel: string | null;
  aiApiFormat: 'openai-compatible' | 'anthropic';
}

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  // Validate that secrets are not placeholder values
  if (value === 'CHANGE_ME' || value === 'your_' + key.toLowerCase()) {
    throw new Error(`Environment variable ${key} has not been set to a secure value`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function optionalNumberEnv(key: string, fallback: number): number {
  const value = process.env[key];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Environment variable ${key} must be a safe integer`);
  }
  return parsed;
}

function positiveIntegerEnv(key: string): number {
  const value = Number(requiredEnv(key));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${key} must be a positive safe integer`);
  }
  return value;
}

function privateChannelIdEnv(key: string): string {
  const value = requiredEnv(key);
  const channelId = Number(value);
  if (!/^-100\d+$/.test(value) || !Number.isSafeInteger(channelId)) {
    throw new Error(`Environment variable ${key} must be a valid -100... channel ID`);
  }
  return value;
}

export function loadConfig(
  options: {
    requireTelegramUserSession?: boolean;
    requireWebhook?: boolean;
    requireAI?: boolean;
  } = {},
): AppConfig {
  const telegramUserSession = process.env.TELEGRAM_USER_SESSION?.trim() || null;
  const webhookUrl = process.env.WEBHOOK_URL?.trim() || null;
  const webhookSecret = process.env.WEBHOOK_SECRET?.trim() || null;
  const aiBaseUrl = process.env.AI_BASE_URL?.trim() || null;
  const apiKey = process.env.API_KEY?.trim() || null;
  const aiModel = process.env.AI_MODEL?.trim() || null;
  const rawAiApiFormat = process.env.AI_API_FORMAT?.trim() || 'openai-compatible';
  if (rawAiApiFormat !== 'openai-compatible' && rawAiApiFormat !== 'anthropic') {
    throw new Error('AI_API_FORMAT must be "openai-compatible" or "anthropic"');
  }

  if (options.requireTelegramUserSession !== false && !telegramUserSession) {
    throw new Error('Missing required environment variable: TELEGRAM_USER_SESSION');
  }
  if (options.requireWebhook !== false && (!webhookUrl || !webhookSecret)) {
    throw new Error('WEBHOOK_URL and WEBHOOK_SECRET are required to run in webhook mode');
  }
  if (Boolean(webhookUrl) !== Boolean(webhookSecret)) {
    throw new Error('WEBHOOK_URL and WEBHOOK_SECRET must be set together');
  }
  const hasAiSetting = Boolean(aiBaseUrl || apiKey || aiModel || process.env.AI_API_FORMAT);
  if (hasAiSetting && (!aiBaseUrl || !apiKey || !aiModel)) {
    throw new Error('AI_BASE_URL, API_KEY, and AI_MODEL must all be set together');
  }
  if (options.requireAI !== false && (!aiBaseUrl || !apiKey || !aiModel)) {
    throw new Error('AI_BASE_URL, API_KEY, and AI_MODEL are required to start MiniStore');
  }
  if (
    options.requireAI !== false &&
    (aiBaseUrl === 'https://api.example.com/v1' ||
      [aiBaseUrl, apiKey, aiModel].some(
        (value) => value !== null && /^(?:replace_with_|your_|change_me)/i.test(value),
      ))
  ) {
    throw new Error('Replace the AI example values with your provider configuration');
  }

  if (webhookUrl) {
    let parsedWebhookUrl: URL;
    try {
      parsedWebhookUrl = new URL(webhookUrl);
    } catch {
      throw new Error('WEBHOOK_URL must be a valid public HTTPS URL');
    }
    if (
      parsedWebhookUrl.protocol !== 'https:' ||
      parsedWebhookUrl.username ||
      parsedWebhookUrl.password ||
      parsedWebhookUrl.search ||
      parsedWebhookUrl.hash ||
      parsedWebhookUrl.pathname !== TELEGRAM_WEBHOOK_PATH
    ) {
      throw new Error(`WEBHOOK_URL must be HTTPS and end with ${TELEGRAM_WEBHOOK_PATH}`);
    }
  }

  if (webhookSecret && !/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret)) {
    throw new Error(
      'WEBHOOK_SECRET must be 32-256 characters using only letters, numbers, "_" or "-"',
    );
  }

  const config: AppConfig = {
    botToken: requiredEnv('BOT_TOKEN'),
    apiId: String(positiveIntegerEnv('API_ID')),
    apiHash: requiredEnv('API_HASH'),
    telegramUserSession,
    webhookUrl,
    webhookSecret,
    storageChannelId: privateChannelIdEnv('STORAGE_CHANNEL_ID'),
    managementChannelId: privateChannelIdEnv('MANAGEMENT_CHANNEL_ID'),
    ownerId: positiveIntegerEnv('OWNER_ID'),
    port: optionalNumberEnv('PORT', 3000),
    nodeEnv: optionalEnv('NODE_ENV', 'development'),
    aiBaseUrl,
    apiKey,
    aiModel,
    aiApiFormat: rawAiApiFormat,
  };

  if (config.aiBaseUrl) {
    let aiUrl: URL;
    try {
      aiUrl = new URL(config.aiBaseUrl);
    } catch {
      throw new Error('AI_BASE_URL must be a valid HTTP(S) URL');
    }
    if (
      !['https:', 'http:'].includes(aiUrl.protocol) ||
      aiUrl.username ||
      aiUrl.password ||
      aiUrl.search ||
      aiUrl.hash
    ) {
      throw new Error(
        'AI_BASE_URL must be an HTTP(S) base URL without credentials, query, or fragment',
      );
    }
    if (
      config.nodeEnv === 'production' &&
      aiUrl.protocol !== 'https:' &&
      !['localhost', '127.0.0.1', '::1'].includes(aiUrl.hostname)
    ) {
      throw new Error('AI_BASE_URL must use HTTPS in production');
    }
  }

  if (config.port < 1 || config.port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  // Validate bot token format (basic check)
  if (!config.botToken.match(/^\d+:[A-Za-z0-9_-]+$/)) {
    throw new Error('BOT_TOKEN format is invalid');
  }

  return config;
}
