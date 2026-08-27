import { timingSafeEqual } from 'node:crypto';
import { verifyUnsubscribe } from '../../domain/unsubscribe.js';
import { ApiError, badRequest, forbidden } from '../../errors.js';
import { ACCP_VERSION } from '../../util/mime.js';
import type { RequestContext, Router } from '../router.js';

function assertIngestSecret(ctx: RequestContext): void {
  // Fail closed rather than accept a secret anyone can read in the repository.
  // Injecting inbound mail into an arbitrary mailbox is not something to leave
  // open because a deployment forgot an environment variable.
  if (ctx.platform.config.secretIsDefault) {
    throw new ApiError(
      503,
      'not_configured',
      'Ingest is disabled because AGENTMAIL_SECRET is unset and the published default is in use. ' +
        'Set AGENTMAIL_SECRET to enable it.',
    );
  }
  const provided = ctx.headers['x-agentmail-ingest-secret'];
  const expected = ctx.platform.config.secret;
  if (typeof provided !== 'string' || provided.length !== expected.length) {
    throw forbidden('Missing or invalid ingest secret.');
  }
  if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    throw forbidden('Missing or invalid ingest secret.');
  }
}

export function registerPublicRoutes(router: Router): void {
  router.get('/', async (ctx) => ({
    status: 200,
    body: {
      name: 'agentmail',
      description: 'Email for AI agents, and the humans they work with.',
      protocol: { name: 'ACCP', version: ACCP_VERSION, spec: 'docs/accp/SPEC.md' },
      agent_domain: ctx.platform.config.agentDomain,
      docs: {
        api: 'docs/api.md',
        agents: 'docs/agents.md',
        protocol: 'docs/accp/SPEC.md',
      },
      endpoints: { health: '/health', api: '/v1' },
    },
  }), false);

  router.get('/health', async (ctx) => ({
    status: 200,
    body: {
      status: 'ok',
      provider: ctx.platform.provider.name,
      store: ctx.platform.config.store,
      queue_depth: {
        transactional: ctx.platform.queues.transactional.depth(),
        campaign: ctx.platform.queues.campaign.depth(),
      },
      dead_letters:
        ctx.platform.queues.transactional.deadLetters().length +
        ctx.platform.queues.campaign.deadLetters().length,
      warnings: deploymentWarnings(ctx),
    },
  }), false);

  /**
   * Mail arriving from the outside world, posted by the receiving
   * infrastructure (an SES receipt rule via SNS in production).
   */
  router.post('/ingest/inbound', async (ctx) => {
    assertIngestSecret(ctx);
    const raw = ctx.body.raw;
    if (typeof raw !== 'string') throw badRequest('`raw` must be the RFC 5322 message.', 'raw');
    const recipients = Array.isArray(ctx.body.recipients) ? (ctx.body.recipients as string[]) : [];
    if (!recipients.length) throw badRequest('`recipients` is required.', 'recipients');

    const result = await ctx.platform.inbound.ingest({
      raw,
      recipients,
      verdicts: (ctx.body.verdicts as never) ?? undefined,
    });
    return {
      status: 200,
      body: {
        delivered: result.delivered.map((message) => ({
          id: message.id,
          agent_id: message.agentId,
          thread_id: message.threadId,
        })),
        rejected: result.rejected,
      },
    };
  }, false);

  /** Provider delivery notifications: SES events via SNS (SRS §3.4). */
  router.post('/ingest/events', async (ctx) => {
    assertIngestSecret(ctx);
    const notifications = Array.isArray(ctx.body.events) ? ctx.body.events : [ctx.body];
    for (const notification of notifications) {
      await ctx.platform.delivery.ingestProviderEvent(notification as never);
    }
    return { status: 200, body: { received: notifications.length } };
  }, false);

  /** One-click unsubscribe target for `List-Unsubscribe-Post` (FR-8.7). */
  const unsubscribe = async (ctx: RequestContext) => {
    const claim = verifyUnsubscribe(ctx.platform.config.secret, ctx.params.token);
    if (!claim) throw badRequest('That unsubscribe link is not valid.', 'token');

    await ctx.platform.suppression.add(claim.accountId, claim.email, 'unsubscribe', {
      listId: claim.listId,
      note: 'one-click unsubscribe',
    });
    if (claim.listId) {
      await ctx.platform.store
        .findContact(claim.listId, claim.email)
        .then((contact) =>
          contact ? ctx.platform.store.updateContact(contact.id, { status: 'unsubscribed' }) : null,
        )
        .catch(() => null);
    }
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: `<!doctype html><meta charset="utf-8"><title>Unsubscribed</title>
<p>${escapeHtml(claim.email)} has been unsubscribed. No further messages will be sent to this address.</p>`,
    };
  };

  router.get('/u/:token', unsubscribe, false);
  router.post('/u/:token', unsubscribe, false);
}

/** Surfaced on /health so a misconfigured deployment is visible, not guessed at. */
function deploymentWarnings(ctx: RequestContext): string[] {
  const warnings: string[] = [];
  const config = ctx.platform.config;
  if (config.secretIsDefault) {
    warnings.push('AGENTMAIL_SECRET is unset; inbound and event ingest are disabled.');
  }
  if (config.store === 'memory') {
    warnings.push('Store is in-memory: all accounts, mailboxes and messages are lost on restart.');
  }
  if (ctx.platform.provider.name === 'memory') {
    warnings.push('Provider is in-memory: accepted messages are recorded but never sent.');
  }
  return warnings;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );
}
