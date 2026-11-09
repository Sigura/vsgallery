import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay, withRetry } from '../src/shared/retry';
import { CancelledError } from '../src/shared/taskQueue';

class Busy extends Error {}

const noSleep = async () => {};

test('retries transient errors until success', async () => {
  let calls = 0;
  const delays: number[] = [];
  const r = await withRetry(
    async () => {
      if (++calls < 3) throw new Busy('EBUSY');
      return 'ok';
    },
    {
      retries: 4,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      isRetryable: (e) => e instanceof Busy,
      onRetry: (_e, _attempt, d) => delays.push(d),
      sleep: noSleep,
      random: () => 1,
    },
  );
  assert.equal(r, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200]);
});

test('gives up after the retry budget and rethrows the last error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Busy(`attempt ${calls}`);
      },
      { retries: 2, baseDelayMs: 1, maxDelayMs: 1, isRetryable: () => true, sleep: noSleep },
    ),
    /attempt 3/,
  );
  assert.equal(calls, 3);
});

test('permanent errors are not retried', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error('ENOENT');
      },
      { retries: 5, baseDelayMs: 1, maxDelayMs: 1, isRetryable: (e) => e instanceof Busy, sleep: noSleep },
    ),
    /ENOENT/,
  );
  assert.equal(calls, 1);
});

test('abort during backoff stops retrying', async () => {
  const ctrl = new AbortController();
  let calls = 0;
  const p = withRetry(
    async () => {
      calls++;
      throw new Busy('EBUSY');
    },
    { retries: 5, baseDelayMs: 10_000, maxDelayMs: 10_000, isRetryable: () => true, signal: ctrl.signal },
  );
  setImmediate(() => ctrl.abort());
  await assert.rejects(p, CancelledError);
  assert.equal(calls, 1);
});

test('backoff grows exponentially, is capped, and jitter stays in [d/2, d]', () => {
  assert.equal(backoffDelay(1, 100, 2000, () => 1), 100);
  assert.equal(backoffDelay(3, 100, 2000, () => 1), 400);
  assert.equal(backoffDelay(10, 100, 2000, () => 1), 2000);
  assert.equal(backoffDelay(3, 100, 2000, () => 0), 200);
});
