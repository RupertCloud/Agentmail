import assert from 'node:assert/strict';
import test from 'node:test';
import { api, newHarness, seedAccount, seedAgent, startServer } from './helpers.js';

test('the API sends, lists and reads a transactional message', async (t) => {
  const { platform, provider } = newHarness();
  const { account, apiKey } = await seedAccount(platform, 'acme', 'acme.test');
  const server = await startServer(platform);
  t.after(async () => {
    await server.close();
    await platform.close();
  });

  const sent = await api(server.baseUrl, apiKey, 'POST', '/v1/emails', {
    from: 'receipts@acme.test',
    to: ['customer@example.test'],
    subject: 'Your receipt',
    html: '<p>Thanks for your order.</p>',
    tags: { order: '1234' },
  });
  assert.equal(sent.status, 202);
  assert.equal(sent.json.status, 'queued');

  await platform.drain();
  assert.equal(provider.sent.length, 1);
  assert.match(provider.sent[0].raw, /Subject: Your receipt/);
  assert.equal(provider.sent[0].tenantName, account.tenantName);

  const read = await api(server.baseUrl, apiKey, 'GET', `/v1/emails/${sent.json.id}`);
  assert.equal(read.status, 200);
  assert.equal(read.json.status, 'sent');
  assert.equal(read.json.text.trim(), 'Thanks for your order.');
  assert.deepEqual(
    read.json.events.map((event: { type: string }) => event.type),
    ['accepted', 'queued', 'sent'],
  );

  const list = await api(server.baseUrl, apiKey, 'GET', '/v1/emails?limit=10');
  assert.equal(list.json.data.length, 1);
});

test('sending from an unverified domain is refused', async (t) => {
  const { platform } = newHarness();
  const { apiKey } = await seedAccount(platform, 'acme');
  const server = await startServer(platform);
  t.after(async () => {
    await server.close();
    await platform.close();
  });

  await api(server.baseUrl, apiKey, 'POST', '/v1/domains', { domain: 'unverified.test' });
  const response = await api(server.baseUrl, apiKey, 'POST', '/v1/emails', {
    from: 'hello@unverified.test',
    to: ['someone@example.test'],
    subject: 'Nope',
    text: 'nope',
  });
  assert.equal(response.status, 403);
  assert.match(response.json.error.message, /not verified/);
});

