import { randomUUID } from 'node:crypto';
import type { EnqueueOptions, Queue, QueueJob } from './types.js';

/**
 * In-process queue with SQS-shaped semantics: at-least-once delivery, an
 * invisibility window while a job is leased, and a dead letter queue.
 *
 * The production deployment swaps this for SQS; the worker never learns which
 * it is talking to.
 */
export class MemoryQueue<T> implements Queue<T> {
  private readonly pending: Array<QueueJob<T>> = [];
  private readonly leased = new Map<string, QueueJob<T>>();
  private readonly dlq: Array<QueueJob<T> & { reason: string }> = [];

  constructor(readonly name: string, private readonly visibilityMs = 30_000) {}

  async enqueue(body: T, options: EnqueueOptions = {}): Promise<string> {
    const now = Date.now();
    const job: QueueJob<T> = {
      id: randomUUID(),
      body,
      attempts: 0,
      availableAt: now + (options.delaySeconds ?? 0) * 1000,
      enqueuedAt: now,
    };
    this.pending.push(job);
    return job.id;
  }

  async receive(max: number, now = Date.now()): Promise<Array<QueueJob<T>>> {
    this.reclaimExpiredLeases(now);
    const out: Array<QueueJob<T>> = [];
    for (let i = 0; i < this.pending.length && out.length < max; ) {
      const job = this.pending[i];
      if (job.availableAt > now) {
        i += 1;
        continue;
      }
      this.pending.splice(i, 1);
      job.attempts += 1;
      job.availableAt = now + this.visibilityMs;
      this.leased.set(job.id, job);
      out.push(job);
    }
    return out;
  }

  async ack(id: string): Promise<void> {
    this.leased.delete(id);
  }

  async retry(id: string, delaySeconds: number): Promise<void> {
    const job = this.leased.get(id);
    if (!job) return;
    this.leased.delete(id);
    job.availableAt = Date.now() + delaySeconds * 1000;
    this.pending.push(job);
  }

  async deadLetter(id: string, reason: string): Promise<void> {
    const job = this.leased.get(id);
    if (!job) return;
    this.leased.delete(id);
    this.dlq.push({ ...job, reason });
  }

  depth(now = Date.now()): number {
    return this.pending.filter((job) => job.availableAt <= now).length;
  }

  inFlight(): number {
    return this.leased.size;
  }

  deadLetters(): Array<QueueJob<T> & { reason: string }> {
    return [...this.dlq];
  }

  /** A worker that dies mid-job must not strand it (NFR-2.2). */
  private reclaimExpiredLeases(now: number): void {
    for (const [id, job] of this.leased) {
      if (job.availableAt <= now) {
        this.leased.delete(id);
        job.availableAt = now;
        this.pending.push(job);
      }
    }
  }
}
