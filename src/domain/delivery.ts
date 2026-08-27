import type { Config } from '../config.js';
import type { EmailProvider } from '../providers/types.js';
import type { Store } from '../store/types.js';
import type { Id, MessageEventType, SuppressionReason } from '../types.js';
import { buildRawMessage } from '../util/mime.js';
import type { EventService } from './events.js';
import type { DeliveryJob } from './sending.js';
import type { SuppressionService } from './suppression.js';

export interface ProviderNotification {
  providerMessageId: string;
  type: 'delivery' | 'bounce' | 'complaint' | 'reject' | 'open' | 'click' | 'delivery_delay';
  /** Present for bounces; `permanent` drives immediate suppression. */
  bounceType?: 'permanent' | 'transient' | 'undetermined';
  recipients?: string[];
  metadata?: Record<string, unknown>;
}

const EVENT_BY_NOTIFICATION: Record<ProviderNotification['type'], MessageEventType> = {
  delivery: 'delivered',
  bounce: 'bounced',
  complaint: 'complained',
  reject: 'rejected',
  open: 'opened',
  click: 'clicked',
  delivery_delay: 'delayed',
};

/** Hands accepted messages to the provider and folds provider events back in. */
export class DeliveryService {
  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly provider: EmailProvider,
    private readonly events: EventService,
    private readonly suppression: SuppressionService,
  ) {}

  async handle(job: DeliveryJob): Promise<void> {
    const message = await this.store.getMessage(job.messageId);
    if (!message) return;
    if (message.status === 'canceled' || message.status === 'sent' || message.status === 'delivered') return;

    const account = await this.store.getAccount(message.accountId);
    if (!account) return;
    if (account.status !== 'active') {
      await this.store.updateMessage(message.id, { status: 'canceled', error: `account ${account.status}` });
      return;
    }

    await this.store.updateMessage(message.id, { status: 'sending' });

    const domain = await this.store.findDomain(account.id, message.from.email.split('@')[1] ?? '');
    const raw = buildRawMessage({
      from: message.from,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      replyTo: message.replyTo,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: message.headers,
      attachments: message.attachments,
      structured: message.structured,
      messageId: message.rfcMessageId,
      inReplyTo: message.inReplyTo,
      references: message.references,
    });

    const result = await this.provider.send({
      tenantName: account.tenantName,
      configSetName: domain?.configSetName ?? null,
      from: message.from,
      destinations: job.destinations,
      raw,
      tags: { ...message.tags, agentmail_kind: message.kind },
    });

    await this.store.updateMessage(message.id, {
      status: 'sent',
      providerMessageId: result.providerMessageId,
      error: null,
    });
    const updated = await this.store.getMessage(message.id);
    await this.events.record(account.id, updated, message.id, 'sent', {
      provider: this.provider.name,
      provider_message_id: result.providerMessageId,
      destinations: job.destinations,
    });
  }

  /** Called when a job exhausts its retries. */
  async fail(messageId: Id, reason: string): Promise<void> {
    const message = await this.store.getMessage(messageId);
    if (!message) return;
    await this.store.updateMessage(messageId, { status: 'failed', error: reason });
    const updated = await this.store.getMessage(messageId);
    await this.events.record(message.accountId, updated, messageId, 'failed', { reason });
  }

  /**
   * Ingests an SES event (SRS §3.4). Hard bounces and complaints suppress the
   * recipient permanently; soft bounces are counted and suppressed on the third
   * failure (FR-7.4).
   */
  async ingestProviderEvent(notification: ProviderNotification): Promise<void> {
    const message = await this.store.findByProviderMessageId(notification.providerMessageId);
    if (!message) return;

    const type = EVENT_BY_NOTIFICATION[notification.type];
    const recipients = notification.recipients ?? message.to.map((address) => address.email);

    if (type === 'delivered' || type === 'bounced' || type === 'complained' || type === 'rejected') {
      await this.store.updateMessage(message.id, { status: statusFor(type) });
    }
    const updated = await this.store.getMessage(message.id);
    await this.events.record(message.accountId, updated, message.id, type, {
      ...notification.metadata,
      bounce_type: notification.bounceType ?? null,
      recipients,
    });

    const reason = suppressionReason(notification);
    if (!reason) return;
    for (const recipient of recipients) {
      if (reason === 'soft_bounce') {
        const attempts = await this.countSoftBounces(message.accountId, recipient);
        if (attempts < 3) continue;
      }
      await this.suppression.add(message.accountId, recipient, reason, {
        note: `automatic: ${notification.type}`,
      });
    }
  }

  private async countSoftBounces(accountId: Id, recipient: string): Promise<number> {
    const page = await this.store.listMessages({ accountId, recipient, limit: 200 });
    let count = 0;
    for (const message of page.data) {
      const events = await this.store.listEvents(message.id);
      count += events.filter(
        (event) => event.type === 'bounced' && event.metadata.bounce_type === 'transient',
      ).length;
    }
    return count;
  }

  get platformDomain(): string {
    return this.config.platformDomain;
  }
}

function statusFor(type: MessageEventType): 'delivered' | 'bounced' | 'complained' | 'failed' {
  if (type === 'delivered') return 'delivered';
  if (type === 'bounced') return 'bounced';
  if (type === 'complained') return 'complained';
  return 'failed';
}

function suppressionReason(notification: ProviderNotification): SuppressionReason | null {
  if (notification.type === 'complaint') return 'complaint';
  if (notification.type !== 'bounce') return null;
  return notification.bounceType === 'transient' ? 'soft_bounce' : 'hard_bounce';
}
