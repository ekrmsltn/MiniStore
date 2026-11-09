/**
 * MiniStore application entry point.
 * Starts the Telegram Bot and operational health server.
 */

// config.ts loads .env before client modules initialize.

import { loadConfig } from './config';
import logger from './logger';

let disconnectMtprotoClient: (() => Promise<void>) | undefined;

async function main() {
  const config = loadConfig();
  const { webhookUrl, webhookSecret } = config;
  if (!webhookUrl || !webhookSecret) {
    throw new Error('WEBHOOK_URL and WEBHOOK_SECRET are required to run in webhook mode');
  }
  logger.info({ env: config.nodeEnv, port: config.port, msg: 'Starting MiniStore...' });

  const mtproto = await import('./telegram/mtproto.js');
  const disconnectMtproto = mtproto.disconnectMtprotoClient;
  disconnectMtprotoClient = disconnectMtproto;
  const [
    { app },
    { bot },
    { checkChannel: checkManagementChannel },
    { checkChannel: checkStorageChannel },
    { initializeIndex, startConsistencyChecks },
    { retryUntilReady },
    { registerTelegramWebhook, setWebhookReady, telegramWebhookRouter },
    { validateBotApiToken },
  ] = await Promise.all([
    import('./health.js'),
    import('./bot.js'),
    import('./telegram/management.js'),
    import('./telegram/storage.js'),
    import('./telegram/index.js'),
    import('./startup.js'),
    import('./webhook.js'),
    import('./telegram/channel-access.js'),
  ]);

  let shutdownPromise: Promise<void> | undefined;
  let stopConsistencyChecks = () => {};
  const startupAbort = new AbortController();
  registerTelegramWebhook(telegramWebhookRouter, bot, webhookSecret);

  const server = app.listen(config.port);
  server.on('error', (err) => {
    logger.error({ err, port: config.port, msg: 'Health/status server error' });
  });

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    startupAbort.abort();
    setWebhookReady(false);
    shutdownPromise = (async () => {
      logger.info('Shutting down...');
      stopConsistencyChecks();

      const tasks: Promise<unknown>[] = [];
      if (server.listening) {
        tasks.push(
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
        );
      }
      tasks.push(disconnectMtproto());

      const results = await Promise.allSettled(tasks);
      for (const result of results) {
        if (result.status === 'rejected') {
          logger.error({ err: result.reason, msg: 'Shutdown task failed' });
          process.exitCode = 1;
        }
      }
    })();
    return shutdownPromise;
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  } catch (error) {
    await shutdown();
    throw error;
  }
  logger.info({ port: config.port, msg: 'Health/status server started' });

  const dependenciesReady = await retryUntilReady(
    async () => {
      await validateBotApiToken(bot.api);
      logger.info('✅ Telegram Bot API token validated');

      const managementOk = await checkManagementChannel();
      const storageOk = await checkStorageChannel();
      if (!managementOk || !storageOk) {
        logger.warn({
          managementChannelReady: managementOk,
          storageChannelReady: storageOk,
          msg: 'Telegram channel access checks failed; inspect the preceding access-layer warnings',
        });
        return false;
      }
      await initializeIndex();
      logger.info('✅ Management and Storage Channels are accessible');
      logger.info('✅ Entity index initialized');
      return true;
    },
    startupAbort.signal,
    'Telegram Bot API validation, channel access, or index recovery',
  );
  if (!dependenciesReady) return;

  const webhookReady = await retryUntilReady(
    async () => {
      await bot.api.setWebhook(webhookUrl, {
        secret_token: webhookSecret,
        drop_pending_updates: false,
      });
      logger.info('✅ Telegram webhook registered');
      return true;
    },
    startupAbort.signal,
    'Telegram webhook registration',
  );
  if (!webhookReady) return;

  setWebhookReady(true);
  stopConsistencyChecks = startConsistencyChecks();
  logger.info('✅ Consistency checks started');
  logger.info('Telegram Bot started in webhook mode');
}

main().catch(async (err) => {
  logger.error({ err, msg: 'Failed to start application' });
  try {
    await disconnectMtprotoClient?.();
  } catch (disconnectError) {
    logger.error({
      err: disconnectError,
      msg: 'Failed to disconnect MTProto during startup cleanup',
    });
  }
  process.exitCode = 1;
});
