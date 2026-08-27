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
  MailboxState,
  Message,
  MessageDirection,
  MessageEvent,
  MessageKind,
  MessageStatus,
  Suppression,
  Template,
  Timestamp,
  User,
  Webhook,
  WebhookDelivery,
} from '../types.js';

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export interface MessageFilter {
  accountId: Id;
  agentId?: Id;
  direction?: MessageDirection;
  kind?: MessageKind;
  status?: MessageStatus;
  mailboxState?: MailboxState;
  threadId?: Id;
  campaignId?: Id;
  /** Matches any recipient address. */
  recipient?: string;
  /** Free-text match against subject and body. */
  query?: string;
  since?: Timestamp;
  until?: Timestamp;
  limit?: number;
  cursor?: string | null;
}

export interface AgentDirectoryQuery {
  query?: string;
  capability?: string;
  limit?: number;
}

/**
 * Persistence port. The in-memory implementation is the reference; a Postgres
 * implementation backs the schema in `migrations/001_init.sql`.
 */
export interface Store {
  /* accounts and users */
  createAccount(account: Account): Promise<Account>;
  getAccount(id: Id): Promise<Account | null>;
  getAccountBySlug(slug: string): Promise<Account | null>;
  updateAccount(id: Id, patch: Partial<Account>): Promise<Account>;
  listAccounts(): Promise<Account[]>;

  createUser(user: User): Promise<User>;
  listUsers(accountId: Id): Promise<User[]>;

  /* api keys */
  createApiKey(key: ApiKey): Promise<ApiKey>;
  getApiKey(id: Id): Promise<ApiKey | null>;
  listApiKeys(accountId: Id): Promise<ApiKey[]>;
  findApiKeysByPrefix(prefix: string): Promise<ApiKey[]>;
  updateApiKey(id: Id, patch: Partial<ApiKey>): Promise<ApiKey>;

  /* domains */
  createDomain(domain: Domain): Promise<Domain>;
  getDomain(id: Id): Promise<Domain | null>;
  findDomain(accountId: Id, domain: string): Promise<Domain | null>;
  listDomains(accountId: Id): Promise<Domain[]>;
  updateDomain(id: Id, patch: Partial<Domain>): Promise<Domain>;
  deleteDomain(id: Id): Promise<void>;

  /* agents */
  createAgent(agent: Agent): Promise<Agent>;
  getAgent(id: Id): Promise<Agent | null>;
  getAgentByAddress(address: string): Promise<Agent | null>;
  listAgents(accountId: Id): Promise<Agent[]>;
  updateAgent(id: Id, patch: Partial<Agent>): Promise<Agent>;
  deleteAgent(id: Id): Promise<void>;
  searchDirectory(query: AgentDirectoryQuery): Promise<Agent[]>;

  /* messages and events */
  createMessage(message: Message): Promise<Message>;
  getMessage(id: Id): Promise<Message | null>;
  updateMessage(id: Id, patch: Partial<Message>): Promise<Message>;
  listMessages(filter: MessageFilter): Promise<Page<Message>>;
  findByIdempotencyKey(accountId: Id, key: string): Promise<Message | null>;
  /** Scoped by account: a Message-ID must never resolve across tenants. */
  findByRfcMessageId(accountId: Id, rfcMessageId: string): Promise<Message | null>;
  findByProviderMessageId(providerMessageId: string): Promise<Message | null>;
  /** Messages handed to a provider since `since`; drives the daily send limit. */
  countSentSince(accountId: Id, since: Timestamp): Promise<number>;
  /** Messages in a thread created at or after `since`; drives the loop guard. */
  countThreadSince(threadId: Id, since: Timestamp): Promise<number>;
  /** Inbound messages whose lease has expired, for return to `unread`. */
  findExpiredLeases(now: Timestamp): Promise<Message[]>;

  appendEvent(event: MessageEvent): Promise<MessageEvent>;
  getEvent(id: Id): Promise<MessageEvent | null>;
  listEvents(messageId: Id): Promise<MessageEvent[]>;

  /* suppression */
  addSuppression(entry: Suppression): Promise<Suppression>;
  findSuppression(accountId: Id, email: string): Promise<Suppression | null>;
  listSuppressions(accountId: Id): Promise<Suppression[]>;
  deleteSuppression(id: Id): Promise<void>;

  /* templates */
  createTemplate(template: Template): Promise<Template>;
  getTemplate(id: Id): Promise<Template | null>;
  findTemplateByName(accountId: Id, name: string): Promise<Template | null>;
  listTemplates(accountId: Id): Promise<Template[]>;
  updateTemplate(id: Id, patch: Partial<Template>): Promise<Template>;
  deleteTemplate(id: Id): Promise<void>;

  /* lists and contacts */
  createList(list: ContactList): Promise<ContactList>;
  getList(id: Id): Promise<ContactList | null>;
  listLists(accountId: Id): Promise<ContactList[]>;
  deleteList(id: Id): Promise<void>;

  upsertContact(contact: Contact): Promise<Contact>;
  getContact(id: Id): Promise<Contact | null>;
  findContact(listId: Id, email: string): Promise<Contact | null>;
  listContacts(listId: Id): Promise<Contact[]>;
  updateContact(id: Id, patch: Partial<Contact>): Promise<Contact>;
  deleteContact(id: Id): Promise<void>;

  /* campaigns */
  createCampaign(campaign: Campaign): Promise<Campaign>;
  getCampaign(id: Id): Promise<Campaign | null>;
  listCampaigns(accountId: Id): Promise<Campaign[]>;
  updateCampaign(id: Id, patch: Partial<Campaign>): Promise<Campaign>;
  deleteCampaign(id: Id): Promise<void>;

  /* webhooks */
  createWebhook(webhook: Webhook): Promise<Webhook>;
  getWebhook(id: Id): Promise<Webhook | null>;
  listWebhooks(accountId: Id): Promise<Webhook[]>;
  updateWebhook(id: Id, patch: Partial<Webhook>): Promise<Webhook>;
  deleteWebhook(id: Id): Promise<void>;

  createWebhookDelivery(delivery: WebhookDelivery): Promise<WebhookDelivery>;
  updateWebhookDelivery(id: Id, patch: Partial<WebhookDelivery>): Promise<WebhookDelivery>;
  listWebhookDeliveries(webhookId: Id, limit?: number): Promise<WebhookDelivery[]>;

  /* audit */
  appendAudit(entry: AuditEntry): Promise<AuditEntry>;
  listAudit(accountId?: Id, limit?: number): Promise<AuditEntry[]>;

  close(): Promise<void>;
}
