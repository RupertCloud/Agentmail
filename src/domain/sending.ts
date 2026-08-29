import type { Config } from '../config.js';
import { badRequest, forbidden, rateLimited, unprocessable } from '../errors.js';
import type { Queue } from '../queue/types.js';
import type { Store } from '../store/types.js';
import type {
  AccpContext,
  Account,
  Address,
  Agent,
  Attachment,
  Id,
  Message,
  MessageKind,
  Timestamp,
} from '../types.js';
import {
  domainOf,
  htmlToText,
  isValidEmail,
  normalizeSubject,
  parseAddress,
  parseAddressList,
  renderTemplate,
} from '../util/email.js';
import { newId, newRfcMessageId } from '../util/ids.js';
import {
  ACCP_VERSION,
  HEADER_AGENT,
  HEADER_CONVERSATION,
  HEADER_HOPS,
  HEADER_INTENT,
  HEADER_VERSION,
} from '../util/mime.js';
import type { AgentService } from './agents.js';
import type { EventService } from './events.js';
import type { MailboxNotifier } from './notifier.js';
import type { SuppressionService } from './suppression.js';

/** docs/accp/SPEC.md §4. Unknown intents are accepted and treated as `notify`. */
export type AccpIntent = 'request' | 'response' | 'notify' | 'error' | 'ack';

export interface DeliveryJob {
  messageId: Id;
  /** Envelope recipients bound for an external provider. */
  destinations: string[];
}

export interface SendEmailInput {
  from?: string | Address;
  to: string | string[] | Address[];
  cc?: string | string[] | Address[];
  bcc?: string | string[] | Address[];
  replyTo?: string | string[] | Address[];
  subject?: string;
  html?: string | null;
  text?: string | null;
  headers?: Record<string, string>;
  attachments?: Attachment[];
  /** Machine-readable payload for agent recipients. */
  structured?: unknown;
  /** ACCP context travelling with the payload (spec §6). */
  context?: AccpContext;
  templateId?: Id;
  variables?: Record<string, unknown>;
  tags?: Record<string, string>;
  kind?: MessageKind;
  /** Sending agent; implied when the caller uses an agent-scoped key. */
  agentId?: Id;
  campaignId?: Id;
  /** RFC Message-ID being replied to; drives threading and the hop counter. */
  inReplyTo?: string;
  /** ACCP intent; defaults to `response` on a reply and `request` otherwise. */
  intent?: AccpIntent;
  scheduledAt?: Timestamp;
  idempotencyKey?: string;
}

export interface SendResult {
  message: Message;
  /** Mailbox copies written for recipients hosted on this platform. */
  internal: Message[];
  /** Recipients dropped because they are suppressed (FR-4.4). */
  skipped: string[];
}

const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024;

