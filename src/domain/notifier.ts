import { EventEmitter } from 'node:events';
import type { Id, Message } from '../types.js';

/**
 * Wakes long-polling agents the moment mail lands, so an agent waiting on its
 * inbox sees an internal message in milliseconds rather than on the next poll.
 */
export class MailboxNotifier {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(message: Message): void {
    if (!message.agentId) return;
    this.emitter.emit(message.agentId, message);
  }

  /** Resolves with the next message for `agentId`, or null on timeout. */
  waitFor(agentId: Id, timeoutMs: number, signal?: AbortSignal): Promise<Message | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: Message | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.emitter.off(agentId, onMessage);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onMessage = (message: Message) => finish(message);
      const onAbort = () => finish(null);
      const timer = setTimeout(() => finish(null), timeoutMs);
      timer.unref?.();
      this.emitter.on(agentId, onMessage);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
