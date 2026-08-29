import { badRequest, forbidden, notFound } from '../errors.js';
import type { Store } from '../store/types.js';
import type { Agent, Id, Memory, MemoryOrigin, MemoryProvenance, MemoryTrust, Message } from '../types.js';
import { HEADER_CONTENT_DIGEST } from '../util/mime.js';
import { newId } from '../util/ids.js';
import { audit } from './audit.js';

export interface RememberInput {
  key: string;
  value: unknown;
  summary?: string;
  origin: MemoryOrigin;
  /** Required for `origin: 'message'`; the message the fact was read in. */
  message?: Message;
  /** Required for `origin: 'inference'`; the memories it was concluded from. */
  derivedFrom?: Id[];
  /** For `origin: 'human'`; who said it. */
  assertedBy?: string;
  threadId?: Id | null;
  expiresAt?: string | null;
}

export interface RecallOptions {
  key?: string;
  keyPrefix?: string;
  minTrust?: MemoryTrust;
  threadId?: Id;
  includeExpired?: boolean;
  includeSuperseded?: boolean;
  limit?: number;
}

/**
 * Ordered strongest first. Comparisons use the index, so a `minTrust` filter is
 * "this level or better" rather than an exact match.
 */
const TRUST_ORDER: MemoryTrust[] = ['attested', 'authenticated', 'asserted', 'derived'];

function rank(trust: MemoryTrust): number {
  return TRUST_ORDER.indexOf(trust);
}

/** The weaker of two levels. Used so inference cannot outrank its sources. */
export function weakest(a: MemoryTrust, b: MemoryTrust): MemoryTrust {
  return rank(a) >= rank(b) ? a : b;
}

/**
 * Derives the trust level of a fact read from a message.
 *
 * Both halves are required for `attested`, and the reason is the whole point of
 * the integrity work: DMARC can pass on SPF alignment alone with DKIM broken,
 * so an authenticated sender says nothing about an intact body — and a digest
 * that matches proves nothing if the header carrying it was not itself signed.
 * Only `verified` payload integrity together with `dkim: PASS` means both
 * questions were answered.
 */
export function trustOfMessage(message: Message): MemoryTrust {
  const dkim = (message.authResults?.dkim ?? '').toLowerCase();
  const dmarc = (message.authResults?.dmarc ?? '').toLowerCase();
  const verified = message.payloadIntegrity === 'verified';
  if (verified && dkim === 'pass') return 'attested';
  if (dkim === 'pass' || dmarc === 'pass') return 'authenticated';
  return 'asserted';
}

/**
 * Header lookup that does not care about case. Inbound headers arrive
 * lower-cased from the parser while an outbound message keeps the canonical
 * spelling, and reading the digest out of only one of those was a bug.
 */
function header(headers: Record<string, string> | undefined, name: string): string | null {
  if (!headers) return null;
  const needle = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === needle) return value;
  }
  return null;
}

/**
 * Durable, provenance-carrying knowledge for an agent.
 *
 * The rule the whole service enforces: a memory's trust is computed from where
 * it came from, never taken from the caller, and an inference is never stronger
 * than the weakest thing it was inferred from. Without that second rule an
 * agent could launder two rumours into a fact simply by concluding something
 * from them, which is exactly how a confused deputy is built.
 */
export class MemoryService {
  constructor(private readonly store: Store) {}

  async remember(agent: Agent, input: RememberInput): Promise<Memory> {
    const key = input.key?.trim();
    if (!key) throw badRequest('A memory needs a key.', 'key');
    if (key.length > 200) throw badRequest('key is limited to 200 characters.', 'key');
    if (input.value === undefined) throw badRequest('A memory needs a value.', 'value');

    const { trust, provenance } = await this.classify(agent, input);

    // Supersede rather than accumulate: the current answer for a key is one row.
    //
    // The old row is retired BEFORE the new one is written, because the schema
    // carries a unique index over live rows per (agent, key) — inserting first
    // would collide with the value being replaced. Everything that can reject
    // the write has already run above, so the window where a key has no live
    // value is a failed insert only; a store with transactions MUST do both in
    // one.
    const existing = await this.current(agent, key);
    const now = new Date().toISOString();
    if (existing) await this.store.updateMemory(existing.id, { supersededAt: now });

    const memory = await this.store.createMemory({
      id: newId('mem'),
      accountId: agent.accountId,
      agentId: agent.id,
      key,
      value: input.value,
      summary: (input.summary ?? '').slice(0, 500),
      trust,
      provenance,
      threadId: input.threadId ?? null,
      supersedes: existing?.id ?? null,
      supersededAt: null,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      revokedReason: null,
      createdAt: now,
    });

    await audit(this.store, {
      accountId: agent.accountId,
      actor: 'agent',
      action: 'memory.remembered',
      target: memory.id,
      metadata: {
        agent_id: agent.id,
        key,
        trust,
        origin: provenance.origin,
        message_id: provenance.messageId ?? null,
      },
    });
    return memory;
  }

