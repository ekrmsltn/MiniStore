import express, { type Router } from 'express';
import { type Bot, webhookCallback } from 'grammy';
import { TELEGRAM_WEBHOOK_PATH } from './config';

export const telegramWebhookRouter = express.Router();

let webhookReady = false;

export function setWebhookReady(ready: boolean): void {
  webhookReady = ready;
}

export function isWebhookReady(): boolean {
  return webhookReady;
}

export function registerTelegramWebhook(router: Router, bot: Bot, secretToken: string): void {
  router.post(
    TELEGRAM_WEBHOOK_PATH,
    express.json({ limit: '1mb' }),
    (_req, res, next) => {
      if (!webhookReady) {
        res.sendStatus(503);
        return;
      }
      next();
    },
    webhookCallback(bot, 'express', { secretToken }),
  );
}
