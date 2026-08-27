import type { Config } from '../config.js';
import type { AgentService } from '../domain/agents.js';
import type { EventService } from '../domain/events.js';
import type { MailboxNotifier } from '../domain/notifier.js';
import type { Store } from '../store/types.js';
import type { Agent, Id, Message } from '../types.js';
import { normalizeSubject } from '../util/email.js';
import { newId, newRfcMessageId } from '../util/ids.js';
import { HEADER_HOPS } from '../util/mime.js';
import { parseRawMessage } from '../util/mime.js';

export type Verdict = 'PASS' | 'FAIL' | 'GRAY' | 'PROCESSING_FAILED' | 'DISABLED';

export interface InboundDelivery {
  /** Complete RFC 5322 message as received. */
  raw: string;
  /** Envelope recipients, which may differ from the To header. */
  recipients: string[];
  verdicts?: {
    spf?: Verdict;
    dkim?: Verdict;
    dmarc?: Verdict;
    spam?: Verdict;
    virus?: Verdict;
  };
}

export interface InboundResult {
  delivered: Message[];
  /** Recipient plus the reason nothing was written to a mailbox. */
  rejected: Array<{ recipient: string; reason: string }>;
}

/**
 * Turns mail arriving from the outside world into mailbox entries.
 *
 * Inbound was explicitly out of scope in SRS v0.1; it is the load-bearing
 * capability for agents, because an agent that cannot receive is not reachable
 * — it is a send-only client with an address nobody can answer.
 */
export class InboundService {
  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly agents: AgentService,
    private readonly events: EventService,
    private readonly notifier: MailboxNotifier,
  ) {}

  async ingest(delivery: InboundDelivery): Promise<InboundResult> {
    const parsed = parseRawMessage(delivery.raw);
    const verdicts = delivery.verdicts ?? {};
    const delivered: Message[] = [];
    const rejected: Array<{ recipient: string; reason: string }> = [];

    if (verdicts.virus === 'FAIL') {
      return { delivered, rejected: delivery.recipients.map((recipient) => ({ recipient, reason: 'virus verdict FAIL' })) };
    }

    const from = parsed.from[0]?.email ?? '';
    const dmarcAligned = verdicts.dmarc === 'PASS' || (verdicts.spf === 'PASS' && verdicts.dkim === 'PASS');

    for (const recipient of delivery.recipients) {
      const agent = await this.agents.resolve(recipient);
      if (!agent) {
        rejected.push({ recipient, reason: 'no mailbox at that address' });
        continue;
      }

      const senderIsLocalAgent = (await this.agents.resolve(from)) != null;
      const decision = this.agents.canAccept(agent, from, { senderIsLocalAgent, dmarcAligned });
      if (!decision.accepted) {
        rejected.push({ recipient, reason: decision.reason ?? 'rejected by inbox policy' });
        await this.store.appendAudit({
          id: newId('aud'),
          accountId: agent.accountId,
          actor: from || 'unknown',
          action: 'inbound.rejected',
          target: agent.address,
          metadata: { reason: decision.reason, verdicts },
          occurredAt: new Date().toISOString(),
        });
        continue;
      }

      delivered.push(await this.write(agent, parsed, from, verdicts));
    }

    return { delivered, rejected };
  }

  private async write(
    agent: Agent,
    parsed: ReturnType<typeof parseRawMessage>,
    from: string,
    verdicts: NonNullable<InboundDelivery['verdicts']>,
  ): Promise<Message> {
    const threadId = await this.resolveThread(agent, parsed);
    const hops = Number(parsed.headers[HEADER_HOPS.toLowerCase()] ?? '0');
    const now = new Date().toISOString();

    const message = await this.store.createMessage({
      id: newId('msg'),
      accountId: agent.accountId,
      kind: 'agent',
      direction: 'inbound',
      transport: 'provider',
      status: 'received',
      from: parsed.from[0] ?? { email: from },
      to: parsed.to.length ? parsed.to : [{ email: agent.address }],
      cc: parsed.cc,
      bcc: [],
      replyTo: parsed.replyTo,
      subject: parsed.subject,
      html: parsed.html,
      text: parsed.text,
      headers: { ...parsed.headers, 'x-agentmail-spf': verdicts.spf ?? 'UNKNOWN', 'x-agentmail-dmarc': verdicts.dmarc ?? 'UNKNOWN' },
      attachments: parsed.attachments,
      structured: parsed.structured,
      rfcMessageId: parsed.messageId ?? newRfcMessageId(this.config.platformDomain),
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      threadId,
      agentId: agent.id,
      campaignId: null,
      templateId: null,
      tags: {},
      hops: Number.isFinite(hops) ? hops : 0,
      providerMessageId: null,
      error: null,
      idempotencyKey: null,
      mailboxState: 'unread',
      claimedBy: null,
      leaseExpiresAt: null,
      deliveryAttempts: 0,
      scheduledAt: null,
      createdAt: now,
      updatedAt: now,
    });

    await this.events.record(agent.accountId, message, message.id, 'received', {
      from,
      transport: 'provider',
      spam: verdicts.spam ?? 'UNKNOWN',
    });
    this.notifier.publish(message);
    return message;
  }

  /** References first, then In-Reply-To, then a normalised-subject fallback. */
  private async resolveThread(agent: Agent, parsed: ReturnType<typeof parseRawMessage>): Promise<Id> {
    const candidates = [...parsed.references].reverse();
    if (parsed.inReplyTo) candidates.unshift(parsed.inReplyTo);

    for (const reference of candidates) {
      const parent = await this.store.findByRfcMessageId(agent.accountId, reference);
      if (parent) return parent.threadId;
    }

    const normalized = normalizeSubject(parsed.subject);
    if (normalized) {
      const page = await this.store.listMessages({
        accountId: agent.accountId,
        agentId: agent.id,
        limit: 50,
      });
      const match = page.data.find((message) => normalizeSubject(message.subject) === normalized);
      if (match) return match.threadId;
    }

    return newId('thr');
  }
}
