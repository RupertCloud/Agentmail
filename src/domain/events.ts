import type { Store } from '../store/types.js';
import type { Id, Message, MessageEvent, MessageEventType } from '../types.js';
import { newId } from '../util/ids.js';

export interface EventSink {
  publish(event: MessageEvent, message: Message | null): Promise<void>;
}

/** Single place message events are written, so nothing bypasses the webhook fan-out. */
export class EventService {
  private readonly sinks: EventSink[] = [];

  constructor(private readonly store: Store) {}

  addSink(sink: EventSink): void {
    this.sinks.push(sink);
  }

  async record(
    accountId: Id,
    message: Message | null,
    messageId: Id,
    type: MessageEventType,
    metadata: Record<string, unknown> = {},
  ): Promise<MessageEvent> {
    const event = await this.store.appendEvent({
      id: newId('evt'),
      accountId,
      messageId,
      type,
      occurredAt: new Date().toISOString(),
      metadata,
    });
    for (const sink of this.sinks) {
      try {
        await sink.publish(event, message);
      } catch {
        /* a sink failure must never lose the event itself */
      }
    }
    return event;
  }

  async history(messageId: Id): Promise<MessageEvent[]> {
    return this.store.listEvents(messageId);
  }
}
