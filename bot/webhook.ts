import express, { type Router } from 'express';
import { type Bot, webhookCallback } from 'grammy';
import { TELEGRAM_WEBHOOK_PATH } from './config';

export const telegramWebhookRouter = express.Router();

let webhookReady = false;
let updatesPaused = false;
let activeUpdates = 0;
let drainWaiters: Array<() => void> = [];

export function setWebhookReady(ready: boolean): void {
  webhookReady = ready;
  if (!ready) {
    updatesPaused = false;
  }
}

export function isWebhookReady(): boolean {
  return webhookReady && !updatesPaused;
}

export async function pauseTelegramUpdates(): Promise<void> {
  updatesPaused = true;
  if (activeUpdates === 0) return;

  await new Promise<void>((resolve) => {
    drainWaiters.push(resolve);
  });
}

export function resumeTelegramUpdates(): void {
  updatesPaused = false;
}

export function registerTelegramWebhook(router: Router, bot: Bot, secretToken: string): void {
  const handleUpdate = webhookCallback(bot, 'express', { secretToken });

  router.post(TELEGRAM_WEBHOOK_PATH, express.json({ limit: '1mb' }), async (req, res) => {
    if (!isWebhookReady()) {
      res.sendStatus(503);
      return;
    }

    activeUpdates += 1;
    try {
      await handleUpdate(req, res);
    } finally {
      activeUpdates -= 1;
      if (activeUpdates === 0) {
        const waiters = drainWaiters;
        drainWaiters = [];
        waiters.forEach((resolve) => resolve());
      }
    }
  });
}
