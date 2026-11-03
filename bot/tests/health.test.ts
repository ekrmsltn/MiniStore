import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { Bot } from 'grammy';
import request from 'supertest';
import { resetEnv, setupEnv } from './helpers';

describe('Operational HTTP endpoints', () => {
  let app: Express;
  let index: typeof import('../telegram/index').index;
  let setWebhookReady: typeof import('../webhook').setWebhookReady;
  let registerTelegramWebhook: typeof import('../webhook').registerTelegramWebhook;
  let telegramWebhookRouter: typeof import('../webhook').telegramWebhookRouter;

  beforeAll(async () => {
    setupEnv();
    vi.resetModules();
    ({ default: app } = await import('../health'));
    ({ index } = await import('../telegram/index'));
    ({ registerTelegramWebhook, setWebhookReady, telegramWebhookRouter } =
      await import('../webhook'));
  });

  afterAll(() => {
    resetEnv();
  });

  beforeEach(() => {
    index.clear();
    setWebhookReady(false);
  });

  it('reports index readiness from the health endpoint', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('unavailable');
    expect(response.body.timestamp).toBeTypeOf('string');
  });

  it('reports service initialization status', async () => {
    const response = await request(app).get('/api/status');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      service: 'ministore',
      status: 'initializing',
    });
  });

  it('routes webhook requests before the not-found handler', async () => {
    const secretToken = 'test-webhook-secret-value-with-32-characters';
    const bot = new Bot('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11');
    vi.spyOn(bot, 'init').mockResolvedValue(undefined);
    const handleUpdate = vi.spyOn(bot, 'handleUpdate').mockResolvedValue(undefined);
    registerTelegramWebhook(telegramWebhookRouter, bot, secretToken);
    setWebhookReady(true);

    const response = await request(app)
      .post('/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', secretToken)
      .send({ update_id: 1 });

    expect(response.status).toBe(200);
    expect(handleUpdate).toHaveBeenCalledWith({ update_id: 1 }, expect.any(Object));
  });

  it.each(['/api/auth/login', '/api/resources', '/api/users'])(
    'does not expose removed user-facing route %s',
    async (path) => {
      const response = await request(app).get(path);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('NotFound');
    },
  );
});
