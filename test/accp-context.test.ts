import assert from 'node:assert/strict';
import test from 'node:test';
import type { AccpContext } from '../src/types.js';
import { ACCP_VERSION, buildRawMessage, parseRawMessage } from '../src/util/mime.js';
import { newHarness, seedAccount, seedAgent } from './helpers.js';

/** Pulls the base64 accp+json part out of a raw message and decodes it. */
function decodeAccpPart(raw: string): string {
  const marker = raw.indexOf('application/accp+json');
  assert.notEqual(marker, -1, 'the message must carry an accp+json part');
  const bodyStart = raw.indexOf('\r\n\r\n', marker) + 4;
  const bodyEnd = raw.indexOf('\r\n------=', bodyStart);
  const body = raw.slice(bodyStart, bodyEnd === -1 ? undefined : bodyEnd);
  return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
}

const context: AccpContext = {
  principal: { type: 'organization', id: 'acme.test', display_name: 'Acme Ltd' },
  delegation: { depth: 2, chain: ['person:ada@acme.test', 'agent:buyer@acme.test'] },
  summary: 'Ada asked for 40 units by 5 September. Two suppliers already missed the date.',
  expects: { reply_by: '2026-09-01T00:00:00Z', format: 'structured' },
  constraints: { confidential: true, do_not_train: true },
  provenance: { generated_by: 'model', human_reviewed: false },
};

test('context and payload travel together in the envelope and survive the round trip', () => {
  const raw = buildRawMessage({
    from: { email: 'buyer@acme.test' },
    to: [{ email: 'seller@widgets.test' }],
    subject: 'Quote request',
    text: 'Requesting a quote.',
    structured: { sku: 'W-1', quantity: 40 },
    context,
    messageId: '<c1@acme.test>',
  });

  assert.match(raw, /Content-Type: application\/accp\+json/);

  // The part is base64 on the wire, so assert on what it decodes to.
  const envelope = JSON.parse(decodeAccpPart(raw));
  assert.equal(envelope.accp, ACCP_VERSION);
  assert.deepEqual(Object.keys(envelope).sort(), ['accp', 'context', 'payload']);
  assert.deepEqual(envelope.payload, { sku: 'W-1', quantity: 40 });

  const parsed = parseRawMessage(raw);
  assert.deepEqual(parsed.structured, { sku: 'W-1', quantity: 40 });
  assert.deepEqual(parsed.context, context);
});

test('a 0.1 part with no envelope is still read as a bare payload', () => {
  const legacy = [
    'From: old@peer.test',
    'To: agent@acme.test',
    'Subject: Pre-envelope sender',
    'Message-ID: <legacy@peer.test>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain',
    '',
    'hello',
    '--b',
    'Content-Type: application/accp+json',
    'Content-Disposition: inline; filename="accp.json"',
    '',
    '{"sku":"W-1","quantity":40}',
    '--b--',
  ].join('\r\n');

  const parsed = parseRawMessage(legacy);
  assert.deepEqual(parsed.structured, { sku: 'W-1', quantity: 40 });
  assert.equal(parsed.context, undefined, 'a 0.1 part carries no context, and none is invented');
});

test('context reaches the recipient agent unmodified over the internal fast path', async () => {
  const { platform, provider } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent: buyer } = await seedAgent(platform, account, 'buyer');
  const { agent: seller } = await seedAgent(platform, account, 'seller');

  await platform.sending.send(
    account,
    { to: seller.address, subject: 'Quote request', structured: { sku: 'W-1' }, context },
    buyer,
  );

  const [received] = await platform.mailbox.list(seller);
  assert.deepEqual(received.context, context, 'ACCP §6.3 C-1: delivered unmodified');
  assert.equal(provider.sent.length, 0);
});

test('context survives external transport and is recovered on ingest', async () => {
  const { platform, provider } = newHarness();
  const { account } = await seedAccount(platform, 'acme', 'acme.test');
  const agent = await platform.agents.create(account, {
    slug: 'buyer',
    displayName: 'Buyer',
    address: 'buyer@acme.test',
  });

  await platform.sending.send(
    account,
    { to: 'stranger@elsewhere.test', subject: 'Quote', structured: { sku: 'W-1' }, context },
    agent,
  );
  await platform.drain();

  // Take what actually went on the wire and feed it back in as inbound mail.
  const onTheWire = provider.sent[0].raw;
  const { agent: receiver } = await seedAgent(platform, account, 'receiver');
  const redirected = onTheWire.replace('To: stranger@elsewhere.test', `To: ${receiver.address}`);

  const result = await platform.inbound.ingest({
    raw: redirected,
    recipients: [receiver.address],
    verdicts: { dmarc: 'PASS' },
  });
  assert.equal(result.delivered.length, 1);
  assert.deepEqual(result.delivered[0].context, context);
  assert.deepEqual(result.delivered[0].structured, { sku: 'W-1' });
});

test('inbound mail without context does not have one invented for it', async () => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent } = await seedAgent(platform, account, 'support');

  await platform.inbound.ingest({
    raw: [
      'From: human@example.test',
      `To: ${agent.address}`,
      'Subject: Just a person writing',
      'Message-ID: <plain@example.test>',
      '',
      'no json here',
    ].join('\r\n'),
    recipients: [agent.address],
    verdicts: { dmarc: 'PASS' },
  });

  const [received] = await platform.mailbox.list(agent);
  assert.equal(received.context, null, 'ACCP §6.3 C-2: absent stays absent');
});

test('delegation depth is bounded, like the hop ceiling but for authority', async () => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent: buyer } = await seedAgent(platform, account, 'buyer');
  const { agent: seller } = await seedAgent(platform, account, 'seller');

  const send = (depth: number) =>
    platform.sending.send(
      account,
      {
        to: seller.address,
        subject: 'Chained request',
        structured: {},
        context: { delegation: { depth } },
      },
      buyer,
    );

  await send(platform.config.maxDelegationDepth);
  await assert.rejects(() => send(platform.config.maxDelegationDepth + 1), /Delegation depth/);
  await assert.rejects(() => send(-1), /non-negative integer/);
});