test('an agent key reaches its own mailbox and nothing else', async (t) => {
  const { platform } = newHarness();
  const { account, apiKey } = await seedAccount(platform, 'acme');
  const { agent: alice, apiKey: aliceKey } = await seedAgent(platform, account, 'alice');
  const { agent: bob } = await seedAgent(platform, account, 'bob');
  const server = await startServer(platform);
  t.after(async () => {
    await server.close();
    await platform.close();
  });

  const me = await api(server.baseUrl, aliceKey, 'GET', '/v1/agents/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.address, alice.address);

  const forbidden = await api(server.baseUrl, aliceKey, 'GET', `/v1/agents/${bob.id}/messages`);
  assert.equal(forbidden.status, 403);

  // Alice cannot mint keys or manage the account either.
  const escalation = await api(server.baseUrl, aliceKey, 'POST', '/v1/api-keys', {
    name: 'oops',
    scope: 'full',
  });
  assert.equal(escalation.status, 403);

  // The full key still can.
  const allowed = await api(server.baseUrl, apiKey, 'GET', `/v1/agents/${bob.id}/messages`);
  assert.equal(allowed.status, 200);
});

test('two agents exchange work over the API: send, wait, reply, ack', async (t) => {
  const { platform, provider } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent: buyer, apiKey: buyerKey } = await seedAgent(platform, account, 'buyer');
  const { agent: seller, apiKey: sellerKey } = await seedAgent(platform, account, 'seller');
  const server = await startServer(platform);
  t.after(async () => {
    await server.close();
    await platform.close();
  });

  const waiting = api(
    server.baseUrl,
    sellerKey,
    'GET',
    '/v1/agents/me/messages/wait?wait=5&claim=true',
  );

  const sent = await api(server.baseUrl, buyerKey, 'POST', '/v1/emails', {
    to: [seller.address],
    subject: 'Quote request',
    structured: { sku: 'WIDGET-1', quantity: 40 },
  });
  assert.equal(sent.status, 202);
  assert.equal(sent.json.transport, 'internal');

  const arrived = await waiting;
  assert.equal(arrived.json.data.length, 1);
  const inbound = arrived.json.data[0];
  assert.deepEqual(inbound.structured, { sku: 'WIDGET-1', quantity: 40 });
  assert.equal(inbound.mailbox_state, 'claimed');

  const reply = await api(
    server.baseUrl,
    sellerKey,
    'POST',
    `/v1/agents/me/messages/${inbound.id}/reply`,
    { structured: { unit_price: 12, currency: 'UGX' }, text: '40 units at 12 each.' },
  );
  assert.equal(reply.status, 202);
  assert.equal(reply.json.thread_id, inbound.thread_id);

  const acked = await api(server.baseUrl, sellerKey, 'POST', `/v1/agents/me/messages/${inbound.id}/ack`);
  assert.equal(acked.json.mailbox_state, 'acked');

  const buyerInbox = await api(server.baseUrl, buyerKey, 'GET', '/v1/agents/me/messages');
  assert.equal(buyerInbox.json.data.length, 1);
  assert.deepEqual(buyerInbox.json.data[0].structured, { unit_price: 12, currency: 'UGX' });

  assert.equal(provider.sent.length, 0, 'the whole exchange stayed inside the platform');
  assert.equal(buyer.accountId, account.id);
});

test('the directory lists only agents that opted in', async (t) => {
  const { platform } = newHarness();
  const { account, apiKey } = await seedAccount(platform, 'acme');
  await seedAgent(platform, account, 'public-bot', {
    discoverable: true,
    capabilities: ['invoice.parse'],
    description: 'Parses invoices',
  });
  await seedAgent(platform, account, 'private-bot', { discoverable: false });
  const server = await startServer(platform);
  t.after(async () => {
    await server.close();
    await platform.close();
  });

  const all = await api(server.baseUrl, apiKey, 'GET', '/v1/directory');
  assert.equal(all.json.data.length, 1);
  assert.match(all.json.data[0].address, /public-bot@/);

  const byCapability = await api(server.baseUrl, apiKey, 'GET', '/v1/directory?capability=invoice.parse');
  assert.equal(byCapability.json.data.length, 1);

  const noMatch = await api(server.baseUrl, apiKey, 'GET', '/v1/directory?capability=nope');
  assert.equal(noMatch.json.data.length, 0);
});

test('inbound mail from outside lands in the mailbox and threads with the reply', async (t) => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent, apiKey: agentKey } = await seedAgent(platform, account, 'support');
  const server = await startServer(platform);
  t.after(async () => {
    await server.close();
    await platform.close();
  });

  const raw = [
    'From: Customer <customer@example.test>',
    `To: ${agent.address}`,
    'Subject: Where is my order?',
    'Message-ID: <inbound-1@example.test>',
    '',
    'It has been a week.',
  ].join('\r\n');

  const response = await fetch(`${server.baseUrl}/ingest/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agentmail-ingest-secret': platform.config.secret },
    body: JSON.stringify({ raw, recipients: [agent.address], verdicts: { dmarc: 'PASS' } }),
  });
  const ingested = (await response.json()) as any;
  assert.equal(response.status, 200);
  assert.equal(ingested.delivered.length, 1);

  const inbox = await api(server.baseUrl, agentKey, 'GET', '/v1/agents/me/messages');
  assert.equal(inbox.json.data[0].subject, 'Where is my order?');
  assert.equal(inbox.json.data[0].text, 'It has been a week.');

  const followUp = raw
    .replace('Message-ID: <inbound-1@example.test>', 'Message-ID: <inbound-2@example.test>\r\nIn-Reply-To: <inbound-1@example.test>')
    .replace('Subject: Where is my order?', 'Subject: Re: Where is my order?');
  await fetch(`${server.baseUrl}/ingest/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agentmail-ingest-secret': platform.config.secret },
    body: JSON.stringify({ raw: followUp, recipients: [agent.address], verdicts: { dmarc: 'PASS' } }),
  });

  const threaded = await api(server.baseUrl, agentKey, 'GET', '/v1/agents/me/messages');
  assert.equal(threaded.json.data.length, 2);
  assert.equal(threaded.json.data[0].thread_id, threaded.json.data[1].thread_id);
});

