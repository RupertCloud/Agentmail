import { requireRead, requireSend } from '../../domain/accounts.js';
import type { SendEmailInput } from '../../domain/sending.js';
import { badRequest, notFound } from '../../errors.js';
import type { Attachment } from '../../types.js';
import { optionalNumber, optionalObject, optionalString, optionalStringArray } from '../params.js';
import type { Router } from '../router.js';
import { eventJson, messageJson } from '../serialize.js';

/** Maps a public snake_case send payload onto the internal input. */
export function toSendInput(body: Record<string, unknown>): SendEmailInput {
  const attachments = (body.attachments as Attachment[] | undefined)?.map((attachment) => ({
    filename: String((attachment as unknown as Record<string, unknown>).filename ?? 'attachment'),
    contentType: String(
      (attachment as unknown as Record<string, unknown>).content_type ??
        (attachment as unknown as Record<string, unknown>).contentType ??
        'application/octet-stream',
    ),
    content: String((attachment as unknown as Record<string, unknown>).content ?? ''),
  }));

  return {
    from: optionalString(body, 'from'),
    to: optionalStringArray(body, 'to') ?? [],
    cc: optionalStringArray(body, 'cc'),
    bcc: optionalStringArray(body, 'bcc'),
    replyTo: optionalStringArray(body, 'reply_to'),
    subject: optionalString(body, 'subject'),
    html: optionalString(body, 'html') ?? null,
    text: optionalString(body, 'text') ?? null,
    headers: optionalObject(body, 'headers') as Record<string, string> | undefined,
    attachments,
    structured: body.structured,
    templateId: optionalString(body, 'template_id'),
    variables: optionalObject(body, 'variables'),
    tags: optionalObject(body, 'tags') as Record<string, string> | undefined,
    agentId: optionalString(body, 'agent_id'),
    inReplyTo: optionalString(body, 'in_reply_to'),
    scheduledAt: optionalString(body, 'scheduled_at'),
  };
}

/** `?tag=order` matches any message carrying the tag; `?tag=order:4711` pins the value. */
function parseTagFilter(raw: string | null): { tagKey?: string; tagValue?: string } {
  if (!raw) return {};
  const separator = raw.indexOf(':');
  if (separator === -1) return { tagKey: raw };
  return { tagKey: raw.slice(0, separator), tagValue: raw.slice(separator + 1) };
}

export function registerEmailRoutes(router: Router): void {
  router.post('/v1/emails', async (ctx) => {
    requireSend(ctx.auth);
    const input = toSendInput(ctx.body);
    const idempotencyKey = ctx.headers['idempotency-key'];
    if (typeof idempotencyKey === 'string') input.idempotencyKey = idempotencyKey;

    const result = await ctx.platform.sending.send(ctx.auth.account, input, ctx.auth.agent, {
      domainId: ctx.auth.key.domainId,
    });
    return {
      status: 202,
      body: {
        ...messageJson(result.message, { includeBody: false }),
        skipped_recipients: result.skipped,
        internal_deliveries: result.internal.map((message) => message.id),
      },
    };
  });

  router.post('/v1/emails/batch', async (ctx) => {
    requireSend(ctx.auth);
    const items = ctx.body.emails;
    if (!Array.isArray(items)) throw badRequest('`emails` must be an array.', 'emails');
    if (items.length > 100) throw badRequest('A batch takes at most 100 messages.', 'emails');

    const results = [];
    for (const item of items) {
      const result = await ctx.platform.sending.send(
        ctx.auth.account,
        toSendInput(item as Record<string, unknown>),
        ctx.auth.agent,
        { domainId: ctx.auth.key.domainId },
      );
      results.push(messageJson(result.message, { includeBody: false }));
    }
    return { status: 202, body: { data: results } };
  });

  router.get('/v1/emails', async (ctx) => {
    requireRead(ctx.auth);
    const page = await ctx.platform.store.listMessages({
      accountId: ctx.auth.account.id,
      agentId: ctx.auth.agent?.id,
      direction: (ctx.query.get('direction') as 'inbound' | 'outbound') ?? undefined,
      status: (ctx.query.get('status') as never) ?? undefined,
      kind: (ctx.query.get('kind') as never) ?? undefined,
      threadId: ctx.query.get('thread_id') ?? undefined,
      recipient: ctx.query.get('to') ?? undefined,
      query: ctx.query.get('q') ?? undefined,
      ...parseTagFilter(ctx.query.get('tag')),
      since: ctx.query.get('since') ?? undefined,
      until: ctx.query.get('until') ?? undefined,
      limit: optionalNumber({ limit: Number(ctx.query.get('limit') ?? 50) }, 'limit'),
      cursor: ctx.query.get('cursor'),
    });
    return {
      status: 200,
      body: {
        data: page.data.map((message) => messageJson(message, { includeBody: false })),
        next_cursor: page.nextCursor,
      },
    };
  });

  router.get('/v1/emails/:id', async (ctx) => {
    requireRead(ctx.auth);
    const message = await ctx.platform.store.getMessage(ctx.params.id);
    if (!message || message.accountId !== ctx.auth.account.id) throw notFound('Message');
    if (ctx.auth.agent && message.agentId !== ctx.auth.agent.id) throw notFound('Message');
    const events = await ctx.platform.events.history(message.id);
    return { status: 200, body: { ...messageJson(message), events: events.map(eventJson) } };
  });
}
