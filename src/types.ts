/**
 * Core domain types.
 *
 * The model is deliberately single-table-ish for messages: an agent's inbox
 * entry *is* a message row with `direction: 'inbound'` and an `agentId`. Email
 * is the substrate for both humans and agents, so there is no second store to
 * keep in sync.
 */

export type Id = string;
export type Timestamp = string; // ISO 8601, UTC

/* ------------------------------------------------------------------ accounts */

export type AccountStatus = 'active' | 'paused' | 'suspended';

export interface Account {
  id: Id;
  /** URL-safe slug, also the label of the account's agent namespace. */
  slug: string;
  name: string;
  /** SES tenant this account maps to 1:1. */
  tenantName: string;
  status: AccountStatus;
  plan: string;
  /** Messages per day the account may hand to a provider. Starts low (FR-12.1). */
  dailySendLimit: number;
  createdAt: Timestamp;
}

export type Role = 'owner' | 'developer' | 'marketer' | 'viewer';

export interface User {
  id: Id;
  accountId: Id;
  email: string;
  role: Role;
  createdAt: Timestamp;
}

/* ------------------------------------------------------------------ api keys */

/**
 * `agent` keys are the interesting one: they authenticate a single agent to a
 * single mailbox, so an agent process can be handed a credential that cannot
 * read anyone else's mail or send as anyone else.
 */
export type KeyScope = 'full' | 'send' | 'read' | 'agent';

export interface ApiKey {
  id: Id;
  accountId: Id;
  name: string;
  /** Non-secret display prefix, e.g. `am_live_9f3a`. */
  prefix: string;
  keyHash: string;
  scope: KeyScope;
  /** Set when scope is `agent`; the only mailbox this key may touch. */
  agentId?: Id | null;
  /** Optional restriction to one sending domain. */
  domainId?: Id | null;
  lastUsedAt?: Timestamp | null;
  revokedAt?: Timestamp | null;
  createdAt: Timestamp;
}

/* ------------------------------------------------------------------- domains */

export type DomainStatus = 'pending' | 'verified' | 'failed';

export interface DnsRecord {
  type: 'CNAME' | 'MX' | 'TXT';
  name: string;
  value: string;
  priority?: number;
  purpose: 'dkim' | 'mail_from' | 'spf' | 'dmarc' | 'tracking';
  status: DomainStatus;
}

export interface Domain {
  id: Id;
  accountId: Id;
  domain: string;
  mailFromSubdomain: string;
  configSetName: string;
  status: DomainStatus;
  records: DnsRecord[];
  /** Diagnostics from the DMARC/SPF/MX checks in DR-3. */
  warnings: string[];
  verifiedAt?: Timestamp | null;
  createdAt: Timestamp;
}

/* -------------------------------------------------------------------- agents */

/**
 * Who may put mail in this agent's inbox.
 * - `open`      anyone
 * - `verified`  other AgentMail agents, plus DMARC-aligned external senders
 * - `allowlist` only addresses (or `@domain` patterns) on the allowlist
 * - `closed`    nobody; the agent only sends
 */
export type InboxPolicy = 'open' | 'verified' | 'allowlist' | 'closed';

export interface Agent {
  id: Id;
  accountId: Id;
  slug: string;
  /** Fully-qualified address. Platform-hosted unless the account owns the domain. */
  address: string;
  displayName: string;
  description: string;
  /** Free-form capability tags surfaced by the directory, e.g. `invoice.parse`. */
  capabilities: string[];
  inboxPolicy: InboxPolicy;
  /** Addresses or `@domain` patterns honoured when inboxPolicy is `allowlist`. */
  allowlist: string[];
  /** Listed in the public agent directory when true. */
  discoverable: boolean;
  status: 'active' | 'paused';
  /** Push endpoint notified on inbound mail, in addition to polling. */
  webhookUrl?: string | null;
  /** Automated-reply loop guard: refuse to send past this hop count. */
  maxHops: number;
  /** Per-thread ceiling, messages per minute, guarding tight A2A ping-pong. */
  maxThreadRate: number;
  createdAt: Timestamp;
}

/* ------------------------------------------------------------------ messages */

export type MessageKind = 'transactional' | 'campaign' | 'agent';
export type MessageDirection = 'outbound' | 'inbound';
/** `internal` never leaves the platform: agent-to-agent on hosted addresses. */
export type Transport = 'internal' | 'provider';

export type MessageStatus =
  | 'scheduled'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'failed'
  | 'skipped'
  | 'canceled'
  | 'received';

