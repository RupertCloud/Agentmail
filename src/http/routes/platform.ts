import { requireFull, requireRead } from '../../domain/accounts.js';
import { ListService } from '../../domain/lists.js';
import { badRequest, notFound } from '../../errors.js';
import type { KeyScope, MessageEventType, SuppressionReason } from '../../types.js';
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  optionalStringArray,
  requiredString,
} from '../params.js';
import type { Router } from '../router.js';
import {
  apiKeyJson,
  campaignJson,
  contactJson,
  domainJson,
  listJson,
  suppressionJson,
  templateJson,
  webhookJson,
} from '../serialize.js';

export function registerPlatformRoutes(router: Router): void {
  /* --------------------------------------------------------------- keys */

  router.post('/v1/api-keys', async (ctx) => {
    requireFull(ctx.auth);
    const created = await ctx.platform.accounts.createApiKey(
      ctx.auth.account.id,
      requiredString(ctx.body, 'name'),
      (optionalString(ctx.body, 'scope') ?? 'send') as KeyScope,
      { agentId: optionalString(ctx.body, 'agent_id'), domainId: optionalString(ctx.body, 'domain_id') },
    );
    return { status: 201, body: apiKeyJson(created.key, created.secret) };
  });

  router.get('/v1/api-keys', async (ctx) => {
    requireFull(ctx.auth);
    const keys = await ctx.platform.store.listApiKeys(ctx.auth.account.id);
    return { status: 200, body: { data: keys.map((key) => apiKeyJson(key)) } };
  });

  router.delete('/v1/api-keys/:id', async (ctx) => {
    requireFull(ctx.auth);
    const key = await ctx.platform.store.getApiKey(ctx.params.id);
    if (!key || key.accountId !== ctx.auth.account.id) throw notFound('API key');
    await ctx.platform.accounts.revokeApiKey(key.id);
    return { status: 204 };
  });

  /* ------------------------------------------------------------ domains */

  router.post('/v1/domains', async (ctx) => {
    requireFull(ctx.auth);
    const domain = await ctx.platform.domains.add(ctx.auth.account.id, requiredString(ctx.body, 'domain'));
    return { status: 201, body: domainJson(domain) };
  });

  router.get('/v1/domains', async (ctx) => {
    requireRead(ctx.auth);
    const domains = await ctx.platform.domains.list(ctx.auth.account.id);
    return { status: 200, body: { data: domains.map(domainJson) } };
  });

  router.get('/v1/domains/:id', async (ctx) => {
    requireRead(ctx.auth);
    return { status: 200, body: domainJson(await ctx.platform.domains.get(ctx.auth.account.id, ctx.params.id)) };
  });

  router.post('/v1/domains/:id/verify', async (ctx) => {
    requireFull(ctx.auth);
    return { status: 200, body: domainJson(await ctx.platform.domains.verify(ctx.auth.account.id, ctx.params.id)) };
  });

  router.delete('/v1/domains/:id', async (ctx) => {
    requireFull(ctx.auth);
    await ctx.platform.domains.remove(ctx.auth.account.id, ctx.params.id);
    return { status: 204 };
  });

  /* -------------------------------------------------------- suppression */

  router.get('/v1/suppressions', async (ctx) => {
    requireRead(ctx.auth);
    const entries = await ctx.platform.suppression.list(ctx.auth.account.id);
    return { status: 200, body: { data: entries.map(suppressionJson) } };
  });

  router.post('/v1/suppressions', async (ctx) => {
    requireFull(ctx.auth);
    const entry = await ctx.platform.suppression.add(
      ctx.auth.account.id,
      requiredString(ctx.body, 'email'),
      (optionalString(ctx.body, 'reason') ?? 'manual') as SuppressionReason,
      { note: optionalString(ctx.body, 'note') },
    );
    return { status: 201, body: suppressionJson(entry) };
  });

  router.delete('/v1/suppressions/:id', async (ctx) => {
    requireFull(ctx.auth);
    await ctx.platform.suppression.remove(ctx.auth.account.id, ctx.params.id);
    return { status: 204 };
  });

  /* ---------------------------------------------------------- templates */

  router.post('/v1/templates', async (ctx) => {
    requireFull(ctx.auth);
    const template = await ctx.platform.templates.create(ctx.auth.account.id, {
      name: requiredString(ctx.body, 'name'),
      subject: requiredString(ctx.body, 'subject'),
      html: requiredString(ctx.body, 'html'),
      text: optionalString(ctx.body, 'text'),
    });
    return { status: 201, body: templateJson(template) };
  });

  router.get('/v1/templates', async (ctx) => {
    requireRead(ctx.auth);
    const templates = await ctx.platform.templates.list(ctx.auth.account.id);
    return { status: 200, body: { data: templates.map(templateJson) } };
  });

  router.patch('/v1/templates/:id', async (ctx) => {
    requireFull(ctx.auth);
    const template = await ctx.platform.templates.update(ctx.auth.account.id, ctx.params.id, {
      subject: optionalString(ctx.body, 'subject'),
      html: optionalString(ctx.body, 'html'),
      text: optionalString(ctx.body, 'text'),
    });
    return { status: 200, body: templateJson(template) };
  });

  router.delete('/v1/templates/:id', async (ctx) => {
    requireFull(ctx.auth);
    await ctx.platform.templates.remove(ctx.auth.account.id, ctx.params.id);
    return { status: 204 };
  });

  router.post('/v1/templates/:id/preview', async (ctx) => {
    requireRead(ctx.auth);
    const preview = await ctx.platform.templates.preview(
      ctx.auth.account.id,
      ctx.params.id,
      (ctx.body.variables as Record<string, unknown>) ?? {},
    );
    return { status: 200, body: preview };
  });

  /* ---------------------------------------------------- lists, contacts */

  router.post('/v1/lists', async (ctx) => {
    requireFull(ctx.auth);
    const list = await ctx.platform.lists.create(
      ctx.auth.account.id,
      requiredString(ctx.body, 'name'),
      optionalBoolean(ctx.body, 'double_optin') ?? false,
    );
    return { status: 201, body: listJson(list) };
  });

  router.get('/v1/lists', async (ctx) => {
    requireRead(ctx.auth);
    const lists = await ctx.platform.lists.all(ctx.auth.account.id);
    return { status: 200, body: { data: lists.map(listJson) } };
  });

  router.delete('/v1/lists/:id', async (ctx) => {
    requireFull(ctx.auth);
    await ctx.platform.lists.remove(ctx.auth.account.id, ctx.params.id);
    return { status: 204 };
  });

  router.get('/v1/lists/:id/contacts', async (ctx) => {
    requireRead(ctx.auth);
    const contacts = await ctx.platform.lists.contacts(ctx.auth.account.id, ctx.params.id);
    return { status: 200, body: { data: contacts.map(contactJson) } };
  });

  router.post('/v1/lists/:id/contacts', async (ctx) => {
    requireFull(ctx.auth);
    const contact = await ctx.platform.lists.addContact(ctx.auth.account.id, ctx.params.id, {
      email: requiredString(ctx.body, 'email'),
      name: optionalString(ctx.body, 'name'),
      ...((ctx.body.custom_fields as Record<string, unknown>) ?? {}),
    });
    return { status: 201, body: contactJson(contact) };
  });

  router.post('/v1/lists/:id/import', async (ctx) => {
    requireFull(ctx.auth);
    const csv = optionalString(ctx.body, 'csv');
    const rows = csv
      ? ListService.parseCsv(csv)
      : (ctx.body.contacts as Array<{ email: string }> | undefined);
    if (!rows) throw badRequest('Provide `csv` or `contacts`.', 'csv');
    const report = await ctx.platform.lists.import(ctx.auth.account.id, ctx.params.id, rows);
    return { status: 200, body: report };
  });

  /* ---------------------------------------------------------- campaigns */

  router.post('/v1/campaigns', async (ctx) => {
    requireFull(ctx.auth);
    const campaign = await ctx.platform.campaigns.create(ctx.auth.account.id, {
      name: requiredString(ctx.body, 'name'),
      from: requiredString(ctx.body, 'from'),
      replyTo: optionalStringArray(ctx.body, 'reply_to'),
      subject: requiredString(ctx.body, 'subject'),
      previewText: optionalString(ctx.body, 'preview_text'),
      html: requiredString(ctx.body, 'html'),
      text: optionalString(ctx.body, 'text'),
      listIds: optionalStringArray(ctx.body, 'list_ids') ?? [],
      scheduledAt: optionalString(ctx.body, 'scheduled_at'),
    });
    return { status: 201, body: campaignJson(campaign) };
  });

  router.get('/v1/campaigns', async (ctx) => {
    requireRead(ctx.auth);
    const campaigns = await ctx.platform.campaigns.list(ctx.auth.account.id);
    return { status: 200, body: { data: campaigns.map(campaignJson) } };
  });

  router.get('/v1/campaigns/:id', async (ctx) => {
    requireRead(ctx.auth);
    const campaign = await ctx.platform.campaigns.get(ctx.auth.account.id, ctx.params.id);
    const recipients = await ctx.platform.campaigns.recipients(ctx.auth.account.id, campaign);
    return { status: 200, body: { ...campaignJson(campaign), recipient_count: recipients.length } };
  });

  router.post('/v1/campaigns/:id/send', async (ctx) => {
    requireFull(ctx.auth);
    const result = await ctx.platform.campaigns.send(ctx.auth.account, ctx.params.id);
    return { status: 202, body: result };
  });

  router.post('/v1/campaigns/:id/test', async (ctx) => {
    requireFull(ctx.auth);
    const addresses = optionalStringArray(ctx.body, 'to') ?? [];
    const count = await ctx.platform.campaigns.testSend(ctx.auth.account, ctx.params.id, addresses);
    return { status: 202, body: { sent: count } };
  });

  router.post('/v1/campaigns/:id/cancel', async (ctx) => {
    requireFull(ctx.auth);
    return { status: 200, body: campaignJson(await ctx.platform.campaigns.cancel(ctx.auth.account.id, ctx.params.id)) };
  });

  router.get('/v1/campaigns/:id/stats', async (ctx) => {
    requireRead(ctx.auth);
    return { status: 200, body: await ctx.platform.campaigns.stats(ctx.auth.account.id, ctx.params.id) };
  });

  /* ----------------------------------------------------------- webhooks */

  router.post('/v1/webhooks', async (ctx) => {
    requireFull(ctx.auth);
    const webhook = await ctx.platform.webhooks.create(
      ctx.auth.account.id,
      requiredString(ctx.body, 'url'),
      (optionalStringArray(ctx.body, 'event_types') ?? ['delivered', 'bounced', 'complained', 'received']) as MessageEventType[],
    );
    return { status: 201, body: webhookJson(webhook, true) };
  });

  router.get('/v1/webhooks', async (ctx) => {
    requireFull(ctx.auth);
    const webhooks = await ctx.platform.webhooks.list(ctx.auth.account.id);
    return { status: 200, body: { data: webhooks.map((webhook) => webhookJson(webhook)) } };
  });

  router.delete('/v1/webhooks/:id', async (ctx) => {
    requireFull(ctx.auth);
    await ctx.platform.webhooks.remove(ctx.auth.account.id, ctx.params.id);
    return { status: 204 };
  });

  router.get('/v1/webhooks/:id/deliveries', async (ctx) => {
    requireFull(ctx.auth);
    const deliveries = await ctx.platform.webhooks.deliveries(ctx.auth.account.id, ctx.params.id);
    return {
      status: 200,
      body: {
        data: deliveries.map((delivery) => ({
          id: delivery.id,
          status: delivery.status,
          attempts: delivery.attempts,
          last_error: delivery.lastError ?? null,
          last_attempt_at: delivery.lastAttemptAt ?? null,
          created_at: delivery.createdAt,
        })),
      },
    };
  });

  /* ------------------------------------------------------------ account */

  router.get('/v1/account/usage', async (ctx) => {
    requireRead(ctx.auth);
    const account = ctx.auth.account;
    const since = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').toISOString();
    const sentToday = await ctx.platform.store.countSentSince(account.id, since);
    const agents = await ctx.platform.agents.list(account.id);
    return {
      status: 200,
      body: {
        account_id: account.id,
        slug: account.slug,
        status: account.status,
        plan: account.plan,
        agent_domain: `${account.slug}.${ctx.platform.config.agentDomain}`,
        agents: agents.length,
        sent_today: sentToday,
        daily_send_limit: account.dailySendLimit,
        queue_depth: {
          transactional: ctx.platform.queues.transactional.depth(),
          campaign: ctx.platform.queues.campaign.depth(),
        },
      },
    };
  });

  router.get('/v1/audit', async (ctx) => {
    requireFull(ctx.auth);
    const entries = await ctx.platform.store.listAudit(
      ctx.auth.account.id,
      optionalNumber({ limit: Number(ctx.query.get('limit') ?? 100) }, 'limit'),
    );
    return { status: 200, body: { data: entries } };
  });
}
