export interface QueueJob<T> {
  id: string;
  body: T;
  attempts: number;
  /** Not visible to consumers until this time. */
  availableAt: number;
  enqueuedAt: number;
}

export interface EnqueueOptions {
  delaySeconds?: number;
}

export interface Queue<T> {
  enqueue(body: T, options?: EnqueueOptions): Promise<string>;
  /** Leases up to `max` jobs; a leased job is invisible until acked or retried. */
  receive(max: number, now?: number): Promise<QueueJob<T>[]>;
  ack(id: string): Promise<void>;
  retry(id: string, delaySeconds: number): Promise<void>;
  deadLetter(id: string, reason: string): Promise<void>;
  depth(now?: number): number;
  inFlight(): number;
  deadLetters(): Array<QueueJob<T> & { reason: string }>;
}
