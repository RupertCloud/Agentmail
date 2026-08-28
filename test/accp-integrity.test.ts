import assert from 'node:assert/strict';
import test from 'node:test';
import { HEADER_PAYLOAD_DIGEST, buildRawMessage, parseRawMessage, payloadDigest } from '../src/util/mime.js';
import { newHarness, seedAccount, seedAgent } from './helpers.js';

function signedMessage(payload: unknown): string {
  return buildRawMessage({
    from: { email: 'buyer@partner.test' },
    to: [{ email: 'seller@acme.test' }],
    subject: 'Quote request',
    text: 'Requesting a quote.',
    structured: payload,
    context: { principal: { type: 'organization', id: 'partner.test' } },
    messageId: '<i1@partner.test>',
  });
}

test('an outbound message publishes a digest of its envelope', () => {
  const raw = signedMessage({ sku: 'W-1', quantity: 40 });
  const parsed = parseRawMessage(raw);
  const declared = parsed.headers[HEADER_PAYLOAD_DIGEST.toLowerCase()];

  assert.ok(declared, 'the digest header must be present when a payload is');
  assert.match(declared, /^sha-256=/);
  assert.equal(declared, payloadDigest(parsed.structuredRaw!), 'and must match what was sent');
});

test('an intact message arrives with integrity verified', async () => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent } = await seedAgent(platform, account, 'seller');

  const raw = signedMessage({ sku: 'W-1', quantity: 40 }).replace(
    'To: seller@acme.test',
    `To: ${agent.address}`,
  );
  await platform.inbound.ingest({
    raw,
    recipients: [agent.address],
    verdicts: { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' },
  });

  const [received] = await platform.mailbox.list(agent);
  assert.equal(received.payloadIntegrity, 'verified');
  assert.deepEqual(received.structured, { sku: 'W-1', quantity: 40 });
});

test('a payload altered in transit is reported as modified, not delivered as authentic', async () => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent } = await seedAgent(platform, account, 'seller');

  const raw = signedMessage({ sku: 'W-1', quantity: 40 }).replace(
    'To: seller@acme.test',
    `To: ${agent.address}`,
  );

  // Something between sender and receiver rewrites the quantity. The digest
  // header is untouched, exactly as a gateway rewriting a body would leave it.
  const original = parseRawMessage(raw).structuredRaw!;
  const tampered = original.replace('"quantity": 40', '"quantity": 4000');
  assert.notEqual(tampered, original, 'the fixture must actually change the payload');
  const rawTampered = raw.replace(
    Buffer.from(original, 'utf8').toString('base64').match(/.{1,76}/g)!.join('\r\n'),
    Buffer.from(tampered, 'utf8').toString('base64').match(/.{1,76}/g)!.join('\r\n'),
  );

  await platform.inbound.ingest({
    raw: rawTampered,
    recipients: [agent.address],
    // Note the sender still authenticates: DMARC passes on SPF alignment while
    // the body has changed. Authentication is not integrity.
    verdicts: { spf: 'PASS', dkim: 'FAIL', dmarc: 'PASS' },
  });

  const [received] = await platform.mailbox.list(agent);
  assert.equal(received.payloadIntegrity, 'modified', 'the agent must be told the payload changed');
  assert.deepEqual(received.structured, { sku: 'W-1', quantity: 4000 });
  assert.equal(received.authResults?.dmarc, 'PASS', 'and that the sender still authenticated');
  assert.equal(received.authResults?.dkim, 'FAIL');
});

test('a payload with no digest is unverified rather than assumed intact', async () => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent } = await seedAgent(platform, account, 'seller');

  const raw = [
    'From: legacy@peer.test',
    `To: ${agent.address}`,
    'Subject: No digest',
    'Message-ID: <nodigest@peer.test>',
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
    '{"accp":"0.2","payload":{"sku":"W-1"}}',
    '--b--',
  ].join('\r\n');

  await platform.inbound.ingest({
    raw,
    recipients: [agent.address],
    verdicts: { dmarc: 'PASS' },
  });

  const [received] = await platform.mailbox.list(agent);
  assert.equal(received.payloadIntegrity, 'unverified');
});

test('a message with no payload has no integrity verdict to give', async () => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent } = await seedAgent(platform, account, 'seller');

  await platform.inbound.ingest({
    raw: [
      'From: human@example.test',
      `To: ${agent.address}`,
      'Subject: Just prose',
      'Message-ID: <prose@example.test>',
      '',
      'no payload here',
    ].join('\r\n'),
    recipients: [agent.address],
    verdicts: { dmarc: 'PASS' },
  });

  const [received] = await platform.mailbox.list(agent);
  assert.equal(received.payloadIntegrity, null);
});
