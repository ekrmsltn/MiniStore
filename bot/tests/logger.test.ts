import { afterEach, describe, expect, it } from 'vitest';
import { redactLogLine, serializeErrorForLog } from '../logger';

describe('error logging', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('redacts bot tokens embedded in Telegram API URLs', () => {
    const error = new Error(
      'Request to https://api.telegram.org/bot123456:secret-token/sendMessage failed',
    );

    const serialized = JSON.stringify(serializeErrorForLog(error));

    expect(serialized).toContain('https://api.telegram.org/bot[REDACTED]');
    expect(serialized).not.toContain('123456:secret-token');
  });

  it('redacts tokens in nested error causes', () => {
    const cause = new Error(
      'Request to https://api.telegram.org/bot123456:secret-token/sendMessage failed',
    );
    const error = new Error('Telegram request failed', { cause });

    const serialized = JSON.stringify(serializeErrorForLog(error));

    expect(serialized).toContain('https://api.telegram.org/bot[REDACTED]');
    expect(serialized).not.toContain('123456:secret-token');
  });

  it('redacts configured secrets, credential fields, and identifier fields from full log lines', () => {
    process.env.API_HASH = 'private-api-hash-value';
    process.env.TELEGRAM_USER_SESSION = 'private-owner-session-value';
    process.env.API_KEY = 'private-ai-api-key-value';
    process.env.OWNER_ID = '123456789';

    const line = JSON.stringify({
      msg: 'Request failed using private-api-hash-value and owner 123456789',
      err: { message: 'Session private-owner-session-value failed' },
      requestHeaders: { authorization: 'Bearer private-ai-api-key-value' },
      botToken: 'top-secret-token',
      userId: 123456789,
      channel_id: '-1001234567890',
      updateType: 'message',
    });

    const redacted = redactLogLine(`${line}\n`);

    expect(redacted).not.toContain('private-api-hash-value');
    expect(redacted).not.toContain('private-owner-session-value');
    expect(redacted).not.toContain('private-ai-api-key-value');
    expect(redacted).not.toContain('top-secret-token');
    expect(redacted).not.toContain('123456789');
    expect(redacted).not.toContain('-1001234567890');
    expect(redacted).toContain('"userId":"[ID]"');
    expect(redacted).toContain('"channel_id":"[ID]"');
    expect(redacted).toContain('"updateType":"message"');
    expect(redacted.endsWith('\n')).toBe(true);
  });

  it('redacts webhook secrets in request headers', () => {
    process.env.WEBHOOK_SECRET = 'private-webhook-secret-value';
    const line = JSON.stringify({
      headers: { 'x-telegram-bot-api-secret-token': 'private-webhook-secret-value' },
    });

    expect(redactLogLine(line)).not.toContain('private-webhook-secret-value');
  });
});
