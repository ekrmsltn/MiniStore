import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryUntilReady } from '../startup';

describe('startup retry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries unavailable dependencies until they become ready', async () => {
    vi.useFakeTimers();
    const operation = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const ready = retryUntilReady(operation, new AbortController().signal, 'test dependency');
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(ready).resolves.toBe(true);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('retries after an operation throws', async () => {
    vi.useFakeTimers();
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary Telegram failure'))
      .mockResolvedValueOnce(true);

    const ready = retryUntilReady(operation, new AbortController().signal, 'test dependency');
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(ready).resolves.toBe(true);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('stops retrying when startup is aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const operation = vi.fn().mockResolvedValue(false);

    const ready = retryUntilReady(operation, controller.signal, 'test dependency');
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(ready).resolves.toBe(false);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
