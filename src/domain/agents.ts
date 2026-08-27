import type { Config } from '../config.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { Store } from '../store/types.js';
import type { Account, Agent, Id, InboxPolicy } from '../types.js';
import { domainOf, isValidEmail } from '../util/email.js';
import { newId, slugify } from '../util/ids.js';

export interface CreateAgentInput {
  slug?: string;
  displayName: string;
  description?: string;
  capabilities?: string[];
  inboxPolicy?: InboxPolicy;
  allowlist?: string[];
  discoverable?: boolean;
  webhookUrl?: string | null;
  maxHops?: number;
  maxThreadRate?: number;
  /**
   * Optional explicit address on a domain the account has verified. Omit to
   * take a hosted address under the platform's agent domain, which needs no
   * DNS from the customer at all.
   */
  address?: string;
}

export interface DeliverabilityDecision {
  accepted: boolean;
  reason?: string;
}

export class AgentService {
  constructor(private readonly store: Store, private readonly config: Config) {}

  /** `billing@acme.agents.agentmail.test` — one namespace per account. */
  hostedAddress(account: Account, slug: string): string {
    return `${slug}@${account.slug}.${this.config.agentDomain}`;
  }

  isHostedAddress(address: string): boolean {
    return domainOf(address).endsWith(`.${this.config.agentDomain}`) ||
      domainOf(address) === this.config.agentDomain;
  }

  async create(account: Account, input: CreateAgentInput): Promise<Agent> {
    const slug = slugify(input.slug ?? input.displayName);
    if (!slug) throw badRequest('An agent needs a name that yields a usable slug.', 'display_name');

    let address: string;
    if (input.address) {
      address = input.address.trim().toLowerCase();
      if (!isValidEmail(address)) throw badRequest('address is not a valid email address.', 'address');
      const domain = await this.store.findDomain(account.id, domainOf(address));
      if (!domain) {
        throw badRequest(
          `The account has no domain ${domainOf(address)}. Add and verify it, or omit address for a hosted one.`,
          'address',
        );
      }
      if (domain.status !== 'verified') {
        throw badRequest(`Domain ${domain.domain} is not verified yet.`, 'address');
      }
    } else {
      address = this.hostedAddress(account, slug);
    }

    if (await this.store.getAgentByAddress(address)) {
      throw conflict(`The address ${address} is already in use.`);
    }

    return this.store.createAgent({
      id: newId('agt'),
      accountId: account.id,
      slug,
      address,
      displayName: input.displayName,
      description: input.description ?? '',
      capabilities: input.capabilities ?? [],
      inboxPolicy: input.inboxPolicy ?? 'verified',
      allowlist: (input.allowlist ?? []).map((entry) => entry.toLowerCase()),
      discoverable: input.discoverable ?? false,
      status: 'active',
      webhookUrl: input.webhookUrl ?? null,
      maxHops: input.maxHops ?? this.config.defaultMaxHops,
      maxThreadRate: input.maxThreadRate ?? this.config.defaultMaxThreadRate,
      createdAt: new Date().toISOString(),
    });
  }

  async get(accountId: Id, agentId: Id): Promise<Agent> {
    const agent = await this.store.getAgent(agentId);
    if (!agent || agent.accountId !== accountId) throw notFound('Agent');
    return agent;
  }

  async list(accountId: Id): Promise<Agent[]> {
    return this.store.listAgents(accountId);
  }

  async update(accountId: Id, agentId: Id, patch: Partial<Agent>): Promise<Agent> {
    await this.get(accountId, agentId);
    const allowed: Partial<Agent> = {};
    for (const field of [
      'displayName',
      'description',
      'capabilities',
      'inboxPolicy',
      'allowlist',
      'discoverable',
      'status',
      'webhookUrl',
      'maxHops',
      'maxThreadRate',
    ] as const) {
      if (patch[field] !== undefined) (allowed as Record<string, unknown>)[field] = patch[field];
    }
    return this.store.updateAgent(agentId, allowed);
  }

  async remove(accountId: Id, agentId: Id): Promise<void> {
    await this.get(accountId, agentId);
    await this.store.deleteAgent(agentId);
  }

  /** Resolves an address to a local agent mailbox, if one exists. */
  async resolve(address: string): Promise<Agent | null> {
    return this.store.getAgentByAddress(address.trim().toLowerCase());
  }

  async directory(query: { query?: string; capability?: string; limit?: number }): Promise<Agent[]> {
    return this.store.searchDirectory(query);
  }

  /**
   * Inbox policy (§ agent deliverability). `senderIsLocalAgent` is true for
   * platform-hosted agents, whose identity the platform vouches for directly;
   * `dmarcAligned` reflects authentication of an external sender.
   */
  canAccept(
    agent: Agent,
    fromEmail: string,
    context: { senderIsLocalAgent: boolean; dmarcAligned: boolean },
  ): DeliverabilityDecision {
    if (agent.status !== 'active') {
      return { accepted: false, reason: `Agent ${agent.address} is paused.` };
    }
    const from = fromEmail.toLowerCase();
    switch (agent.inboxPolicy) {
      case 'open':
        return { accepted: true };
      case 'closed':
        return { accepted: false, reason: `Agent ${agent.address} does not accept incoming mail.` };
      case 'allowlist':
        return matchesAllowlist(agent.allowlist, from)
          ? { accepted: true }
          : { accepted: false, reason: `Sender ${from} is not on the allowlist for ${agent.address}.` };
      case 'verified':
        if (context.senderIsLocalAgent || context.dmarcAligned) return { accepted: true };
        return {
          accepted: false,
          reason: `Agent ${agent.address} accepts mail only from authenticated senders.`,
        };
      default:
        return { accepted: false, reason: 'Unknown inbox policy.' };
    }
  }

  assertOwned(agent: Agent, accountId: Id): void {
    if (agent.accountId !== accountId) throw forbidden('That agent belongs to another account.');
  }
}

function matchesAllowlist(allowlist: string[], from: string): boolean {
  const senderDomain = `@${domainOf(from)}`;
  return allowlist.some((entry) => entry === from || entry === senderDomain);
}