/** Mailbox lifecycle for inbound messages. Mirrors a lease queue, not a folder. */
export type MailboxState = 'unread' | 'claimed' | 'acked' | 'archived';

export interface Attachment {
  filename: string;
  contentType: string;
  /** Base64. */
  content: string;
}

export interface Address {
  email: string;
  name?: string;
}

export interface Message {
  id: Id;
  accountId: Id;
  kind: MessageKind;
  direction: MessageDirection;
  transport: Transport;
  status: MessageStatus;

  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];

  subject: string;
  html?: string | null;
  text?: string | null;
  headers: Record<string, string>;
  attachments: Attachment[];

  /**
   * Machine-readable payload for agent-to-agent work. Survives external
   * transport as an `application/json` part named `agentmail.json`.
   */
  structured?: unknown;

  /** RFC 5322 Message-ID, angle brackets included. */
  rfcMessageId: string;
  inReplyTo?: string | null;
  references: string[];
  threadId: Id;

  /** Owning mailbox for inbound; sending agent for outbound. */
  agentId?: Id | null;
  campaignId?: Id | null;
  templateId?: Id | null;
  tags: Record<string, string>;

  /** Automated-reply depth; incremented on every agent-generated reply. */
  hops: number;

  providerMessageId?: string | null;
  error?: string | null;
  idempotencyKey?: string | null;

  /* mailbox fields, inbound only */
  mailboxState?: MailboxState | null;
  claimedBy?: string | null;
  leaseExpiresAt?: Timestamp | null;
  deliveryAttempts?: number;

  scheduledAt?: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type MessageEventType =
  | 'accepted'
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'rejected'
  | 'opened'
  | 'clicked'
  | 'delayed'
  | 'failed'
  | 'skipped'
  | 'received'
  | 'claimed'
  | 'acked';

export interface MessageEvent {
  id: Id;
  accountId: Id;
  messageId: Id;
  type: MessageEventType;
  occurredAt: Timestamp;
  metadata: Record<string, unknown>;
}

/* --------------------------------------------------------------- suppression */

export type SuppressionReason =
  | 'hard_bounce'
  | 'soft_bounce'
  | 'complaint'
  | 'unsubscribe'
  | 'manual';

export interface Suppression {
  id: Id;
  accountId: Id;
  email: string;
  reason: SuppressionReason;
  listId?: Id | null;
  note?: string | null;
  createdAt: Timestamp;
}

/* ----------------------------------------------------------------- templates */

export interface Template {
  id: Id;
  accountId: Id;
  name: string;
  version: number;
  subject: string;
  html: string;
  text: string;
  createdAt: Timestamp;
}

/* --------------------------------------------------------- lists & campaigns */

export type ContactStatus = 'subscribed' | 'unconfirmed' | 'unsubscribed';

export interface ContactList {
  id: Id;
  accountId: Id;
  name: string;
  doubleOptin: boolean;
  createdAt: Timestamp;
}

export interface Contact {
  id: Id;
  accountId: Id;
  listId: Id;
  email: string;
  name?: string | null;
  customFields: Record<string, unknown>;
  status: ContactStatus;
  source: string;
  confirmedAt?: Timestamp | null;
  createdAt: Timestamp;
}

export type CampaignStatus =
  | 'draft'
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'paused'
  | 'canceled';

export interface Campaign {
  id: Id;
  accountId: Id;
  name: string;
  domainId?: Id | null;
  from: Address;
  replyTo: Address[];
  subject: string;
  previewText: string;
  html: string;
  text: string;
  listIds: Id[];
  status: CampaignStatus;
  scheduledAt?: Timestamp | null;
  createdAt: Timestamp;
}

/* ------------------------------------------------------------------ webhooks */

export interface Webhook {
  id: Id;
  accountId: Id;
  url: string;
  secret: string;
  eventTypes: MessageEventType[];
  active: boolean;
  createdAt: Timestamp;
}

export interface WebhookDelivery {
  id: Id;
  accountId: Id;
  webhookId: Id;
  eventId: Id;
  status: 'pending' | 'succeeded' | 'failed';
  attempts: number;
  lastError?: string | null;
  lastAttemptAt?: Timestamp | null;
  createdAt: Timestamp;
}

/* --------------------------------------------------------------------- audit */

export interface AuditEntry {
  id: Id;
  accountId?: Id | null;
  actor: string;
  action: string;
  target: string;
  metadata: Record<string, unknown>;
  occurredAt: Timestamp;
}
