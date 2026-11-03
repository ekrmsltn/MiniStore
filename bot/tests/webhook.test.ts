import express from 'express';
import { Bot } from 'grammy';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TELEGRAM_WEBHOOK_PATH } from '../config';
import { registerTelegramWebhook, setWebhookReady } from '../webhook';

const secretToken = 'test-webhook-secret-value-with-32-characters';

function createWebhookApp() {
  const app = express();
  const router = express.Router();
  const bot = new Bot('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11');
  vi.spyOn(bot, 'init').mockResolvedValue(undefined);
  const handleUpdate = vi.spyOn(bot, 'handleUpdate').mockResolvedValue(undefined);
  registerTelegramWebhook(router, bot, secretToken);
  app.use(router);
  app.use((_req, res) => res.status(404).send('Not found'));
  return { app, handleUpdate };
}

describe('Telegram webhook', () => {
  beforeEach(() => {
    setWebhookReady(false);
  });

  afterEach(() => {
    setWebhookReady(false);
  });

  it('returns a retryable response until startup checks are complete', async () => {
    const { app, handleUpdate } = createWebhookApp();
    const response = await request(app)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set('X-Telegram-Bot-Api-Secret-Token', secretToken)
      .send({ update_id: 1 });

    expect(response.status).toBe(503);
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it('rejects requests without the configured secret token', async () => {
    setWebhookReady(true);
    const { app, handleUpdate } = createWebhookApp();
    const response = await request(app).post(TELEGRAM_WEBHOOK_PATH).send({ update_id: 1 });

    expect(response.status).toBe(401);
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it('parses Telegram updates and forwards authenticated requests to the existing bot handlers', async () => {
    setWebhookReady(true);
    const { app, handleUpdate } = createWebhookApp();
    const update = { update_id: 1 };
    const response = await request(app)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set('X-Telegram-Bot-Api-Secret-Token', secretToken)
      .send(update);

    expect(response.status).toBe(200);
    expect(handleUpdate).toHaveBeenCalledWith(update, expect.any(Object));
  });
});
