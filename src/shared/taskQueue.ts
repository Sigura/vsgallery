export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

export type TaskFn<T> = (signal: AbortSignal) => Promise<T>;

interface Job {
  key: string;
  priority: number;
  version: number;
  state: 'pending' | 'running';
  run: TaskFn<unknown>;
  controller: AbortController;
  promise: Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

interface HeapNode {
  job: Job;
  priority: number;
  seq: number;
  version: number;
}

/**
 * Keyed priority queue with a concurrency limit. Lower priority value runs first, ties run FIFO.
 * Priority changes push a new heap node and invalidate the old one (lazy deletion).
 */
export class TaskQueue {
  private readonly jobs = new Map<string, Job>();
  private heap: HeapNode[] = [];
  private seq = 0;
  private running = 0;

  constructor(private concurrency: number) {
    if (concurrency < 1) throw new RangeError('concurrency must be >= 1');
  }

  get pendingCount(): number {
    return this.jobs.size - this.running;
  }

  get runningCount(): number {
    return this.running;
  }

  has(key: string): boolean {
    return this.jobs.has(key);
  }

  /** Adding a key that is already queued or running returns the existing promise; a pending job gets the new priority. */
  add<T>(key: string, priority: number, run: TaskFn<T>): Promise<T> {
    const existing = this.jobs.get(key);
    if (existing) {
      if (existing.state === 'pending') this.setPriority(key, priority);
      return existing.promise as Promise<T>;
    }
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const job: Job = {
      key,
      priority,
      version: 0,
      state: 'pending',
      run: run as TaskFn<unknown>,
      controller: new AbortController(),
      promise,
      resolve,
      reject,
    };
    this.jobs.set(key, job);
    this.push(job);
    this.pump();
    return promise as Promise<T>;
  }

  setPriority(key: string, priority: number): void {
    const job = this.jobs.get(key);
    if (!job || job.state !== 'pending' || job.priority === priority) return;
    job.priority = priority;
    job.version++;
    this.push(job);
    this.compactIfNeeded();
  }

  /** Pending jobs are dropped and reject with CancelledError; running jobs only get their signal aborted. */
  cancel(key: string): void {
    const job = this.jobs.get(key);
    if (!job) return;
    job.controller.abort();
    if (job.state === 'pending') {
      this.jobs.delete(key);
      job.reject(new CancelledError());
      this.compactIfNeeded();
    }
  }

  /** Cancels every pending job whose key is not in `keep`. */
  retainOnly(keep: ReadonlySet<string>): void {
    for (const job of [...this.jobs.values()]) {
      if (job.state === 'pending' && !keep.has(job.key)) this.cancel(job.key);
    }
  }

  clear(): void {
    for (const key of [...this.jobs.keys()]) this.cancel(key);
  }

  setConcurrency(n: number): void {
    if (n < 1) throw new RangeError('concurrency must be >= 1');
    this.concurrency = n;
    this.pump();
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const job = this.popValid();
      if (!job) return;
      this.start(job);
    }
  }

  private start(job: Job): void {
    job.state = 'running';
    this.running++;
    const signal = job.controller.signal;
    Promise.resolve()
      .then(() => job.run(signal))
      .then(job.resolve, job.reject)
      .finally(() => {
        this.running--;
        if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
        this.pump();
      });
  }

  private isValid(n: HeapNode): boolean {
    return n.job.state === 'pending' && n.version === n.job.version && this.jobs.get(n.job.key) === n.job;
  }

  private compactIfNeeded(): void {
    if (this.heap.length <= 2 * this.pendingCount + 64) return;
    this.heap = this.heap.filter((n) => this.isValid(n));
    for (let i = (this.heap.length >> 1) - 1; i >= 0; i--) this.siftDown(i);
  }

  private push(job: Job): void {
    this.heap.push({ job, priority: job.priority, seq: this.seq++, version: job.version });
    this.siftUp(this.heap.length - 1);
  }

  private popValid(): Job | undefined {
    while (this.heap.length) {
      const top = this.heap[0];
      const last = this.heap.pop()!;
      if (this.heap.length) {
        this.heap[0] = last;
        this.siftDown(0);
      }
      if (this.isValid(top)) return top.job;
    }
    return undefined;
  }

  private less(a: HeapNode, b: HeapNode): boolean {
    return a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq);
  }

  private siftUp(i: number): void {
    const h = this.heap;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i], h[p])) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }

  private siftDown(i: number): void {
    const h = this.heap;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < h.length && this.less(h[l], h[m])) m = l;
      if (r < h.length && this.less(h[r], h[m])) m = r;
      if (m === i) return;
      [h[i], h[m]] = [h[m], h[i]];
      i = m;
    }
  }
}
