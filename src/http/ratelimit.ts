export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

/**
 * Fixed-window limiter per API key and per source address (NFR-3.7). The
 * production deployment moves the counters to Redis; the shape of the answer,
 * and the headers derived from it, do not change.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly limit = 600, private readonly windowMs = 60_000) {}

  check(key: string, now = Date.now()): RateLimitResult {
    const existing = this.windows.get(key);
    if (!existing || existing.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, limit: this.limit, remaining: this.limit - 1, resetSeconds: Math.ceil(this.windowMs / 1000) };
    }
    existing.count += 1;
    const remaining = Math.max(0, this.limit - existing.count);
    return {
      allowed: existing.count <= this.limit,
      limit: this.limit,
      remaining,
      resetSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
}
