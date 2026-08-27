import type { Config } from '../config.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { Store } from '../store/types.js';
import type { Account, Address, Campaign, Id, MessageEventType } from '../types.js';
import { htmlToText, parseAddress, parseAddressList } from '../util/email.js';
import { newId } from '../util/ids.js';
import type { ListService } from './lists.js';
import type { SendService } from './sending.js';
import type { SuppressionService } from './suppression.js';
import { signUnsubscribe } from './unsubscribe.js';

export interface CampaignInput {
  name: string;
  from: string | Address;
  replyTo?: string | string[];
  subject: string;
  previewText?: string;
  html: string;
  text?: string;
  listIds: Id[];
  scheduledAt?: string;
}

export interface CampaignStats {
  recipients: number;
  counts: Record<string, number>;
  rates: { delivered: number; bounced: number; complained: number; opened: number; clicked: number };
}

export class CampaignService {
  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly lists: ListService,
    private readonly suppression: SuppressionService,
    private readonly sender: SendService,
  ) {}

  async create(accountId: Id, input: CampaignInput): Promise<Campaign> {
    if (!input.listIds?.length) throw badRequest('A campaign needs at least one list.', 'list_ids');
    for (const listId of input.listIds) await this.lists.get(accountId, listId);

    return this.store.createCampaign({
      id: newId('cmp'),
      accountId,
      name: input.name,
      domainId: null,
      from: typeof input.from === 'string' ? parseAddress(input.from) : input.from,
      replyTo: parseAddressList(input.replyTo),
      subject: input.subject,
      previewText: input.previewText ?? '',
      html: input.html,
      text: input.text ?? htmlToText(input.html),
      listIds: input.listIds,
      status: input.scheduledAt ? 'scheduled' : 'draft',
      scheduledAt: input.scheduledAt ?? null,
      createdAt: new Date().toISOString(),
    });
  }

  async get(accountId: Id, id: Id): Promise<Campaign> {
    const campaign = await this.store.getCampaign(id);
    if (!campaign || campaign.accountId !== accountId) throw notFound('Campaign');
    return campaign;
  }

  async list(accountId: Id): Promise<Campaign[]> {
    return this.store.listCampaigns(accountId);
  }

  /**
   * Deduplicated, subscribed, unsuppressed recipients. Exposed on its own so
   * the dashboard can show an accurate count before anything is sent (FR-8.4).
   */
  async recipients(accountId: Id, campaign: Campaign): Promise<Array<{ email: string; name: string | null; listId: Id; fields: Record<string, unknown> }>> {
    const seen = new Set<string>();
    const out: Array<{ email: string; name: string | null; listId: Id; fields: Record<string, unknown> }> = [];

    for (const listId of campaign.listIds) {
      for (const contact of await this.lists.contacts(accountId, listId)) {
        if (contact.status !== 'subscribed') continue;
        if (seen.has(contact.email)) continue;
        if (await this.suppression.isSuppressed(accountId, contact.email)) continue;
        seen.add(contact.email);
        out.push({ email: contact.email, name: contact.name ?? null, listId, fields: contact.customFields });
      }
    }

    return out;
  }

  async testSend(account: Account, id: Id, addresses: string[]): Promise<number> {
    if (addresses.length > 5) throw badRequest('A test send takes at most five addresses.', 'to');
    const campaign = await this.get(account.id, id);
    for (const address of addresses) {
      await this.sender.send(account, {
        from: campaign.from,
        to: address,
        replyTo: campaign.replyTo.map((entry) => entry.email),
        subject: `[test] ${campaign.subject}`,
        html: campaign.html,
        text: campaign.text,
        kind: 'transactional',
        tags: { campaign_test: campaign.id },
      });
    }
    return addresses.length;
  }

  /**
   * Fans the campaign out one message per recipient onto the low-priority
   * campaign queue, so a large broadcast never sits in front of a password
   * reset (SRS §3.3, FR-8.10).
   */
  async send(account: Account, id: Id): Promise<{ queued: number }> {
    const campaign = await this.get(account.id, id);
    if (campaign.status === 'sending' || campaign.status === 'sent') {
      throw conflict(`Campaign is already ${campaign.status}.`);
    }
    await this.store.updateCampaign(id, { status: 'sending' });

    const recipients = await this.recipients(account.id, campaign);
    let queued = 0;

    for (const recipient of recipients) {
      const current = await this.store.getCampaign(id);
      if (current?.status === 'canceled' || current?.status === 'paused') break;

      const token = signUnsubscribe(this.config.secret, {
        accountId: account.id,
        listId: recipient.listId,
        email: recipient.email,
      });
      const unsubscribeUrl = `${this.config.publicUrl}/u/${token}`;

      await this.sender.send(account, {
        from: campaign.from,
        to: recipient.email,
        replyTo: campaign.replyTo.map((entry) => entry.email),
        subject: campaign.subject,
        html: withUnsubscribeFooter(campaign.html, unsubscribeUrl),
        text: `${campaign.text}\n\nUnsubscribe: ${unsubscribeUrl}`,
        kind: 'campaign',
        campaignId: campaign.id,
        tags: { campaign_id: campaign.id },
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>, <mailto:unsubscribe@${this.config.platformDomain}?subject=${campaign.id}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        idempotencyKey: `campaign:${campaign.id}:${recipient.email}`,
      });
      queued += 1;
    }

    const final = await this.store.getCampaign(id);
    if (final?.status === 'sending') await this.store.updateCampaign(id, { status: 'sent' });
    return { queued };
  }

  async cancel(accountId: Id, id: Id): Promise<Campaign> {
    await this.get(accountId, id);
    return this.store.updateCampaign(id, { status: 'canceled' });
  }

  async pause(accountId: Id, id: Id): Promise<Campaign> {
    await this.get(accountId, id);
    return this.store.updateCampaign(id, { status: 'paused' });
  }

  async stats(accountId: Id, id: Id): Promise<CampaignStats> {
    const campaign = await this.get(accountId, id);
    const page = await this.store.listMessages({ accountId, campaignId: campaign.id, limit: 200 });
    const counts: Record<string, number> = {};

    for (const message of page.data) {
      for (const event of await this.store.listEvents(message.id)) {
        counts[event.type] = (counts[event.type] ?? 0) + 1;
      }
    }

    const sent = counts.sent ?? page.data.length;
    const rate = (type: MessageEventType) => (sent ? Number((((counts[type] ?? 0) / sent) * 100).toFixed(2)) : 0);

    return {
      recipients: page.data.length,
      counts,
      rates: {
        delivered: rate('delivered'),
        bounced: rate('bounced'),
        complained: rate('complained'),
        opened: rate('opened'),
        clicked: rate('clicked'),
      },
    };
  }
}

function withUnsubscribeFooter(html: string, url: string): string {
  const footer = `<p style="font-size:12px;color:#666;margin-top:32px">
  <a href="${url}">Unsubscribe</a>
</p>`;
  return html.includes('</body>') ? html.replace('</body>', `${footer}</body>`) : `${html}${footer}`;
}
