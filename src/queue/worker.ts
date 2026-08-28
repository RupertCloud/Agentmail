import type { Queue, QueueJob } from './types.js';

export interface WorkerOptions {
  maxAttempts: number;
  batchSize?: number;
  /** First retry waits this long; each further attempt doubles it. */
  backoffBaseSeconds?: number;
  backoffMaxSeconds?: number;
  onDeadLetter?: (job: QueueJob<unknown>, reason: string) => Promise<void>;
  onError?: (error: unknown) => void;
}

export interface RetryDecision {
  retryable: boolean;
}

function isRetryable(error: unknown): boolean {
  const flag = (error as Partial<RetryDecision> | undefined)?.retryable;
  return flag !== false;
}

/**
 * Drains queues strictly in the order given, so the transactional queue is
 * always emptied before the campaign queue: a 500,000-recipient broadcast never
 * sits in front of a password reset (SRS §3.3).
 */
export class PriorityWorker<T> {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly queues: Array<Queue<T>>,
    private readonly handler: (job: QueueJob<T>) => Promise<void>,
    private readonly options: WorkerOptions,
  ) {}

  /** Processes at most one batch from the highest-priority non-empty queue. */
  async runOnce(now = Date.now()): Promise<number> {
    for (const queue of this.queues) {
      const jobs = await queue.receive(this.options.batchSize ?? 10, now);
      if (!jobs.length) continue;
      for (const job of jobs) await this.process(queue, job);
      return jobs.length;
    }
    return 0;
  }

  /** Runs until every queue is empty. Used by tests and by campaign flushes. */
  async drain(maxCycles = 1000): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxCycles; i += 1) {
      const processed = await this.runOnce();
      if (!processed) break;
      total += processed;
    }
    return total;
  }

  start(intervalMs = 200): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.runOnce()
        .catch((error) => this.options.onError?.(error))
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async process(queue: Queue<T>, job: QueueJob<T>): Promise<void> {
    try {
      await this.handler(job);
      await queue.ack(job.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!isRetryable(error) || job.attempts >= this.options.maxAttempts) {
        await queue.deadLetter(job.id, reason);
        await this.options.onDeadLetter?.(job as QueueJob<unknown>, reason);
        return;
      }
      const base = this.options.backoffBaseSeconds ?? 2;
      const max = this.options.backoffMaxSeconds ?? 900;
      await queue.retry(job.id, Math.min(base * 2 ** (job.attempts - 1), max));
      this.options.onError?.(error);
    }
  }
}
