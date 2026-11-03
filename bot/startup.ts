import logger from './logger';

const INITIAL_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timeout = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export async function retryUntilReady(
  operation: () => Promise<boolean>,
  signal: AbortSignal,
  description: string,
): Promise<boolean> {
  let retryDelayMs = INITIAL_RETRY_DELAY_MS;

  while (!signal.aborted) {
    try {
      if (await operation()) return true;
    } catch (err) {
      logger.error({ err, msg: `${description} failed; startup will retry` });
    }

    if (signal.aborted) break;
    logger.warn({
      retryInMs: retryDelayMs,
      msg: `${description} is unavailable; health remains unready`,
    });
    await waitForRetry(retryDelayMs, signal);
    retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
  }

  return false;
}