  /**
   * Records a fact read out of a received message, carrying the message's
   * integrity verdict and digest into the memory. This is the path that keeps
   * the chain unbroken; `remember` with a hand-written provenance does not.
   */
  async rememberFromMessage(
    agent: Agent,
    message: Message,
    fact: { key: string; value: unknown; summary?: string; expiresAt?: string | null },
  ): Promise<Memory> {
    if (message.agentId !== agent.id) {
      throw forbidden('That message belongs to another mailbox.');
    }
    return this.remember(agent, {
      ...fact,
      origin: 'message',
      message,
      threadId: message.threadId,
    });
  }

  private async classify(
    agent: Agent,
    input: RememberInput,
  ): Promise<{ trust: MemoryTrust; provenance: MemoryProvenance }> {
    switch (input.origin) {
      case 'message': {
        const message = input.message;
        if (!message) throw badRequest('origin `message` needs the message it came from.', 'message');
        return {
          trust: trustOfMessage(message),
          provenance: {
            origin: 'message',
            messageId: message.id,
            rfcMessageId: message.rfcMessageId,
            contentDigest: header(message.headers, HEADER_CONTENT_DIGEST),
            assertedBy: message.context?.principal?.id ?? message.from.email,
            integrity: message.payloadIntegrity ?? null,
            dkim: message.authResults?.dkim ?? null,
          },
        };
      }
      case 'inference': {
        const sources = input.derivedFrom ?? [];
        if (!sources.length) {
          throw badRequest('origin `inference` needs derived_from.', 'derived_from');
        }
        // An inference is capped at `derived`, and further capped by its weakest
        // source: concluding something from two guesses does not make it known.
        let trust: MemoryTrust = 'derived';
        for (const id of sources) {
          const source = await this.store.getMemory(id);
          if (!source || source.agentId !== agent.id) {
            throw badRequest(`derived_from references an unknown memory: ${id}`, 'derived_from');
          }
          trust = weakest(trust, source.trust);
        }
        return { trust, provenance: { origin: 'inference', derivedFrom: sources } };
      }
      case 'human':
        return {
          trust: 'authenticated',
          provenance: { origin: 'human', assertedBy: input.assertedBy ?? 'human' },
        };
      case 'seed':
        return {
          trust: 'authenticated',
          provenance: { origin: 'seed', assertedBy: `agent:${agent.id}` },
        };
      default:
        throw badRequest(`Unknown memory origin: ${String(input.origin)}`, 'origin');
    }
  }

  /** The live memory for a key, if any. */
  async current(agent: Agent, key: string): Promise<Memory | null> {
    const [found] = await this.recall(agent, { key, limit: 1 });
    return found ?? null;
  }

  async recall(agent: Agent, options: RecallOptions = {}): Promise<Memory[]> {
    const now = Date.now();
    const rows = await this.store.listMemories({
      accountId: agent.accountId,
      agentId: agent.id,
      key: options.key,
      keyPrefix: options.keyPrefix,
      threadId: options.threadId,
      limit: Math.min(Math.max(options.limit ?? 50, 1), 500),
    });
    const floor = options.minTrust ? rank(options.minTrust) : TRUST_ORDER.length;
    return rows.filter((memory) => {
      if (memory.revokedAt) return false;
      if (!options.includeSuperseded && memory.supersededAt) return false;
      if (!options.includeExpired && memory.expiresAt && Date.parse(memory.expiresAt) <= now) {
        return false;
      }
      return rank(memory.trust) <= floor;
    });
  }

  async get(agent: Agent, memoryId: Id): Promise<Memory> {
    const memory = await this.store.getMemory(memoryId);
    if (!memory || memory.accountId !== agent.accountId) throw notFound('Memory');
    if (memory.agentId !== agent.id) throw forbidden('That memory belongs to another agent.');
    return memory;
  }

  /**
   * Tombstones a memory. The row stays so the audit trail still explains what
   * the agent believed and when it stopped; `purge` is the destructive one.
   */
  async forget(agent: Agent, memoryId: Id, reason?: string): Promise<Memory> {
    const memory = await this.get(agent, memoryId);
    if (memory.revokedAt) return memory;
    const updated = await this.store.updateMemory(memoryId, {
      revokedAt: new Date().toISOString(),
      revokedReason: reason ?? null,
    });
    await audit(this.store, {
      accountId: agent.accountId,
      actor: 'agent',
      action: 'memory.forgotten',
      target: memoryId,
      metadata: { agent_id: agent.id, key: memory.key, reason: reason ?? null },
    });
    return updated;
  }

  /** Irreversible deletion, for when the content itself must not persist. */
  async purge(agent: Agent, memoryId: Id): Promise<void> {
    const memory = await this.get(agent, memoryId);
    await this.store.deleteMemory(memoryId);
    await audit(this.store, {
      accountId: agent.accountId,
      actor: 'agent',
      action: 'memory.purged',
      target: memoryId,
      metadata: { agent_id: agent.id, key: memory.key },
    });
  }

  /**
   * Whether a memory is strong enough to act on without asking a human.
   *
   * `attested` is the bar because it is the only level where both questions
   * were answered: the sender is who they claim, and the content is what they
   * wrote. Everything below it is recall, not authority — an agent may reason
   * with it, cite it, and reply about it, but should not take an irreversible
   * action on it alone.
   */
  mayActOn(memory: Memory, now = Date.now()): boolean {
    if (memory.revokedAt || memory.supersededAt) return false;
    if (memory.expiresAt && Date.parse(memory.expiresAt) <= now) return false;
    return memory.trust === 'attested';
  }
}
