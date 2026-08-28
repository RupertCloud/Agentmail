import { requireAgentAccess, requireFull, requireRead, requireSend } from '../../domain/accounts.js';
import { badRequest } from '../../errors.js';
import type { Agent, InboxPolicy, MailboxState } from '../../types.js';
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  optionalStringArray,
  requiredString,
} from '../params.js';
import type { RequestContext, Router } from '../router.js';
import { agentJson, apiKeyJson, directoryJson, messageJson } from '../serialize.js';

/**
 * Resolves the agent a request is about, enforcing that an agent-scoped key
 * can only ever reach its own mailbox.
 */
async function resolveAgent(ctx: RequestContext): Promise<Agent> {
  const id = ctx.params.id === 'me' && ctx.auth.agent ? ctx.auth.agent.id : ctx.params.id;
  requireAgentAccess(ctx.auth, id);
  return ctx.platform.agents.get(ctx.auth.account.id, id);
}

export function registerAgentRoutes(router: Router): void {
  router.post('/v1/agents', async (ctx) => {
    requireFull(ctx.auth);
    const agent = await ctx.platform.agents.create(ctx.auth.account, {
      slug: optionalString(ctx.body, 'slug'),
      displayName: requiredString(ctx.body, 'display_name'),
      description: optionalString(ctx.body, 'description'),
      capabilities: optionalStringArray(ctx.body, 'capabilities'),
      inboxPolicy: optionalString(ctx.body, 'inbox_policy') as InboxPolicy | undefined,
      allowlist: optionalStringArray(ctx.body, 'allowlist'),
      discoverable: optionalBoolean(ctx.body, 'discoverable'),
      webhookUrl: optionalString(ctx.body, 'webhook_url'),
      maxHops: optionalNumber(ctx.body, 'max_hops'),
      maxThreadRate: optionalNumber(ctx.body, 'max_thread_rate'),
      address: optionalString(ctx.body, 'address'),
    });
    return { status: 201, body: agentJson(agent) };
  });

  router.get('/v1/agents', async (ctx) => {
    requireRead(ctx.auth);
    const agents = await ctx.platform.agents.list(ctx.auth.account.id);
    const visible = ctx.auth.agent ? agents.filter((agent) => agent.id === ctx.auth.agent!.id) : agents;
    return { status: 200, body: { data: visible.map(agentJson) } };
  });

  router.get('/v1/agents/:id', async (ctx) => {
    requireRead(ctx.auth);
    return { status: 200, body: agentJson(await resolveAgent(ctx)) };
  });

  router.patch('/v1/agents/:id', async (ctx) => {
    requireFull(ctx.auth);
    const agent = await resolveAgent(ctx);
    const updated = await ctx.platform.agents.update(ctx.auth.account.id, agent.id, {
      displayName: optionalString(ctx.body, 'display_name'),
      description: optionalString(ctx.body, 'description'),
      capabilities: optionalStringArray(ctx.body, 'capabilities'),
      inboxPolicy: optionalString(ctx.body, 'inbox_policy') as InboxPolicy | undefined,
      allowlist: optionalStringArray(ctx.body, 'allowlist'),
      discoverable: optionalBoolean(ctx.body, 'discoverable'),
      status: optionalString(ctx.body, 'status') as 'active' | 'paused' | undefined,
      webhookUrl: optionalString(ctx.body, 'webhook_url'),
      maxHops: optionalNumber(ctx.body, 'max_hops'),
      maxThreadRate: optionalNumber(ctx.body, 'max_thread_rate'),
    });
    return { status: 200, body: agentJson(updated) };
  });

  router.delete('/v1/agents/:id', async (ctx) => {
    requireFull(ctx.auth);
    const agent = await resolveAgent(ctx);
    await ctx.platform.agents.remove(ctx.auth.account.id, agent.id);
    return { status: 204 };
  });

  /** Mints a credential that can reach exactly one mailbox and nothing else. */
  router.post('/v1/agents/:id/keys', async (ctx) => {
    requireFull(ctx.auth);
    const agent = await resolveAgent(ctx);
    const created = await ctx.platform.accounts.createApiKey(
      ctx.auth.account.id,
      optionalString(ctx.body, 'name') ?? `${agent.slug}-key`,
      'agent',
      { agentId: agent.id },
    );
    return { status: 201, body: apiKeyJson(created.key, created.secret) };
  });

  /* ------------------------------------------------------------- mailbox */

  router.get('/v1/agents/:id/messages', async (ctx) => {
    requireRead(ctx.auth);
    const agent = await resolveAgent(ctx);
    const messages = await ctx.platform.mailbox.list(agent, {
      mailboxState: (ctx.query.get('state') as MailboxState) ?? undefined,
      threadId: ctx.query.get('thread_id') ?? undefined,
      direction: (ctx.query.get('direction') as 'inbound' | 'outbound') ?? undefined,
      limit: Number(ctx.query.get('limit') ?? 25),
    });
    return { status: 200, body: { data: messages.map((message) => messageJson(message)) } };
  });

  router.post('/v1/agents/:id/messages/claim', async (ctx) => {
    requireRead(ctx.auth);
    const agent = await resolveAgent(ctx);
    const claimed = await ctx.platform.mailbox.claim(agent, {
      max: optionalNumber(ctx.body, 'max'),
      leaseSeconds: optionalNumber(ctx.body, 'lease_seconds'),
      worker: optionalString(ctx.body, 'worker'),
    });
    return { status: 200, body: { data: claimed.map((message) => messageJson(message)) } };
  });

  /**
   * Long poll. `wait=30&claim=true` is the loop an agent runs: it blocks until
   * work arrives, takes a lease on it, and returns.
   */
  router.get('/v1/agents/:id/messages/wait', async (ctx) => {
    requireRead(ctx.auth);
    const agent = await resolveAgent(ctx);
    const controller = new AbortController();
    ctx.req.on('close', () => controller.abort());

    const messages = await ctx.platform.mailbox.wait(agent, {
      timeoutSeconds: Number(ctx.query.get('wait') ?? 25),
      claim: ctx.query.get('claim') === 'true',
      max: Number(ctx.query.get('max') ?? 1),
      leaseSeconds: Number(ctx.query.get('lease_seconds') ?? 0) || undefined,
      worker: ctx.query.get('worker') ?? undefined,
      signal: controller.signal,
    });
    return { status: 200, body: { data: messages.map((message) => messageJson(message)) } };
  });

  router.get('/v1/agents/:id/messages/:messageId', async (ctx) => {
    requireRead(ctx.auth);
    const agent = await resolveAgent(ctx);
    const message = await ctx.platform.mailbox.get(agent, ctx.params.messageId);
    return { status: 200, body: messageJson(message) };
  });

  router.post('/v1/agents/:id/messages/:messageId/ack', async (ctx) => {
    requireRead(ctx.auth);
    const agent = await resolveAgent(ctx);
    const message = await ctx.platform.mailbox.ack(agent, ctx.params.messageId);
    return { status: 200, body: messageJson(message, { includeBody: false }) };
  });

  router.post('/v1/agents/:id/messages/:messageId/release', async (ctx) => {
    requireRead(ctx.auth);
    const agent = await resolveAgent(ctx);
    const message = await ctx.platform.mailbox.release(agent, ctx.params.messageId);
    return { status: 200, body: messageJson(message, { includeBody: false }) };
  });

  router.post('/v1/agents/:id/messages/:messageId/archive', async (ctx) => {
    requireRead(ctx.auth);
    const agent = await resolveAgent(ctx);
    const message = await ctx.platform.mailbox.setState(agent, ctx.params.messageId, 'archived');
    return { status: 200, body: messageJson(message, { includeBody: false }) };
  });

  /** Reply in-thread without the caller reconstructing headers itself. */
  router.post('/v1/agents/:id/messages/:messageId/reply', async (ctx) => {
    requireSend(ctx.auth);
    const agent = await resolveAgent(ctx);
    const original = await ctx.platform.mailbox.get(agent, ctx.params.messageId);
    const to = original.replyTo.length ? original.replyTo : [original.from];
    if (!to.length) throw badRequest('The original message has no reply address.');

    const result = await ctx.platform.sending.send(
      ctx.auth.account,
      {
        to: to.map((address) => address.email),
        subject: optionalString(ctx.body, 'subject') ?? replySubject(original.subject),
        text: optionalString(ctx.body, 'text'),
        html: optionalString(ctx.body, 'html'),
        structured: ctx.body.structured,
        inReplyTo: original.rfcMessageId,
      },
      agent,
      { domainId: ctx.auth.key.domainId },
    );
    return { status: 202, body: messageJson(result.message, { includeBody: false }) };
  });

  router.get('/v1/agents/:id/threads/:threadId', async (ctx) => {
    requireRead(ctx.auth);
    const agent = await resolveAgent(ctx);
    const messages = await ctx.platform.mailbox.thread(agent, ctx.params.threadId);
    return {
      status: 200,
      body: { thread_id: ctx.params.threadId, data: messages.map((message) => messageJson(message)) },
    };
  });

  /* ----------------------------------------------------------- directory */

  router.get('/v1/directory', async (ctx) => {
    requireRead(ctx.auth);
    const agents = await ctx.platform.agents.directory({
      query: ctx.query.get('q') ?? undefined,
      capability: ctx.query.get('capability') ?? undefined,
      limit: Number(ctx.query.get('limit') ?? 25),
    });
    return { status: 200, body: { data: agents.map(directoryJson) } };
  });
}

function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}
