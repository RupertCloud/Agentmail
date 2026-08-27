import type { Config } from '../config.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { MessageFilter, Store } from '../store/types.js';
import type { Agent, Id, MailboxState, Message } from '../types.js';
import type { EventService } from './events.js';
import type { MailboxNotifier } from './notifier.js';

export interface ClaimOptions {
  max?: number;
  leaseSeconds?: number;
  /** Identifies the worker holding the lease, for debugging fan-out. */
  worker?: string;
}

export interface WaitOptions extends ClaimOptions {
  timeoutSeconds?: number;
  /** Claim what arrives, rather than only peeking at it. */
  claim?: boolean;
  signal?: AbortSignal;
}

/**
 * An agent's inbox behaves like a lease queue rather than a folder: a message
 * is claimed with a lease, worked, then acked. If the agent dies mid-task the
 * lease expires and the message returns to `unread` for another worker, so a
 * crash loses no mail and a fan-out of workers never double-processes.
 */
export class MailboxService {
  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly events: EventService,
    private readonly notifier: MailboxNotifier,
  ) {}

  async list(agent: Agent, filter: Partial<MessageFilter> = {}): Promise<Message[]> {
    const page = await this.store.listMessages({
      ...filter,
      accountId: agent.accountId,
      agentId: agent.id,
      direction: filter.direction ?? 'inbound',
      limit: filter.limit ?? 25,
    });
    return page.data;
  }

  async get(agent: Agent, messageId: Id): Promise<Message> {
    const message = await this.store.getMessage(messageId);
    if (!message || message.accountId !== agent.accountId) throw notFound('Message');
    if (message.agentId !== agent.id) throw forbidden('That message belongs to another mailbox.');
    return message;
  }

  /** Every message in a conversation, inbound and outbound, oldest first. */
  async thread(agent: Agent, threadId: Id): Promise<Message[]> {
    const page = await this.store.listMessages({
      accountId: agent.accountId,
      threadId,
      limit: 200,
    });
    return page.data
      .filter((message) => message.agentId === agent.id || message.agentId == null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async claim(agent: Agent, options: ClaimOptions = {}): Promise<Message[]> {
    const max = Math.min(Math.max(options.max ?? 1, 1), 50);
    const leaseSeconds = Math.min(Math.max(options.leaseSeconds ?? this.config.leaseSeconds, 5), 3600);
    await this.reclaimExpired();

    const candidates = await this.list(agent, { mailboxState: 'unread', limit: max });
    const claimed: Message[] = [];
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();

    for (const candidate of candidates) {
      // Re-read before writing: the Postgres store does this as a single
      // `UPDATE ... WHERE mailbox_state = 'unread' ... FOR UPDATE SKIP LOCKED`.
      const current = await this.store.getMessage(candidate.id);
      if (!current || current.mailboxState !== 'unread') continue;
      const updated = await this.store.updateMessage(candidate.id, {
        mailboxState: 'claimed',
        claimedBy: options.worker ?? null,
        leaseExpiresAt,
        deliveryAttempts: (current.deliveryAttempts ?? 0) + 1,
      });
      await this.events.record(agent.accountId, updated, updated.id, 'claimed', {
        worker: options.worker ?? null,
        lease_expires_at: leaseExpiresAt,
      });
      claimed.push(updated);
    }

    return claimed;
  }

  async ack(agent: Agent, messageId: Id): Promise<Message> {
    const message = await this.get(agent, messageId);
    if (message.direction !== 'inbound') throw badRequest('Only inbound messages can be acked.');
    if (message.mailboxState === 'acked') return message;
    const updated = await this.store.updateMessage(messageId, {
      mailboxState: 'acked',
      leaseExpiresAt: null,
      claimedBy: null,
    });
    await this.events.record(agent.accountId, updated, updated.id, 'acked', {});
    return updated;
  }

  /** Hands a claimed message back without acking it, for a graceful shutdown. */
  async release(agent: Agent, messageId: Id): Promise<Message> {
    const message = await this.get(agent, messageId);
    if (message.mailboxState !== 'claimed') {
      throw conflict(`Message is ${message.mailboxState}, not claimed.`);
    }
    return this.store.updateMessage(messageId, {
      mailboxState: 'unread',
      leaseExpiresAt: null,
      claimedBy: null,
    });
  }

  async setState(agent: Agent, messageId: Id, state: MailboxState): Promise<Message> {
    await this.get(agent, messageId);
    return this.store.updateMessage(messageId, {
      mailboxState: state,
      ...(state === 'unread' ? { leaseExpiresAt: null, claimedBy: null } : {}),
    });
  }

  /**
   * Long poll. Returns immediately if the inbox already has something; a
   * message arriving over the internal fast path wakes the caller in
   * milliseconds rather than on the next poll interval.
   */
  async wait(agent: Agent, options: WaitOptions = {}): Promise<Message[]> {
    const timeoutSeconds = Math.min(
      Math.max(options.timeoutSeconds ?? 25, 0),
      this.config.maxWaitSeconds,
    );

    const immediate = options.claim
      ? await this.claim(agent, options)
      : await this.list(agent, { mailboxState: 'unread', limit: options.max ?? 1 });
    if (immediate.length) return immediate;

    const arrived = await this.notifier.waitFor(agent.id, timeoutSeconds * 1000, options.signal);
    if (!arrived) return [];

    return options.claim
      ? this.claim(agent, options)
      : this.list(agent, { mailboxState: 'unread', limit: options.max ?? 1 });
  }

  /** Returns expired leases to `unread`. Safe to call on every claim. */
  async reclaimExpired(now = new Date().toISOString()): Promise<number> {
    const expired = await this.store.findExpiredLeases(now);
    for (const message of expired) {
      await this.store.updateMessage(message.id, {
        mailboxState: 'unread',
        claimedBy: null,
        leaseExpiresAt: null,
      });
      this.notifier.publish(message);
    }
    return expired.length;
  }
}
