import { CancelledError } from './taskQueue';

export interface RetryOptions {
  /** Additional attempts after the first one. */
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable: (e: unknown) => boolean;
  onRetry?: (e: unknown, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Delay before retry `attempt` (1-based): exponential backoff with "equal jitter" in [d/2, d]. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  const d = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(d / 2 + (random() * d) / 2);
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const wait = opts.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw new CancelledError();
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt >= opts.retries || opts.signal?.aborted || !opts.isRetryable(e)) throw e;
      const delay = backoffDelay(attempt + 1, opts.baseDelayMs, opts.maxDelayMs, opts.random);
      opts.onRetry?.(e, attempt + 1, delay);
      await wait(delay, opts.signal);
    }
  }
}
