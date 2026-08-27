import type {
  Agent,
  ApiKey,
  Campaign,
  Contact,
  ContactList,
  Domain,
  Message,
  MessageEvent,
  Suppression,
  Template,
  Webhook,
} from '../types.js';

/** The public API speaks snake_case; the domain model speaks camelCase. */

export function messageJson(message: Message, options: { includeBody?: boolean } = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: message.id,
    object: 'message',
    kind: message.kind,
    direction: message.direction,
    transport: message.transport,
    status: message.status,
    from: message.from,
    to: message.to,
    cc: message.cc,
    reply_to: message.replyTo,
    subject: message.subject,
    message_id: message.rfcMessageId,
    in_reply_to: message.inReplyTo,
    references: message.references,
    thread_id: message.threadId,
    agent_id: message.agentId,
    campaign_id: message.campaignId,
    tags: message.tags,
    hops: message.hops,
    mailbox_state: message.mailboxState ?? null,
    claimed_by: message.claimedBy ?? null,
    lease_expires_at: message.leaseExpiresAt ?? null,
    delivery_attempts: message.deliveryAttempts ?? 0,
    scheduled_at: message.scheduledAt ?? null,
    error: message.error ?? null,
    created_at: message.createdAt,
  };
  if (options.includeBody !== false) {
    base.text = message.text;
    base.html = message.html;
    base.structured = message.structured ?? null;
    base.headers = message.headers;
    base.attachments = message.attachments.map((attachment) => ({
      filename: attachment.filename,
      content_type: attachment.contentType,
      size: Buffer.byteLength(attachment.content, 'base64'),
    }));
  }
  return base;
}

export function eventJson(event: MessageEvent): Record<string, unknown> {
  return {
    id: event.id,
    object: 'event',
    type: event.type,
    message_id: event.messageId,
    occurred_at: event.occurredAt,
    metadata: event.metadata,
  };
}

export function agentJson(agent: Agent): Record<string, unknown> {
  return {
    id: agent.id,
    object: 'agent',
    slug: agent.slug,
    address: agent.address,
    display_name: agent.displayName,
    description: agent.description,
    capabilities: agent.capabilities,
    inbox_policy: agent.inboxPolicy,
    allowlist: agent.allowlist,
    discoverable: agent.discoverable,
    status: agent.status,
    webhook_url: agent.webhookUrl ?? null,
    max_hops: agent.maxHops,
    max_thread_rate: agent.maxThreadRate,
    created_at: agent.createdAt,
  };
}

/** The directory is public, so it exposes only what an agent chose to publish. */
export function directoryJson(agent: Agent): Record<string, unknown> {
  return {
    address: agent.address,
    display_name: agent.displayName,
    description: agent.description,
    capabilities: agent.capabilities,
    accepts_unsolicited: agent.inboxPolicy === 'open',
  };
}

export function domainJson(domain: Domain): Record<string, unknown> {
  return {
    id: domain.id,
    object: 'domain',
    domain: domain.domain,
    status: domain.status,
    mail_from: domain.mailFromSubdomain,
    records: domain.records.map((record) => ({
      type: record.type,
      name: record.name,
      value: record.value,
      priority: record.priority ?? null,
      purpose: record.purpose,
      status: record.status,
    })),
    warnings: domain.warnings,
    verified_at: domain.verifiedAt ?? null,
    created_at: domain.createdAt,
  };
}

export function apiKeyJson(key: ApiKey, secret?: string): Record<string, unknown> {
  return {
    id: key.id,
    object: 'api_key',
    name: key.name,
    prefix: key.prefix,
    scope: key.scope,
    agent_id: key.agentId ?? null,
    domain_id: key.domainId ?? null,
    last_used_at: key.lastUsedAt ?? null,
    revoked_at: key.revokedAt ?? null,
    created_at: key.createdAt,
    // Present exactly once, on creation.
    ...(secret ? { secret } : {}),
  };
}

export function suppressionJson(entry: Suppression): Record<string, unknown> {
  return {
    id: entry.id,
    object: 'suppression',
    email: entry.email,
    reason: entry.reason,
    list_id: entry.listId ?? null,
    note: entry.note ?? null,
    created_at: entry.createdAt,
  };
}

export function templateJson(template: Template): Record<string, unknown> {
  return {
    id: template.id,
    object: 'template',
    name: template.name,
    version: template.version,
    subject: template.subject,
    html: template.html,
    text: template.text,
    created_at: template.createdAt,
  };
}

export function listJson(list: ContactList): Record<string, unknown> {
  return {
    id: list.id,
    object: 'list',
    name: list.name,
    double_optin: list.doubleOptin,
    created_at: list.createdAt,
  };
}

export function contactJson(contact: Contact): Record<string, unknown> {
  return {
    id: contact.id,
    object: 'contact',
    email: contact.email,
    name: contact.name ?? null,
    status: contact.status,
    custom_fields: contact.customFields,
    source: contact.source,
    confirmed_at: contact.confirmedAt ?? null,
    created_at: contact.createdAt,
  };
}

export function campaignJson(campaign: Campaign): Record<string, unknown> {
  return {
    id: campaign.id,
    object: 'campaign',
    name: campaign.name,
    from: campaign.from,
    reply_to: campaign.replyTo,
    subject: campaign.subject,
    preview_text: campaign.previewText,
    list_ids: campaign.listIds,
    status: campaign.status,
    scheduled_at: campaign.scheduledAt ?? null,
    created_at: campaign.createdAt,
  };
}

export function webhookJson(webhook: Webhook, includeSecret = false): Record<string, unknown> {
  return {
    id: webhook.id,
    object: 'webhook',
    url: webhook.url,
    event_types: webhook.eventTypes,
    active: webhook.active,
    created_at: webhook.createdAt,
    ...(includeSecret ? { secret: webhook.secret } : {}),
  };
}