test('the ingest endpoint refuses an unsigned caller', async (t) => {
  const { platform } = newHarness();
  const server = await startServer(platform);
  t.after(async () => {
    await server.close();
    await platform.close();
  });

  const response = await fetch(`${server.baseUrl}/ingest/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ raw: 'x', recipients: ['a@b.test'] }),
  });
  assert.equal(response.status, 403);
});

test('unknown routes and bad credentials answer predictably', async (t) => {
  const { platform } = newHarness();
  const { apiKey } = await seedAccount(platform, 'acme');
  const server = await startServer(platform);
  t.after(async () => {
    await server.close();
    await platform.close();
  });

  const missing = await api(server.baseUrl, apiKey, 'GET', '/v1/nope');
  assert.equal(missing.status, 404);

  const wrongMethod = await api(server.baseUrl, apiKey, 'PATCH', '/v1/emails');
  assert.equal(wrongMethod.status, 405);

  const badKey = await api(server.baseUrl, 'am_live_not-a-real-key', 'GET', '/v1/emails');
  assert.equal(badKey.status, 401);

  const health = await fetch(`${server.baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as any).status, 'ok');
});

test('a key scoped to one domain cannot send from another', async (t) => {
  const { platform } = newHarness();
  const { account, apiKey } = await seedAccount(platform, 'acme', 'acme.test');
  const other = await platform.domains.add(account.id, 'other.test');
  await platform.store.updateDomain(other.id, { status: 'verified', verifiedAt: new Date().toISOString() });

  const [acme] = (await platform.domains.list(account.id)).filter((d) => d.domain === 'acme.test');
  const scoped = await platform.accounts.createApiKey(account.id, 'acme-only', 'send', {
    domainId: acme.id,
  });
  const server = await startServer(platform);
  t.after(async () => {
    await server.close();
    await platform.close();
  });

  const allowed = await api(server.baseUrl, scoped.secret, 'POST', '/v1/emails', {
    from: 'hello@acme.test',
    to: ['someone@example.test'],
    subject: 'Fine',
    text: 'fine',
  });
  assert.equal(allowed.status, 202);

  const refused = await api(server.baseUrl, scoped.secret, 'POST', '/v1/emails', {
    from: 'hello@other.test',
    to: ['someone@example.test'],
    subject: 'Not fine',
    text: 'nope',
  });
  assert.equal(refused.status, 403);
  assert.match(refused.json.error.message, /only send from acme\.test/);

  // An unscoped key on the same account may still use either domain.
  const unscoped = await api(server.baseUrl, apiKey, 'POST', '/v1/emails', {
    from: 'hello@other.test',
    to: ['someone@example.test'],
    subject: 'Fine too',
    text: 'fine',
  });
  assert.equal(unscoped.status, 202);
});