export class SendService {
  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly agents: AgentService,
    private readonly suppression: SuppressionService,
    private readonly events: EventService,
    private readonly notifier: MailboxNotifier,
    private readonly queues: { transactional: Queue<DeliveryJob>; campaign: Queue<DeliveryJob> },
  ) {}

  async send(
    account: Account,
    input: SendEmailInput,
    sender: Agent | null = null,
    /** Restrictions carried by the calling credential, e.g. a domain-scoped key. */
    constraints: { domainId?: Id | null } = {},
  ): Promise<SendResult> {
    if (input.idempotencyKey) {
      const existing = await this.store.findByIdempotencyKey(account.id, input.idempotencyKey);
      if (existing) return { message: existing, internal: [], skipped: [] };
    }

    if (input.context) this.assertDelegationBudget(input.context);
    const agent = await this.resolveSendingAgent(account, input, sender);
    const from = this.resolveFrom(input, agent);
    await this.assertSenderAllowed(account, from, agent);
    await this.assertKeyDomain(account, from, constraints.domainId ?? null);
    this.assertSchedule(input.scheduledAt);

    const to = parseAddressList(input.to as string | string[]);
    const cc = parseAddressList(input.cc as string | string[]);
    const bcc = parseAddressList(input.bcc as string | string[]);
    const replyTo = parseAddressList(input.replyTo as string | string[]);
    if (!to.length) throw badRequest('At least one `to` recipient is required.', 'to');
    for (const address of [...to, ...cc, ...bcc]) {
      if (!isValidEmail(address.email)) {
        throw badRequest(`"${address.email}" is not a valid email address.`, 'to');
      }
    }

    const rendered = await this.renderBody(account.id, input);
    const attachments = input.attachments ?? [];
    const attachmentBytes = attachments.reduce((sum, item) => sum + Buffer.byteLength(item.content, 'base64'), 0);
    if (attachmentBytes > MAX_ATTACHMENT_BYTES) {
      throw unprocessable('Attachments exceed the 40 MB per-message limit.', 'attachments');
    }

    const parent = input.inReplyTo
      ? await this.store.findByRfcMessageId(account.id, input.inReplyTo)
      : null;
    if (input.inReplyTo && !parent) {
      // Replying to mail we never saw is legitimate; start a fresh thread.
    }

    const threadId = parent?.threadId ?? newId('thr');
    const hops = agent ? (parent?.hops ?? 0) + 1 : parent?.hops ?? 0;
    if (agent) {
      await this.assertLoopBudget(agent, threadId, hops);
      // Only replies are checked: an opening message has no thread to stall.
      if (parent) await this.assertConversationProgress(agent, threadId, input);
    }

    const kind: MessageKind = input.kind ?? (agent ? 'agent' : input.campaignId ? 'campaign' : 'transactional');

    const { local, external, skipped } = await this.route(account, [...to, ...cc, ...bcc]);
    if (!local.length && !external.length) {
      const message = await this.persist(account, {
        from,
        to,
        cc,
        bcc,
        replyTo,
        rendered,
        attachments,
        input,
        agent,
        kind,
        threadId,
        hops,
        parent,
        transport: 'provider',
        status: 'skipped',
      });
      await this.events.record(account.id, message, message.id, 'skipped', { recipients: skipped });
      return { message, internal: [], skipped };
    }

    if (external.length) await this.assertDailyLimit(account);

    const scheduled = input.scheduledAt && Date.parse(input.scheduledAt) > Date.now();
    const message = await this.persist(account, {
      from,
      to,
      cc,
      bcc,
      replyTo,
      rendered,
      attachments,
      input,
      agent,
      kind,
      threadId,
      hops,
      parent,
      transport: external.length ? 'provider' : 'internal',
      status: scheduled ? 'scheduled' : 'queued',
    });

    await this.events.record(account.id, message, message.id, 'accepted', {
      local: local.map((entry) => entry.agent.address),
      external,
      skipped,
    });

    const internal: Message[] = [];
    if (!scheduled) {
      for (const target of local) {
        const copy = await this.deliverInternal(message, target.agent);
        if (copy) internal.push(copy);
      }
    }

    if (external.length) {
      const queue = kind === 'campaign' ? this.queues.campaign : this.queues.transactional;
      const delaySeconds = scheduled
        ? Math.max(0, Math.round((Date.parse(input.scheduledAt!) - Date.now()) / 1000))
        : 0;
      await queue.enqueue({ messageId: message.id, destinations: external }, { delaySeconds });
      await this.events.record(account.id, message, message.id, 'queued', { queue: kind === 'campaign' ? 'campaign' : 'transactional' });
    } else if (!scheduled) {
      await this.store.updateMessage(message.id, { status: 'delivered' });
    }

    const finalMessage = (await this.store.getMessage(message.id)) ?? message;
    return { message: finalMessage, internal, skipped };
  }

  /* ------------------------------------------------------------ internals */

  private async resolveSendingAgent(
    account: Account,
    input: SendEmailInput,
    sender: Agent | null,
  ): Promise<Agent | null> {
    if (sender) return sender;
    if (!input.agentId) return null;
    return this.agents.get(account.id, input.agentId);
  }

  private resolveFrom(input: SendEmailInput, agent: Agent | null): Address {
    if (input.from) {
      const address = typeof input.from === 'string' ? parseAddress(input.from) : input.from;
      if (!isValidEmail(address.email)) throw badRequest('`from` is not a valid email address.', 'from');
      return address;
    }
    if (agent) return { email: agent.address, name: agent.displayName };
    throw badRequest('`from` is required.', 'from');
  }

  /**
   * A sender must own the domain it claims: a verified domain on the account,
   * or the account's own hosted agent namespace. Nothing else is permitted,
   * which is what keeps one tenant from sending as another.
   */
  private async assertSenderAllowed(account: Account, from: Address, agent: Agent | null): Promise<void> {
    if (agent) {
      if (agent.accountId !== account.id) throw forbidden('That agent belongs to another account.');
      if (from.email !== agent.address) {
        throw forbidden(`An agent may only send as its own address (${agent.address}).`);
      }
      return;
    }

    const domain = domainOf(from.email);
    if (domain === `${account.slug}.${this.config.agentDomain}`) {
      const target = await this.agents.resolve(from.email);
      if (target && target.accountId === account.id) return;
      throw forbidden(`No agent owns ${from.email} on this account.`);
    }

    const verified = await this.store.findDomain(account.id, domain);
    if (!verified) throw forbidden(`Domain ${domain} is not registered on this account.`);
    if (verified.status !== 'verified') {
      throw forbidden(`Domain ${domain} is not verified yet, so it cannot send (FR-2.5).`);
    }
  }

  /**
   * ACCP §6.4 C-3. Delegation depth bounds how far an authority has been passed
   * along, which is a different failure from a long conversation: the hop
   * ceiling stops two agents talking forever, this stops a chain of agents
   * laundering an unauthorised ask into one that looks legitimate.
   */
  private assertDelegationBudget(context: AccpContext): void {
    const depth = context.delegation?.depth;
    if (depth === undefined) return;
    if (!Number.isInteger(depth) || depth < 0) {
      throw badRequest('`context.delegation.depth` must be a non-negative integer.', 'context');
    }
    if (depth > this.config.maxDelegationDepth) {
      throw unprocessable(
        `Delegation depth ${depth} exceeds the maximum of ${this.config.maxDelegationDepth}.`,
        'context',
      );
    }
  }

  /** FR-3.5: a key scoped to a domain may not send from any other. */
  private async assertKeyDomain(account: Account, from: Address, domainId: Id | null): Promise<void> {
    if (!domainId) return;
    const domain = await this.store.getDomain(domainId);
    if (!domain || domain.accountId !== account.id) {
      throw forbidden('This key is scoped to a domain that no longer exists.');
    }
    if (domainOf(from.email) !== domain.domain) {
      throw forbidden(`This key may only send from ${domain.domain}.`);
    }
  }

  /** FR-4.6: scheduling reaches 30 days ahead, and no further. */
  private assertSchedule(scheduledAt: string | undefined): void {
    if (!scheduledAt) return;
    const when = Date.parse(scheduledAt);
    if (!Number.isFinite(when)) {
      throw badRequest('`scheduled_at` must be an ISO 8601 timestamp.', 'scheduled_at');
    }
    if (when - Date.now() > 30 * 24 * 60 * 60 * 1000) {
      throw badRequest('`scheduled_at` may be at most 30 days ahead.', 'scheduled_at');
    }
  }

  private async renderBody(
    accountId: Id,
    input: SendEmailInput,
  ): Promise<{ subject: string; html: string | null; text: string | null }> {
    let subject = input.subject ?? '';
    let html = input.html ?? null;
    let text = input.text ?? null;

    if (input.templateId) {
      const template = await this.store.getTemplate(input.templateId);
      if (!template || template.accountId !== accountId) {
        throw badRequest('Unknown template_id.', 'template_id');
      }
      const variables = input.variables ?? {};
      subject = input.subject ?? renderTemplate(template.subject, variables);
      html = renderTemplate(template.html, variables);
      text = template.text ? renderTemplate(template.text, variables) : null;
    }

    if (!html && !text && input.structured === undefined) {
      throw badRequest('Provide `html`, `text`, `structured` or a `template_id`.', 'html');
    }
    if (!text && html) text = htmlToText(html);
    if (!text && input.structured !== undefined) {
      text = JSON.stringify(input.structured, null, 2);
    }
    if (!subject) subject = '(no subject)';

    return { subject, html, text };
  }

  /**
   * Loop guard. Two agents that reply to each other will otherwise run until
   * something breaks; hop count bounds the depth and the per-thread rate bounds
   * the speed.
   */
  private async assertLoopBudget(agent: Agent, threadId: Id, hops: number): Promise<void> {
    if (hops > agent.maxHops) {
      throw unprocessable(
        `Conversation exceeded ${agent.maxHops} automated hops; refusing to continue the loop.`,
        'in_reply_to',
      );
    }
    const since = new Date(Date.now() - 60_000).toISOString();
    const recent = await this.store.countThreadSince(threadId, since);
    if (recent >= agent.maxThreadRate) {
      throw rateLimited(
        `Thread ${threadId} exceeded ${agent.maxThreadRate} messages per minute.`,
      );
    }
  }

  /**
   * Bounds deliberation by cost rather than by good intentions.
   *
   * Hops and rate bound how deep and how fast a conversation runs, but neither
   * notices a thread that is simply going nowhere: two agents can stay well
   * inside both ceilings and still talk indefinitely without deciding
   * anything. This is the failure mode where deliberation is cheap and
   * unbounded while action is gated, and it is not solved by refusing to let
   * agents talk.
   *
   * A message earns its place if it does either of two things — asserts
   * something checkable (a structured payload) or commits to something with a
   * deadline (`expects.reply_by`). A reply that does neither is drift. Drift is
   * allowed, because a clarifying question is drift and is often the right
   * message to send; what is not allowed is an unbroken run of it.
   *
   * The counter resets on any message that asserts or commits, so a thread that
   * is getting somewhere is never penalised for the prose around it.
   */
  private async assertConversationProgress(
    agent: Agent,
    threadId: Id,
    input: { structured?: unknown; context?: AccpContext | null },
  ): Promise<void> {
    const carriesWork =
      input.structured !== undefined || Boolean(input.context?.expects?.reply_by);
    if (carriesWork) return;

    const page = await this.store.listMessages({
      accountId: agent.accountId,
      threadId,
      // Two rows per internally delivered message, so ask for headroom.
      limit: (Math.max(agent.maxDriftingReplies, 1) + 1) * 2,
    });

    // Deduplicate by Message-ID rather than filtering by direction: an
    // internally delivered message is stored twice, once for the sender and
    // once for the recipient, while a thread with an external counterparty has
    // rows for its own side only. Counting rows would make the ceiling depend
    // on where the other agent happens to be hosted.
    const unique = new Map<string, Message>();
    for (const message of page.data) {
      if (!unique.has(message.rfcMessageId)) unique.set(message.rfcMessageId, message);
    }

    // Order by hop count, not by timestamp. Two rows written in the same
    // millisecond tie-break on id, which is unrelated to conversational order,
    // so `createdAt` alone interleaves messages and makes this check flap.
    // Hops increment once per reply and are carried on both copies, which makes
    // them the one field that actually orders a thread.
    const ordered = [...unique.values()].sort(
      (a, b) => b.hops - a.hops || b.createdAt.localeCompare(a.createdAt),
    );

    // Walk backwards from the most recent message, stopping at the last one
    // that carried work.
    let drifting = 0;
    for (const message of ordered) {
      const asserted = message.structured !== undefined && message.structured !== null;
      const committed = Boolean(message.context?.expects?.reply_by);
      if (asserted || committed) break;
      drifting += 1;
    }

    if (drifting >= agent.maxDriftingReplies) {
      throw unprocessable(
        `Thread ${threadId} has ${drifting} consecutive messages that neither assert ` +
          'anything checkable nor commit to a deadline. Send a structured payload, or ' +
          'set context.expects.reply_by, or let the thread end.',
        'structured',
      );
    }
  }

  private async assertDailyLimit(account: Account): Promise<void> {
    const since = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').toISOString();
    const sent = await this.store.countSentSince(account.id, since);
    if (sent >= account.dailySendLimit) {
      throw rateLimited(
        `Daily sending limit of ${account.dailySendLimit} reached. Limits rise automatically with clean sending history.`,
      );
    }
  }

  /**
   * Splits recipients three ways: agent mailboxes on this platform (delivered
   * internally in milliseconds, never touching SES), external addresses, and
   * suppressed addresses that are silently dropped.
   */
  private async route(
    account: Account,
    recipients: Address[],
  ): Promise<{ local: Array<{ address: Address; agent: Agent }>; external: string[]; skipped: string[] }> {
    const local: Array<{ address: Address; agent: Agent }> = [];
    const external: string[] = [];
    const skipped: string[] = [];
    const seen = new Set<string>();

    for (const address of recipients) {
      if (seen.has(address.email)) continue;
      seen.add(address.email);

      const agent = await this.agents.resolve(address.email);
      if (agent) {
        local.push({ address, agent });
        continue;
      }
      if (await this.suppression.isSuppressed(account.id, address.email)) {
        skipped.push(address.email);
        continue;
      }
      external.push(address.email);
    }

    return { local, external, skipped };
  }

  private async persist(
    account: Account,
    parts: {
      from: Address;
      to: Address[];
      cc: Address[];
      bcc: Address[];
      replyTo: Address[];
      rendered: { subject: string; html: string | null; text: string | null };
      attachments: Attachment[];
      input: SendEmailInput;
      agent: Agent | null;
      kind: MessageKind;
      threadId: Id;
      hops: number;
      parent: Message | null;
      transport: 'internal' | 'provider';
      status: Message['status'];
    },
  ): Promise<Message> {
    const now = new Date().toISOString();
    const headers = { ...(parts.input.headers ?? {}) };
    // ACCP envelope (docs/accp/SPEC.md §3). Every agent-originated message
    // carries it; ordinary transactional mail does not pretend to.
    if (parts.agent) {
      headers[HEADER_VERSION] = ACCP_VERSION;
      headers[HEADER_INTENT] = parts.input.intent ?? (parts.parent ? 'response' : 'request');
      headers[HEADER_CONVERSATION] = parts.threadId;
      headers[HEADER_HOPS] = String(parts.hops);
      headers[HEADER_AGENT] = parts.agent.address;
    }

    return this.store.createMessage({
      id: newId('msg'),
      accountId: account.id,
      kind: parts.kind,
      direction: 'outbound',
      transport: parts.transport,
      status: parts.status,
      from: parts.from,
      to: parts.to,
      cc: parts.cc,
      bcc: parts.bcc,
      replyTo: parts.replyTo,
      subject: parts.rendered.subject,
      html: parts.rendered.html,
      text: parts.rendered.text,
      headers,
      attachments: parts.attachments,
      structured: parts.input.structured,
      context: parts.input.context ?? null,
      rfcMessageId: newRfcMessageId(this.config.platformDomain),
      inReplyTo: parts.parent?.rfcMessageId ?? parts.input.inReplyTo ?? null,
      references: parts.parent ? [...parts.parent.references, parts.parent.rfcMessageId] : [],
      threadId: parts.threadId,
      conversationKey: parts.agent
        ? `${domainOf(parts.from.email)}:${parts.threadId}`
        : null,
      agentId: parts.agent?.id ?? null,
      campaignId: parts.input.campaignId ?? null,
      templateId: parts.input.templateId ?? null,
      tags: parts.input.tags ?? {},
      hops: parts.hops,
      providerMessageId: null,
      error: null,
      idempotencyKey: parts.input.idempotencyKey ?? null,
      scheduledAt: parts.input.scheduledAt ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Agent-to-agent fast path: the recipient is hosted here, so the message is
   * written straight into their mailbox. No SMTP hop, no provider, no bounce
   * risk, and the recipient's long-poll wakes immediately.
   */
  async deliverInternal(outbound: Message, recipient: Agent): Promise<Message | null> {
    const decision = this.agents.canAccept(recipient, outbound.from.email, {
      senderIsLocalAgent: outbound.agentId != null,
      dmarcAligned: true,
    });
    if (!decision.accepted) {
      await this.events.record(outbound.accountId, outbound, outbound.id, 'rejected', {
        recipient: recipient.address,
        reason: decision.reason,
      });
      return null;
    }

    // Within one account the mailbox copy joins the sender's thread. Across
    // accounts each tenant threads independently, as with any two mail hosts.
    let threadId: Id;
    if (recipient.accountId === outbound.accountId) {
      threadId = outbound.threadId;
    } else {
      const parent = outbound.inReplyTo
        ? await this.store.findByRfcMessageId(recipient.accountId, outbound.inReplyTo)
        : null;
      threadId = parent?.threadId ?? (await this.findThreadBySubject(recipient, outbound)) ?? newId('thr');
    }
    const now = new Date().toISOString();

    const inbound = await this.store.createMessage({
      ...outbound,
      id: newId('msg'),
      accountId: recipient.accountId,
      conversationKey: outbound.conversationKey,
      direction: 'inbound',
      transport: 'internal',
      status: 'received',
      bcc: [],
      threadId,
      agentId: recipient.id,
      campaignId: null,
      idempotencyKey: null,
      mailboxState: 'unread',
      claimedBy: null,
      leaseExpiresAt: null,
      deliveryAttempts: 0,
      scheduledAt: null,
      createdAt: now,
      updatedAt: now,
    });

    await this.events.record(recipient.accountId, inbound, inbound.id, 'received', {
      from: outbound.from.email,
      transport: 'internal',
    });
    await this.events.record(outbound.accountId, outbound, outbound.id, 'delivered', {
      recipient: recipient.address,
      transport: 'internal',
    });
    this.notifier.publish(inbound);
    return inbound;
  }

  /** Fallback threading when a sender omits References entirely. */
  private async findThreadBySubject(recipient: Agent, outbound: Message): Promise<Id | null> {
    const normalized = normalizeSubject(outbound.subject);
    if (!normalized) return null;
    const page = await this.store.listMessages({
      accountId: recipient.accountId,
      agentId: recipient.id,
      limit: 50,
    });
    const match = page.data.find(
      (candidate) =>
        normalizeSubject(candidate.subject) === normalized &&
        (candidate.from.email === outbound.from.email ||
          candidate.to.some((address) => address.email === outbound.from.email)),
    );
    return match?.threadId ?? null;
  }
}
