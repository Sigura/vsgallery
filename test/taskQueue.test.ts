import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CancelledError, TaskQueue } from '../src/shared/taskQueue';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const tick = () => new Promise((r) => setImmediate(r));

test('never exceeds concurrency', async () => {
  const q = new TaskQueue(3);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      q.add(`k${i}`, 0, async () => {
        active++;
        peak = Math.max(peak, active);
        await tick();
        active--;
      }),
    ),
  );
  assert.equal(peak, 3);
  assert.equal(q.runningCount, 0);
  assert.equal(q.pendingCount, 0);
});

test('runs lower priority value first, FIFO on ties, honors re-prioritization', async () => {
  const q = new TaskQueue(1);
  const gate = deferred();
  const order: string[] = [];
  const run = (k: string) => async () => {
    order.push(k);
  };
  const first = q.add('blocker', 0, () => gate.promise);
  const all = [q.add('c', 5, run('c')), q.add('a', 1, run('a')), q.add('b', 1, run('b')), q.add('d', 9, run('d'))];
  q.setPriority('d', 0);
  gate.resolve();
  await Promise.all([first, ...all]);
  assert.deepEqual(order, ['d', 'a', 'b', 'c']);
});

test('duplicate key returns the same promise and updates priority', async () => {
  const q = new TaskQueue(1);
  const gate = deferred();
  const order: string[] = [];
  const blocker = q.add('blocker', 0, () => gate.promise);
  const x1 = q.add('x', 10, async () => {
    order.push('x');
    return 1;
  });
  const y = q.add('y', 5, async () => {
    order.push('y');
  });
  const x2 = q.add('x', 1, async () => {
    order.push('x-dup');
    return 2;
  });
  assert.equal(x1, x2);
  gate.resolve();
  await Promise.all([blocker, y]);
  assert.equal(await x1, 1);
  assert.deepEqual(order, ['x', 'y']);
});

test('cancel and retainOnly drop pending jobs with CancelledError, running job gets aborted signal', async () => {
  const q = new TaskQueue(1);
  const gate = deferred();
  let signal: AbortSignal | undefined;
  const running = q.add('run', 0, (s) => {
    signal = s;
    return gate.promise;
  });
  await tick();
  const ran: string[] = [];
  const mk = (k: string) => q.add(k, 1, async () => void ran.push(k));
  const a = mk('a');
  const b = mk('b');
  const c = mk('c');
  q.cancel('a');
  q.retainOnly(new Set(['c', 'run']));
  q.cancel('run');
  await assert.rejects(a, CancelledError);
  await assert.rejects(b, CancelledError);
  assert.equal(signal?.aborted, true);
  gate.resolve();
  await running;
  await c;
  assert.deepEqual(ran, ['c']);
});

test('failing task rejects and frees its slot', async () => {
  const q = new TaskQueue(1);
  await assert.rejects(q.add('bad', 0, async () => Promise.reject(new Error('boom'))), /boom/);
  assert.equal(await q.add('good', 0, async () => 42), 42);
});

test('raising concurrency starts waiting jobs immediately', async () => {
  const q = new TaskQueue(1);
  const gate = deferred();
  let started = 0;
  const jobs = [0, 1, 2].map((i) =>
    q.add(`j${i}`, 0, async () => {
      started++;
      await gate.promise;
    }),
  );
  await tick();
  assert.equal(started, 1);
  q.setConcurrency(3);
  await tick();
  assert.equal(started, 3);
  gate.resolve();
  await Promise.all(jobs);
});

test('many priority updates keep ordering correct after heap compaction', async () => {
  const q = new TaskQueue(1);
  const gate = deferred();
  const order: number[] = [];
  const blocker = q.add('blocker', 0, () => gate.promise);
  const jobs = Array.from({ length: 50 }, (_, i) => q.add(`j${i}`, 1000, async () => void order.push(i)));
  for (let round = 0; round < 10; round++) for (let i = 0; i < 50; i++) q.setPriority(`j${i}`, 50 - i + round);
  gate.resolve();
  await Promise.all([blocker, ...jobs]);
  assert.deepEqual(order, Array.from({ length: 50 }, (_, i) => 49 - i));
});