test('scheduling is capped at 30 days ahead', async (t) => {
  const { platform } = newHarness();
  const { apiKey } = await seedAccount(platform, 'acme', 'acme.test');
  const server = await startServer(platform);
  t.after(async () => {
    await server.close();
    await platform.close();
  });

  const within = new Date(Date.now() + 29 * 24 * 3600_000).toISOString();
  const beyond = new Date(Date.now() + 31 * 24 * 3600_000).toISOString();
  const base = { from: 'hello@acme.test', to: ['someone@example.test'], subject: 'Later', text: 'later' };

  const ok = await api(server.baseUrl, apiKey, 'POST', '/v1/emails', { ...base, scheduled_at: within });
  assert.equal(ok.status, 202);
  assert.equal(ok.json.status, 'scheduled');

  const rejected = await api(server.baseUrl, apiKey, 'POST', '/v1/emails', { ...base, scheduled_at: beyond });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.json.error.field, 'scheduled_at');

  const malformed = await api(server.baseUrl, apiKey, 'POST', '/v1/emails', {
    ...base,
    scheduled_at: 'next tuesday',
  });
  assert.equal(malformed.status, 400);
});

test('lists and suppressions export as CSV, and suppressions are searchable', async (t) => {
  const { platform } = newHarness();
  const { account, apiKey } = await seedAccount(platform, 'acme', 'acme.test');
  const list = await platform.lists.create(account.id, 'Announcements');
  await platform.lists.import(account.id, list.id, [
    { email: 'a@example.test', name: 'Doe, John', company: 'Acme' },
    { email: 'b@example.test', name: 'B' },
  ]);
  await platform.suppression.add(account.id, 'angry@example.test', 'complaint');
  await platform.suppression.add(account.id, 'gone@other.test', 'hard_bounce');

  const server = await startServer(platform);
  t.after(async () => {
    await server.close();
    await platform.close();
  });

  const listCsv = await fetch(`${server.baseUrl}/v1/lists/${list.id}/export`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.match(listCsv.headers.get('content-type') ?? '', /text\/csv/);
  const listBody = await listCsv.text();
  assert.match(listBody.split('\r\n')[0], /^email,name,status,source,confirmed_at,created_at,company$/);
  assert.match(listBody, /"Doe, John"/, 'a comma in a field must be quoted');

  const search = await api(server.baseUrl, apiKey, 'GET', '/v1/suppressions?q=other.test');
  assert.equal(search.json.data.length, 1);
  assert.equal(search.json.data[0].email, 'gone@other.test');

  const byReason = await api(server.baseUrl, apiKey, 'GET', '/v1/suppressions?reason=complaint');
  assert.equal(byReason.json.data.length, 1);
  assert.equal(byReason.json.data[0].email, 'angry@example.test');

  const suppressionCsv = await fetch(`${server.baseUrl}/v1/suppressions/export`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const suppressionBody = await suppressionCsv.text();
  assert.match(suppressionBody, /^email,reason,list_id,note,created_at/);
  assert.equal(suppressionBody.trim().split('\r\n').length, 3);
});

test('a webhook delivery can be replayed', async (t) => {
  const attempts: string[] = [];
  const { platform } = newHarness({
    fetcher: async (_url, init) => {
      attempts.push(init.body);
      return { ok: true, status: 200 };
    },
  });
  const { account, apiKey } = await seedAccount(platform, 'acme', 'acme.test');
  const webhook = await platform.webhooks.create(account.id, 'https://hooks.example.test/x', ['sent']);
  const server = await startServer(platform);
  t.after(async () => {
    await server.close();
    await platform.close();
  });

  await platform.sending.send(account, {
    from: 'auth@acme.test',
    to: 'user@example.test',
    subject: 'Hook',
    text: 'hi',
  });
  await platform.drain();
  const before = attempts.length;
  assert.ok(before >= 1);

  const deliveries = await api(server.baseUrl, apiKey, 'GET', `/v1/webhooks/${webhook.id}/deliveries`);
  assert.equal(deliveries.json.data[0].status, 'succeeded');

  const replay = await api(
    server.baseUrl,
    apiKey,
    'POST',
    `/v1/webhooks/${webhook.id}/deliveries/${deliveries.json.data[0].id}/replay`,
  );
  assert.equal(replay.status, 202);

  await platform.drain();
  assert.equal(attempts.length, before + 1);
  assert.match(attempts[attempts.length - 1], /"replay":true/);
});

test('the message log filters by tag and records administrative actions', async (t) => {
  const { platform } = newHarness();
  const { account, apiKey } = await seedAccount(platform, 'acme', 'acme.test');
  const server = await startServer(platform);
  t.after(async () => {
    await server.close();
    await platform.close();
  });

  const base = { from: 'auth@acme.test', to: ['user@example.test'], subject: 'Tagged', text: 'hi' };
  await api(server.baseUrl, apiKey, 'POST', '/v1/emails', { ...base, tags: { order: '4711' } });
  await api(server.baseUrl, apiKey, 'POST', '/v1/emails', { ...base, tags: { order: '4712' } });
  await api(server.baseUrl, apiKey, 'POST', '/v1/emails', { ...base, tags: { kind: 'alert' } });

  const byKey = await api(server.baseUrl, apiKey, 'GET', '/v1/emails?tag=order');
  assert.equal(byKey.json.data.length, 2);

  const byValue = await api(server.baseUrl, apiKey, 'GET', '/v1/emails?tag=order:4711');
  assert.equal(byValue.json.data.length, 1);

  const noMatch = await api(server.baseUrl, apiKey, 'GET', '/v1/emails?tag=order:9999');
  assert.equal(noMatch.json.data.length, 0);

  // Administrative actions leave an audit trail (FR-12.8).
  const agent = await api(server.baseUrl, apiKey, 'POST', '/v1/agents', { display_name: 'auditor' });
  await api(server.baseUrl, apiKey, 'DELETE', `/v1/agents/${agent.json.id}`);
  const suppression = await platform.suppression.add(account.id, 'lift@example.test', 'manual');
  await api(server.baseUrl, apiKey, 'DELETE', `/v1/suppressions/${suppression.id}`);

  const audit = await api(server.baseUrl, apiKey, 'GET', '/v1/audit');
  const actions = audit.json.data.map((entry: { action: string }) => entry.action);
  for (const expected of [
    'account.created',
    'api_key.created',
    'domain.added',
    'agent.created',
    'agent.removed',
    'suppression.removed',
  ]) {
    assert.ok(actions.includes(expected), `audit log is missing ${expected}`);
  }
});

test('ingest fails closed when AGENTMAIL_SECRET is unset', async (t) => {
  // Reproduce a deployment that never set the variable, by leaving the
  // published default in place.
  const { platform } = newHarness({ secret: 'development-secret-do-not-use-in-production' });
  const server = await startServer(platform);
  t.after(async () => {
    await server.close();
    await platform.close();
  });

  // Even presenting the published default must not get through.
  const response = await fetch(`${server.baseUrl}/ingest/inbound`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agentmail-ingest-secret': 'development-secret-do-not-use-in-production',
    },
    body: JSON.stringify({ raw: 'x', recipients: ['a@b.test'] }),
  });
  assert.equal(response.status, 503);
  const body = (await response.json()) as any;
  assert.match(body.error.message, /AGENTMAIL_SECRET/);

  const health = await (await fetch(`${server.baseUrl}/health`)).json() as any;
  assert.ok(health.warnings.some((w: string) => /AGENTMAIL_SECRET/.test(w)));
});

test('the root path describes the service', async (t) => {
  const { platform } = newHarness();
  const server = await startServer(platform);
  t.after(async () => {
    await server.close();
    await platform.close();
  });

  const response = await fetch(`${server.baseUrl}/`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.equal(body.name, 'agentmail');
  assert.equal(body.protocol.name, 'ACCP');
  assert.equal(body.agent_domain, 'agents.agentmail.test');
});

test('health reports what is misconfigured rather than only "ok"', async (t) => {
  const { platform } = newHarness();
  const server = await startServer(platform);
  t.after(async () => {
    await server.close();
    await platform.close();
  });

  const health = (await (await fetch(`${server.baseUrl}/health`)).json()) as any;
  assert.equal(health.status, 'ok');
  assert.ok(
    health.warnings.some((w: string) => /in-memory/.test(w)),
    'a non-durable store must be visible on the health endpoint',
  );
});
