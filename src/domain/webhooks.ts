import { badRequest, notFound } from '../errors.js';
import { MemoryQueue } from '../queue/memory.js';
import type { Queue } from '../queue/types.js';
import { PriorityWorker } from '../queue/worker.js';
import type { Store } from '../store/types.js';
import type { Id, Message, MessageEvent, MessageEventType, Webhook, WebhookDelivery } from '../types.js';
import { newWebhookSecret, signWebhook } from '../util/crypto.js';
import { newId } from '../util/ids.js';
import { audit } from './audit.js';
import type { EventSink } from './events.js';

interface WebhookJob {
  deliveryId: Id;
  webhookId: Id;
  body: string;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

export interface WebhookServiceOptions {
  fetcher?: Fetcher;
  /** Attempts before the delivery is abandoned; FR-10.3 allows ~24 hours. */
  maxAttempts?: number;
}

export class WebhookService implements EventSink {
  readonly queue: Queue<WebhookJob>;
  readonly worker: PriorityWorker<WebhookJob>;
  private readonly fetcher: Fetcher;

  constructor(private readonly store: Store, options: WebhookServiceOptions = {}) {
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    this.queue = new MemoryQueue<WebhookJob>('webhooks');
    this.worker = new PriorityWorker<WebhookJob>(
      [this.queue],
      (job) => this.deliver(job.body.deliveryId, job.body.webhookId, job.body.body),
      {
        // 24 attempts with a one-hour ceiling spans well over the 24 hours FR-10.3 asks for.
        maxAttempts: options.maxAttempts ?? 24,
        backoffBaseSeconds: 5,
        backoffMaxSeconds: 3600,
        onDeadLetter: async (job, reason) => {
          const payload = job.body as WebhookJob;
          await this.store
            .updateWebhookDelivery(payload.deliveryId, { status: 'failed', lastError: reason })
            .catch(() => {});
        },
      },
    );
  }

  async create(
    accountId: Id,
    url: string,
    eventTypes: MessageEventType[],
  ): Promise<Webhook> {
    if (!/^https:\/\//i.test(url)) throw badRequest('Webhook endpoints must be HTTPS.', 'url');
    const webhook = await this.store.createWebhook({
      id: newId('whk'),
      accountId,
      url,
      secret: newWebhookSecret(),
      eventTypes,
      active: true,
      createdAt: new Date().toISOString(),
    });
    await audit(this.store, {
      accountId,
      actor: 'api',
      action: 'webhook.created',
      target: webhook.id,
      metadata: { url, event_types: eventTypes },
    });
    return webhook;
  }

  async list(accountId: Id): Promise<Webhook[]> {
    return this.store.listWebhooks(accountId);
  }

  async remove(accountId: Id, id: Id): Promise<void> {
    const webhook = await this.store.getWebhook(id);
    if (!webhook || webhook.accountId !== accountId) throw notFound('Webhook');
    await this.store.deleteWebhook(id);
    await audit(this.store, {
      accountId,
      actor: 'api',
      action: 'webhook.removed',
      target: id,
      metadata: { url: webhook.url },
    });
  }

  async deliveries(accountId: Id, webhookId: Id): Promise<WebhookDelivery[]> {
    const webhook = await this.store.getWebhook(webhookId);
    if (!webhook || webhook.accountId !== accountId) throw notFound('Webhook');
    return this.store.listWebhookDeliveries(webhookId);
  }

  /** Replays a past delivery unchanged (FR-10.4). */
  async replay(accountId: Id, webhookId: Id, deliveryId: Id): Promise<void> {
    const deliveries = await this.deliveries(accountId, webhookId);
    const delivery = deliveries.find((candidate) => candidate.id === deliveryId);
    if (!delivery) throw notFound('Webhook delivery');
    const event = await this.store.getEvent(delivery.eventId);
    const body = JSON.stringify({ replay: true, event: event ?? { id: delivery.eventId } });
    await this.queue.enqueue({ deliveryId: delivery.id, webhookId, body });
  }

  async publish(event: MessageEvent, message: Message | null): Promise<void> {
    const webhooks = await this.store.listWebhooks(event.accountId);
    for (const webhook of webhooks) {
      if (!webhook.active || !webhook.eventTypes.includes(event.type)) continue;
      const body = JSON.stringify({
        id: event.id,
        type: `message.${event.type}`,
        created_at: event.occurredAt,
        data: {
          message_id: event.messageId,
          thread_id: message?.threadId ?? null,
          agent_id: message?.agentId ?? null,
          subject: message?.subject ?? null,
          to: message?.to.map((address) => address.email) ?? [],
          metadata: event.metadata,
        },
      });
      const delivery = await this.store.createWebhookDelivery({
        id: newId('whd'),
        accountId: event.accountId,
        webhookId: webhook.id,
        eventId: event.id,
        status: 'pending',
        attempts: 0,
        lastError: null,
        lastAttemptAt: null,
        createdAt: new Date().toISOString(),
      });
      await this.queue.enqueue({ deliveryId: delivery.id, webhookId: webhook.id, body });
    }
  }

  private async deliver(deliveryId: Id, webhookId: Id, body: string): Promise<void> {
    const webhook = await this.store.getWebhook(webhookId);
    if (!webhook || !webhook.active) return;
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signWebhook(webhook.secret, body, timestamp);
    const now = new Date().toISOString();

    const previous = (await this.store.listWebhookDeliveries(webhookId, 200)).find(
      (candidate) => candidate.id === deliveryId,
    );
    const attempts = (previous?.attempts ?? 0) + 1;

    try {
      const response = await this.fetcher(webhook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'agentmail-signature': signature,
          'agentmail-webhook-id': webhook.id,
        },
        body,
      });
      if (!response.ok) throw new Error(`endpoint returned ${response.status}`);
      await this.store.updateWebhookDelivery(deliveryId, {
        status: 'succeeded',
        attempts,
        lastAttemptAt: now,
        lastError: null,
      });
    } catch (error) {
      await this.store.updateWebhookDelivery(deliveryId, {
        status: 'pending',
        attempts,
        lastAttemptAt: now,
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
