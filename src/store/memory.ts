import type {
  Account,
  Agent,
  ApiKey,
  AuditEntry,
  Campaign,
  Contact,
  ContactList,
  Domain,
  Id,
  Message,
  MessageEvent,
  Suppression,
  Template,
  Timestamp,
  User,
  Webhook,
  WebhookDelivery,
} from '../types.js';
import { notFound } from '../errors.js';
import type { AgentDirectoryQuery, MessageFilter, Page, Store } from './types.js';

/** Deep-ish clone so callers cannot mutate stored records by reference. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

class Collection<T extends { id: Id }> {
  private readonly items = new Map<Id, T>();

  insert(item: T): T {
    this.items.set(item.id, clone(item));
    return clone(item);
  }

  get(id: Id): T | null {
    const found = this.items.get(id);
    return found ? clone(found) : null;
  }

  update(id: Id, patch: Partial<T>, label: string): T {
    const existing = this.items.get(id);
    if (!existing) throw notFound(label);
    const merged = { ...existing, ...clone(patch), id } as T;
    this.items.set(id, merged);
    return clone(merged);
  }

  delete(id: Id): void {
    this.items.delete(id);
  }

  all(): T[] {
    return [...this.items.values()].map(clone);
  }

  find(predicate: (item: T) => boolean): T | null {
    for (const item of this.items.values()) if (predicate(item)) return clone(item);
    return null;
  }

  filter(predicate: (item: T) => boolean): T[] {
    return this.all().filter(predicate);
  }
}

export class MemoryStore implements Store {
  private readonly accounts = new Collection<Account>();
  private readonly users = new Collection<User>();
  private readonly apiKeys = new Collection<ApiKey>();
  private readonly domains = new Collection<Domain>();
  private readonly agents = new Collection<Agent>();
  private readonly messages = new Collection<Message>();
  private readonly events = new Collection<MessageEvent>();
  private readonly suppressions = new Collection<Suppression>();
  private readonly templates = new Collection<Template>();
  private readonly lists = new Collection<ContactList>();
  private readonly contacts = new Collection<Contact>();
  private readonly campaigns = new Collection<Campaign>();
  private readonly webhooks = new Collection<Webhook>();
  private readonly webhookDeliveries = new Collection<WebhookDelivery>();
  private readonly audit = new Collection<AuditEntry>();

  /* accounts and users */

  async createAccount(account: Account): Promise<Account> {
    return this.accounts.insert(account);
  }
  async getAccount(id: Id): Promise<Account | null> {
    return this.accounts.get(id);
  }
  async getAccountBySlug(slug: string): Promise<Account | null> {
    return this.accounts.find((a) => a.slug === slug);
  }
  async updateAccount(id: Id, patch: Partial<Account>): Promise<Account> {
    return this.accounts.update(id, patch, 'Account');
  }
  async listAccounts(): Promise<Account[]> {
    return this.accounts.all();
  }

  async createUser(user: User): Promise<User> {
    return this.users.insert(user);
  }
  async listUsers(accountId: Id): Promise<User[]> {
    return this.users.filter((u) => u.accountId === accountId);
  }

  /* api keys */

  async createApiKey(key: ApiKey): Promise<ApiKey> {
    return this.apiKeys.insert(key);
  }
  async getApiKey(id: Id): Promise<ApiKey | null> {
    return this.apiKeys.get(id);
  }
  async listApiKeys(accountId: Id): Promise<ApiKey[]> {
    return this.apiKeys.filter((k) => k.accountId === accountId);
  }
  async findApiKeysByPrefix(prefix: string): Promise<ApiKey[]> {
    return this.apiKeys.filter((k) => k.prefix === prefix && !k.revokedAt);
  }
  async updateApiKey(id: Id, patch: Partial<ApiKey>): Promise<ApiKey> {
    return this.apiKeys.update(id, patch, 'API key');
  }

  /* domains */

  async createDomain(domain: Domain): Promise<Domain> {
    return this.domains.insert(domain);
  }
  async getDomain(id: Id): Promise<Domain | null> {
    return this.domains.get(id);
  }
  async findDomain(accountId: Id, domain: string): Promise<Domain | null> {
    const needle = domain.toLowerCase();
    return this.domains.find((d) => d.accountId === accountId && d.domain === needle);
  }
  async listDomains(accountId: Id): Promise<Domain[]> {
    return this.domains.filter((d) => d.accountId === accountId);
  }
  async updateDomain(id: Id, patch: Partial<Domain>): Promise<Domain> {
    return this.domains.update(id, patch, 'Domain');
  }
  async deleteDomain(id: Id): Promise<void> {
    this.domains.delete(id);
  }

  /* agents */

  async createAgent(agent: Agent): Promise<Agent> {
    return this.agents.insert(agent);
  }
  async getAgent(id: Id): Promise<Agent | null> {
    return this.agents.get(id);
  }
  async getAgentByAddress(address: string): Promise<Agent | null> {
    const needle = address.toLowerCase();
    return this.agents.find((a) => a.address === needle);
  }
  async listAgents(accountId: Id): Promise<Agent[]> {
    return this.agents.filter((a) => a.accountId === accountId);
  }
  async updateAgent(id: Id, patch: Partial<Agent>): Promise<Agent> {
    return this.agents.update(id, patch, 'Agent');
  }
  async deleteAgent(id: Id): Promise<void> {
    this.agents.delete(id);
  }
  async searchDirectory(query: AgentDirectoryQuery): Promise<Agent[]> {
    const needle = query.query?.toLowerCase().trim();
    const results = this.agents.filter((agent) => {
      if (!agent.discoverable || agent.status !== 'active') return false;
      if (query.capability && !agent.capabilities.includes(query.capability)) return false;
      if (!needle) return true;
      return (
        agent.address.includes(needle) ||
        agent.displayName.toLowerCase().includes(needle) ||
        agent.description.toLowerCase().includes(needle) ||
        agent.capabilities.some((c) => c.toLowerCase().includes(needle))
      );
    });
    return results.slice(0, query.limit ?? 25);
  }

  /* messages and events */

  async createMessage(message: Message): Promise<Message> {
    return this.messages.insert(message);
  }
  async getMessage(id: Id): Promise<Message | null> {
    return this.messages.get(id);
  }
  async updateMessage(id: Id, patch: Partial<Message>): Promise<Message> {
    return this.messages.update(id, { ...patch, updatedAt: new Date().toISOString() }, 'Message');
  }

  async listMessages(filter: MessageFilter): Promise<Page<Message>> {
    const query = filter.query?.toLowerCase();
    const recipient = filter.recipient?.toLowerCase();
    const matches = this.messages
      .filter((m) => {
        if (m.accountId !== filter.accountId) return false;
        if (filter.agentId && m.agentId !== filter.agentId) return false;
        if (filter.direction && m.direction !== filter.direction) return false;
        if (filter.kind && m.kind !== filter.kind) return false;
        if (filter.status && m.status !== filter.status) return false;
        if (filter.mailboxState && m.mailboxState !== filter.mailboxState) return false;
        if (filter.threadId && m.threadId !== filter.threadId) return false;
        if (filter.campaignId && m.campaignId !== filter.campaignId) return false;
        if (filter.since && m.createdAt < filter.since) return false;
        if (filter.until && m.createdAt > filter.until) return false;
        if (recipient && !m.to.some((a) => a.email === recipient)) return false;
        if (filter.tagKey) {
          if (!(filter.tagKey in m.tags)) return false;
          if (filter.tagValue !== undefined && m.tags[filter.tagKey] !== filter.tagValue) return false;
        }
        if (query) {
          const haystack = `${m.subject} ${m.text ?? ''} ${m.html ?? ''}`.toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        return true;
      })
      .sort((a, b) => (a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)));

    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const start = filter.cursor ? matches.findIndex((m) => m.id === filter.cursor) + 1 : 0;
    const window = matches.slice(start, start + limit);
    const nextCursor = start + limit < matches.length && window.length ? window[window.length - 1].id : null;
    return { data: window, nextCursor };
  }

  async findByIdempotencyKey(accountId: Id, key: string): Promise<Message | null> {
    return this.messages.find((m) => m.accountId === accountId && m.idempotencyKey === key);
  }
  async findByRfcMessageId(accountId: Id, rfcMessageId: string): Promise<Message | null> {
    return this.messages.find((m) => m.accountId === accountId && m.rfcMessageId === rfcMessageId);
  }
  async findByProviderMessageId(providerMessageId: string): Promise<Message | null> {
    return this.messages.find((m) => m.providerMessageId === providerMessageId);
  }
  async countSentSince(accountId: Id, since: Timestamp): Promise<number> {
    return this.messages.filter(
      (m) =>
        m.accountId === accountId &&
        m.direction === 'outbound' &&
        m.transport === 'provider' &&
        m.createdAt >= since &&
        m.status !== 'skipped' &&
        m.status !== 'canceled',
    ).length;
  }
  async countThreadSince(threadId: Id, since: Timestamp): Promise<number> {
    return this.messages.filter((m) => m.threadId === threadId && m.createdAt >= since).length;
  }
  async findExpiredLeases(now: Timestamp): Promise<Message[]> {
    return this.messages.filter(
      (m) => m.mailboxState === 'claimed' && !!m.leaseExpiresAt && m.leaseExpiresAt <= now,
    );
  }

  async appendEvent(event: MessageEvent): Promise<MessageEvent> {
    return this.events.insert(event);
  }
  async getEvent(id: Id): Promise<MessageEvent | null> {
    return this.events.get(id);
  }
  async listEvents(messageId: Id): Promise<MessageEvent[]> {
    return this.events
      .filter((e) => e.messageId === messageId)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }

  /* suppression */

  async addSuppression(entry: Suppression): Promise<Suppression> {
    const existing = await this.findSuppression(entry.accountId, entry.email);
    if (existing) return existing;
    return this.suppressions.insert({ ...entry, email: entry.email.toLowerCase() });
  }
  async findSuppression(accountId: Id, email: string): Promise<Suppression | null> {
    const needle = email.toLowerCase();
    return this.suppressions.find((s) => s.accountId === accountId && s.email === needle);
  }
  async listSuppressions(accountId: Id): Promise<Suppression[]> {
    return this.suppressions.filter((s) => s.accountId === accountId);
  }
  async deleteSuppression(id: Id): Promise<void> {
    this.suppressions.delete(id);
  }

  /* templates */

  async createTemplate(template: Template): Promise<Template> {
    return this.templates.insert(template);
  }
  async getTemplate(id: Id): Promise<Template | null> {
    return this.templates.get(id);
  }
  async findTemplateByName(accountId: Id, name: string): Promise<Template | null> {
    return this.templates.find((t) => t.accountId === accountId && t.name === name);
  }
  async listTemplates(accountId: Id): Promise<Template[]> {
    return this.templates.filter((t) => t.accountId === accountId);
  }
  async updateTemplate(id: Id, patch: Partial<Template>): Promise<Template> {
    return this.templates.update(id, patch, 'Template');
  }
  async deleteTemplate(id: Id): Promise<void> {
    this.templates.delete(id);
  }

  /* lists and contacts */

  async createList(list: ContactList): Promise<ContactList> {
    return this.lists.insert(list);
  }
  async getList(id: Id): Promise<ContactList | null> {
    return this.lists.get(id);
  }
  async listLists(accountId: Id): Promise<ContactList[]> {
    return this.lists.filter((l) => l.accountId === accountId);
  }
  async deleteList(id: Id): Promise<void> {
    this.lists.delete(id);
    for (const contact of this.contacts.filter((c) => c.listId === id)) this.contacts.delete(contact.id);
  }

  async upsertContact(contact: Contact): Promise<Contact> {
    const existing = await this.findContact(contact.listId, contact.email);
    if (existing) {
      return this.contacts.update(
        existing.id,
        {
          name: contact.name ?? existing.name,
          customFields: { ...existing.customFields, ...contact.customFields },
          status: contact.status,
        },
        'Contact',
      );
    }
    return this.contacts.insert({ ...contact, email: contact.email.toLowerCase() });
  }
  async getContact(id: Id): Promise<Contact | null> {
    return this.contacts.get(id);
  }
  async findContact(listId: Id, email: string): Promise<Contact | null> {
    const needle = email.toLowerCase();
    return this.contacts.find((c) => c.listId === listId && c.email === needle);
  }
  async listContacts(listId: Id): Promise<Contact[]> {
    return this.contacts.filter((c) => c.listId === listId);
  }
  async updateContact(id: Id, patch: Partial<Contact>): Promise<Contact> {
    return this.contacts.update(id, patch, 'Contact');
  }
  async deleteContact(id: Id): Promise<void> {
    this.contacts.delete(id);
  }

  /* campaigns */

  async createCampaign(campaign: Campaign): Promise<Campaign> {
    return this.campaigns.insert(campaign);
  }
  async getCampaign(id: Id): Promise<Campaign | null> {
    return this.campaigns.get(id);
  }
  async listCampaigns(accountId: Id): Promise<Campaign[]> {
    return this.campaigns.filter((c) => c.accountId === accountId);
  }
  async updateCampaign(id: Id, patch: Partial<Campaign>): Promise<Campaign> {
    return this.campaigns.update(id, patch, 'Campaign');
  }
  async deleteCampaign(id: Id): Promise<void> {
    this.campaigns.delete(id);
  }

  /* webhooks */

  async createWebhook(webhook: Webhook): Promise<Webhook> {
    return this.webhooks.insert(webhook);
  }
  async getWebhook(id: Id): Promise<Webhook | null> {
    return this.webhooks.get(id);
  }
  async listWebhooks(accountId: Id): Promise<Webhook[]> {
    return this.webhooks.filter((w) => w.accountId === accountId);
  }
  async updateWebhook(id: Id, patch: Partial<Webhook>): Promise<Webhook> {
    return this.webhooks.update(id, patch, 'Webhook');
  }
  async deleteWebhook(id: Id): Promise<void> {
    this.webhooks.delete(id);
  }

  async createWebhookDelivery(delivery: WebhookDelivery): Promise<WebhookDelivery> {
    return this.webhookDeliveries.insert(delivery);
  }
  async updateWebhookDelivery(id: Id, patch: Partial<WebhookDelivery>): Promise<WebhookDelivery> {
    return this.webhookDeliveries.update(id, patch, 'Webhook delivery');
  }
  async listWebhookDeliveries(webhookId: Id, limit = 50): Promise<WebhookDelivery[]> {
    return this.webhookDeliveries
      .filter((d) => d.webhookId === webhookId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  /* audit */

  async appendAudit(entry: AuditEntry): Promise<AuditEntry> {
    return this.audit.insert(entry);
  }
  async listAudit(accountId?: Id, limit = 100): Promise<AuditEntry[]> {
    return this.audit
      .filter((e) => (accountId ? e.accountId === accountId : true))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, limit);
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}
