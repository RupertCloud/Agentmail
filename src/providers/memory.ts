import { randomUUID } from 'node:crypto';
import type { EmailProvider, ProviderSendRequest, ProviderSendResult } from './types.js';
import { ProviderError } from './types.js';

/**
 * Development and test sink. Keeps every message it was handed so tests can
 * assert on what would have gone out, and can be told to fail on demand.
 */
export class MemoryProvider implements EmailProvider {
  readonly name = 'memory';
  readonly sent: ProviderSendRequest[] = [];

  /** Set to make the next `failCount` sends throw. */
  failCount = 0;
  failRetryable = true;

  async send(request: ProviderSendRequest): Promise<ProviderSendResult> {
    if (this.failCount > 0) {
      this.failCount -= 1;
      throw new ProviderError('injected provider failure', this.failRetryable);
    }
    this.sent.push(request);
    return { providerMessageId: `mem-${randomUUID()}` };
  }

  reset(): void {
    this.sent.length = 0;
    this.failCount = 0;
  }
}
