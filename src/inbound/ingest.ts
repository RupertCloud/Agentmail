import type { Config } from '../config.js';
import { assessAuthority, stripReservedContext } from '../domain/authority.js';
import type { AgentService } from '../domain/agents.js';
import type { EventService } from '../domain/events.js';
import type { MailboxNotifier } from '../domain/notifier.js';
import type { Store } from '../store/types.js';
import type { Agent, Id, Message } from '../types.js';
import { domainOf, normalizeSubject } from '../util/email.js';
import { newId, newRfcMessageId } from '../util/ids.js';
import {
  COMMITTED_PARTS,
  HEADER_CONTENT_DIGEST,
  HEADER_CONVERSATION,
  HEADER_HOPS,
  attachmentsContent,
  contentRoot,
  parseContentDigest,
  parseRawMessage,
  partDigest,
  type DigestEnvelope,
} from '../util/mime.js';

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
    const integrity = checkIntegrity(parsed);
    // §10.6: an already-seen Message-ID is a replay (or at-least-once
    // redelivery). Flag it so an agent never acts on the same request twice.
    const isReplay = parsed.messageId
      ? (await this.store.findByRfcMessageId(agent.accountId, parsed.messageId)) != null
      : false;
    const hops = Number(parsed.headers[HEADER_HOPS.toLowerCase()] ?? '0');
    const now = new Date().toISOString();

    const context = stripReservedContext(parsed.context);
    const verdictResults = authResults(verdicts);
    // §6.2 stops at "asserted, not proved". This records how much backs the
    // assertion, which is the part a recipient across a trust boundary needs.
    const authority = assessAuthority(context, verdictResults, from, agent);

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
      // ACCP §6.4 C-1/C-2: delivered unmodified, and never inferred when absent.
      structured: parsed.structured,
      // Reserved fields are the exception to "unmodified": they are the
      // receiver's findings, and a sender that could pre-set them would make
      // the findings worthless.
      context,
      payloadIntegrity: integrity.payloadIntegrity,
      modifiedParts: integrity.modifiedParts,
      isReplay,
      authResults: verdictResults,
      authority,
      rfcMessageId: parsed.messageId ?? newRfcMessageId(this.config.platformDomain),
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      threadId,
      conversationKey: conversationKeyFor(parsed),
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
      payload_integrity: message.payloadIntegrity ?? null,
      modified_parts: message.modifiedParts ?? [],
      replay: message.isReplay ?? false,
      authority: message.authority?.verdict ?? null,
    });
    this.notifier.publish(message);
    return message;
  }

  /**
   * ACCP §3.3: a declared `ACCP-Conversation` beats reconstructed threading,
   * because References gets truncated and stripped in transit. The token is
   * opaque and not globally unique, so it is keyed by sender domain.
   */
  private async resolveThread(agent: Agent, parsed: ReturnType<typeof parseRawMessage>): Promise<Id> {
    const declared = parsed.headers[HEADER_CONVERSATION.toLowerCase()];
    if (declared) {
      const senderDomain = domainOf(parsed.from[0]?.email ?? '');
      const scoped = `${senderDomain}:${declared}`;
      const page = await this.store.listMessages({
        accountId: agent.accountId,
        agentId: agent.id,
        limit: 100,
      });
      const seen = page.data.find((message) => message.conversationKey === scoped);
      if (seen) return seen.threadId;
    }

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

/** `<sender domain>:<declared token>`, or null when the sender declared none. */
function conversationKeyFor(parsed: ReturnType<typeof parseRawMessage>): string | null {
  const declared = parsed.headers[HEADER_CONVERSATION.toLowerCase()];
  if (!declared) return null;
  return `${domainOf(parsed.from[0]?.email ?? '')}:${declared}`;
}

/**
 * Verifies the content commitment part by part.
 *
 * The point of committing to parts separately is that a rewritten prose body
 * and a rewritten payload are different events. A list server appending a
 * footer is routine; a payload that no longer matches is not. Reporting one
 * verdict for the whole message conflates them, and the agent acts on the
 * payload.
 */
function checkIntegrity(parsed: ReturnType<typeof parseRawMessage>): {
  payloadIntegrity: 'verified' | 'modified' | 'unverified' | 'digest_missing' | null;
  modifiedParts: string[];
} {
  const hasPayload = parsed.structuredRaw != null;

  // C0: more than one ACCP-Content-Digest is a forge attempt (the parser would
  // otherwise merge them and prefer the attacker's). Trust none of them.
  if (parsed.contentDigestCount > 1) {
    return { payloadIntegrity: hasPayload ? 'digest_missing' : null, modifiedParts: ['duplicate-digest'] };
  }

  const declared = parseContentDigest(parsed.headers[HEADER_CONTENT_DIGEST.toLowerCase()]);
  if (!declared) {
    // C3: a 0.2 payload with no digest is a stripped/absent commitment, distinct
    // from a checkable-but-unbound one. Agents treat digest_missing like modified.
    return { payloadIntegrity: hasPayload ? 'digest_missing' : null, modifiedParts: [] };
  }
  if (!hasPayload) return { payloadIntegrity: null, modifiedParts: [] };

  // C9: an unrecognised algorithm cannot be verified — never report verified.
  if (declared.alg.toLowerCase() !== 'sha-256') {
    return { payloadIntegrity: 'unverified', modifiedParts: ['alg'] };
  }
  // C4: without a Message-ID the commitment cannot be bound, so it is worthless.
  const messageId = parsed.messageId ?? '';
  if (!messageId) return { payloadIntegrity: 'unverified', modifiedParts: ['message-id'] };

  // C10: the envelope the sender committed to. A change to From re-derives every
  // leaf, so a re-enveloped payload fails.
  const env: DigestEnvelope = {
    messageId,
    from: parsed.from[0]?.email ?? '',
    date: parsed.headers.date ?? '',
  };

  const received: Record<string, string | undefined> = {
    payload: parsed.structuredRaw ?? undefined,
    text: parsed.text ?? undefined,
    html: parsed.html ?? undefined,
    attachments: attachmentsContent(parsed.attachments),
  };

  // Recompute every leaf from content over the FIXED part set (C1, C2): a part
  // present in the header but missing from the body, or present in the body but
  // not committed, both surface as a mismatch instead of being skipped.
  const modifiedParts: string[] = [];
  const recomputedLeaves: Record<string, string> = {};
  for (const part of COMMITTED_PARTS) {
    const declaredLeaf = declared.leaves[part];
    const content = received[part];
    const recomputed = content === undefined ? undefined : partDigest(part, env, content);
    if (recomputed !== undefined) recomputedLeaves[part] = recomputed;
    if (declaredLeaf !== recomputed) modifiedParts.push(part);
  }

  // Recompute the root from the CONTENT-derived leaves and the envelope, and
  // compare to what was declared — the check the old code got wrong by
  // rebuilding the root from the header's own leaves. A mismatch is a set-level
  // signal (a part added or dropped on both sides under a signed header), so it
  // is surfaced as a `root` diagnostic — but it does NOT by itself condemn the
  // payload: a list footer legitimately changes `text`, and claim 2 requires
  // that not to falsify the intact payload.
  const rootOk = contentRoot(env, declared.alg, recomputedLeaves) === declared.root;
  if (!rootOk && !modifiedParts.includes('root')) modifiedParts.push('root');

  // The payload verdict is about the payload bytes, judged by their own
  // envelope-bound leaf. C10 is still caught: a changed From re-derives that
  // leaf, so `payload` mismatches.
  const payloadOk = declared.leaves.payload !== undefined && !modifiedParts.includes('payload');
  return { payloadIntegrity: payloadOk ? 'verified' : 'modified', modifiedParts };
}

/**
 * Per-mechanism authentication, plus two derived signals an agent needs to use
 * `verified` safely (S1, S2):
 *
 * - `tamperEvident` — whether a `verified` digest is actually protected against
 *   an active attacker. That requires a DKIM signature whose body hash covers
 *   the message. We do not receive the signed-header list from the provider, so
 *   this is the best available necessary condition (DKIM pass), never a proof;
 *   agents.md and spec §9.2 say so.
 * - `dmarcMethod` — which mechanism carried DMARC. DMARC via SPF alone attests
 *   nothing about the body, so an agent acting on a payload should require
 *   `dkim: PASS`, not merely `dmarc: PASS`.
 */
function authResults(verdicts: NonNullable<InboundDelivery['verdicts']>): NonNullable<Message['authResults']> {
  const spf = verdicts.spf ?? 'UNKNOWN';
  const dkim = verdicts.dkim ?? 'UNKNOWN';
  const dmarc = verdicts.dmarc ?? 'UNKNOWN';
  const dmarcMethod =
    dmarc !== 'PASS'
      ? 'none'
      : dkim === 'PASS' && spf === 'PASS'
        ? 'both'
        : dkim === 'PASS'
          ? 'dkim'
          : spf === 'PASS'
            ? 'spf'
            : 'none';
  return { spf, dkim, dmarc, tamperEvident: dkim === 'PASS', dmarcMethod };
}
