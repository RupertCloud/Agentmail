import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCP_VERSION,
  HEADER_AGENT,
  HEADER_CONVERSATION,
  HEADER_HOPS,
  HEADER_INTENT,
  HEADER_VERSION,
  STRUCTURED_MEDIA_TYPE,
  buildRawMessage,
  parseRawMessage,
} from '../src/util/mime.js';
import { newHarness, seedAccount, seedAgent } from './helpers.js';

test('an agent message carries the full ACCP envelope on the wire', async () => {
  const { platform, provider } = newHarness();
  const { account } = await seedAccount(platform, 'acme', 'acme.test');
  const agent = await platform.agents.create(account, {
    slug: 'buyer',
    displayName: 'Buyer',
    address: 'buyer@acme.test',
  });

  await platform.sending.send(
    account,
    { to: 'seller@elsewhere.test', subject: 'Quote request', structured: { sku: 'W-1', quantity: 40 } },
    agent,
  );
  await platform.drain();

  const raw = provider.sent[0].raw;
  assert.match(raw, new RegExp(`${HEADER_VERSION}: ${ACCP_VERSION}`));
  assert.match(raw, new RegExp(`${HEADER_INTENT}: request`));
  assert.match(raw, new RegExp(`${HEADER_HOPS}: 1`));
  assert.match(raw, new RegExp(`${HEADER_AGENT}: buyer@acme.test`));
  assert.match(raw, new RegExp(`${HEADER_CONVERSATION}: thr_`));

  // §5.1: the payload travels under its own media type, not bare JSON.
  assert.match(raw, /Content-Type: application\/accp\+json/);
  assert.match(raw, /filename="accp.json"/);

  // §5.2: a human-readable part is mandatory, generated when not supplied.
  const parsed = parseRawMessage(raw);
  assert.ok(parsed.text && parsed.text.length > 0, 'a prose part must always be present');
  assert.deepEqual(parsed.structured, { sku: 'W-1', quantity: 40 });

  // §4: a reply declares `response`.
  const inbound = [
    'From: seller@elsewhere.test',
    'To: buyer@acme.test',
    'Subject: Re: Quote request',
    'Message-ID: <r1@elsewhere.test>',
    `${HEADER_CONVERSATION}: cnv-external-1`,
    '',
    'Twelve each.',
  ].join('\r\n');
  await platform.inbound.ingest({
    raw: inbound,
    recipients: ['buyer@acme.test'],
    verdicts: { dmarc: 'PASS' },
  });
  const [received] = await platform.mailbox.list(agent);
  await platform.sending.send(
    account,
    { to: 'seller@elsewhere.test', subject: 'Re: Quote request', text: 'ok', inReplyTo: received.rfcMessageId },
    agent,
  );
  await platform.drain();
  assert.match(provider.sent[1].raw, new RegExp(`${HEADER_INTENT}: response`));
});

test('a declared conversation token threads where References would not', async () => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent } = await seedAgent(platform, account, 'support');

  const message = (id: string, extraHeaders: string[]) =>
    [
      'From: peer@partner.test',
      `To: ${agent.address}`,
      'Subject: Anything at all',
      `Message-ID: <${id}@partner.test>`,
      ...extraHeaders,
      '',
      'body',
    ].join('\r\n');

  await platform.inbound.ingest({
    raw: message('one', [`${HEADER_CONVERSATION}: cnv-42`]),
    recipients: [agent.address],
    verdicts: { dmarc: 'PASS' },
  });

  // No In-Reply-To, no References, and a subject that would thread by accident
  // is deliberately reused — only the declared token can correlate these.
  await platform.inbound.ingest({
    raw: message('two', [`${HEADER_CONVERSATION}: cnv-42`]),
    recipients: [agent.address],
    verdicts: { dmarc: 'PASS' },
  });

  const inbox = await platform.mailbox.list(agent);
  assert.equal(inbox.length, 2);
  assert.equal(inbox[0].threadId, inbox[1].threadId, 'the declared token must correlate them');
  assert.equal(inbox[0].conversationKey, 'partner.test:cnv-42');
});

test('the conversation token is scoped by sender domain, so two senders cannot collide', async () => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent } = await seedAgent(platform, account, 'support');

  for (const sender of ['a.test', 'b.test']) {
    await platform.inbound.ingest({
      raw: [
        `From: peer@${sender}`,
        `To: ${agent.address}`,
        `Subject: Unrelated from ${sender}`,
        `Message-ID: <m-${sender}@${sender}>`,
        `${HEADER_CONVERSATION}: cnv-collide`,
        '',
        'body',
      ].join('\r\n'),
      recipients: [agent.address],
      verdicts: { dmarc: 'PASS' },
    });
  }

  const inbox = await platform.mailbox.list(agent);
  assert.equal(inbox.length, 2);
  assert.notEqual(
    inbox[0].threadId,
    inbox[1].threadId,
    'the same token from two domains must not merge two conversations',
  );
});

test('pre-standard header and part names are still accepted inbound', () => {
  const legacy = [
    'From: old@peer.test',
    'To: agent@acme.test',
    'Subject: Legacy sender',
    'Message-ID: <legacy@peer.test>',
    'X-AgentMail-Hops: 3',
    'X-AgentMail-Thread: thr-legacy',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain',
    '',
    'hello',
    '--b',
    'Content-Type: application/json',
    'Content-Disposition: inline; filename="agentmail.json"',
    '',
    '{"legacy":true}',
    '--b--',
  ].join('\r\n');

  const parsed = parseRawMessage(legacy);
  assert.equal(parsed.headers[HEADER_HOPS.toLowerCase()], '3');
  assert.equal(parsed.headers[HEADER_CONVERSATION.toLowerCase()], 'thr-legacy');
  assert.deepEqual(parsed.structured, { legacy: true });
});

test('the structured part round trips under the registered media type', () => {
  const raw = buildRawMessage({
    from: { email: 'a@acme.test' },
    to: [{ email: 'b@peer.test' }],
    subject: 'Payload',
    text: 'prose',
    structured: { nested: { works: true }, list: [1, 2, 3] },
    messageId: '<p1@acme.test>',
  });
  assert.ok(raw.includes(STRUCTURED_MEDIA_TYPE));
  assert.deepEqual(parseRawMessage(raw).structured, { nested: { works: true }, list: [1, 2, 3] });
});
