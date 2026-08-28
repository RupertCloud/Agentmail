import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HEADER_CONTENT_DIGEST,
  buildContentDigest,
  buildRawMessage,
  formatContentDigest,
  parseRawMessage,
  type DigestEnvelope,
} from '../src/util/mime.js';
import { newHarness, seedAccount, seedAgent } from './helpers.js';

/** Build an honest ACCP message from a fixed sender/date, ready to tamper. */
function honest(overrides: Parameters<typeof buildRawMessage>[0] extends infer T ? Partial<any> : never = {}): string {
  return buildRawMessage({
    from: { email: 'buyer@partner.test' },
    to: [{ email: 'seller@acme.test' }],
    subject: 'Quote request',
    text: 'Requesting a quote.',
    structured: { sku: 'W-1', quantity: 40 },
    context: { principal: { type: 'organization', id: 'partner.test' } },
    messageId: '<i1@partner.test>',
    date: new Date('2026-08-28T00:00:00Z'),
    ...overrides,
  });
}

/** Swap raw base64 body bytes: re-encode `before` → `after` in place. */
function swapBody(raw: string, before: string, after: string): string {
  const enc = (s: string) => Buffer.from(s, 'utf8').toString('base64').match(/.{1,76}/g)!.join('\r\n');
  return raw.replace(enc(before), enc(after));
}

/** Append a header cleanly at the end of the header block. */
function appendHeader(raw: string, line: string): string {
  const end = raw.indexOf('\r\n\r\n');
  return raw.slice(0, end) + `\r\n${line}` + raw.slice(end);
}

async function ingestTo(raw: string, verdicts: any = { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' }) {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent } = await seedAgent(platform, account, 'seller');
  const redirected = raw.replace(/To: [^\r]+/, `To: ${agent.address}`);
  await platform.inbound.ingest({ raw: redirected, recipients: [agent.address], verdicts });
  const [msg] = await platform.mailbox.list(agent);
  return msg;
}

test('an intact message verifies', async () => {
  const msg = await ingestTo(honest());
  assert.equal(msg.payloadIntegrity, 'verified');
  assert.deepEqual(msg.modifiedParts, []);
  assert.deepEqual(msg.structured, { sku: 'W-1', quantity: 40 });
});

test('C0 — the duplicate-digest forge is blocked (digest_missing, not verified)', async () => {
  const raw = honest();
  const hp = parseRawMessage(raw);
  const tampered = hp.structuredRaw!.replace('"quantity": 40', '"quantity": 4000');
  const env: DigestEnvelope = { messageId: '<i1@partner.test>', from: 'buyer@partner.test', date: 'Fri, 28 Aug 2026 00:00:00 GMT' };
  const evil = formatContentDigest(buildContentDigest(env, { payload: tampered, text: 'Requesting a quote.', attachments: '' }));
  const forged = appendHeader(swapBody(raw, hp.structuredRaw!, tampered), `${HEADER_CONTENT_DIGEST}: ${evil}`);

  const msg = await ingestTo(forged);
  assert.equal(msg.payloadIntegrity, 'digest_missing', 'a second digest header must never yield verified');
  assert.deepEqual(msg.modifiedParts, ['duplicate-digest']);
});

test('C1/C2 — a committed part changed in transit is caught, at part granularity', async () => {
  // Rewrite the prose in transit without touching the digest. The old root
  // check (header vs header) would have missed this; per-part detection now
  // flags `text` while leaving the intact payload `verified`.
  const raw = honest();
  const swapped = swapBody(raw, 'Requesting a quote.', 'Wire funds to account 999.');
  const msg = await ingestTo(swapped);
  assert.ok(msg.modifiedParts!.includes('text'), 'the changed prose part must be flagged');
  assert.equal(msg.payloadIntegrity, 'verified', 'the untouched payload stays verified');
});

test('C3 — a stripped digest is digest_missing, distinct from unverified', async () => {
  const raw = honest().replace(new RegExp(`${HEADER_CONTENT_DIGEST}:[^\\r]*(\\r\\n[ \\t][^\\r]*)*\\r\\n`, 'i'), '');
  assert.ok(!/ACCP-Content-Digest/i.test(raw), 'digest header must be gone');
  const msg = await ingestTo(raw);
  assert.equal(msg.payloadIntegrity, 'digest_missing');
});

test('C4 — a message with no Message-ID cannot be verified', async () => {
  const raw = honest().replace(/Message-ID: [^\r]+\r\n/, '');
  const msg = await ingestTo(raw);
  assert.equal(msg.payloadIntegrity, 'unverified');
  assert.deepEqual(msg.modifiedParts, ['message-id']);
});

test('C6 — prose with a trailing newline is NOT falsely condemned', async () => {
  const msg = await ingestTo(honest({ text: 'Requesting a quote.\n' }));
  assert.equal(msg.payloadIntegrity, 'verified');
  assert.deepEqual(msg.modifiedParts, [], 'a trailing newline must not report text modified');
});

test('C7 — a caller cannot inject a reserved ACCP-* header', () => {
  const raw = buildRawMessage({
    from: { email: 'a@x.test' },
    to: [{ email: 'b@y.test' }],
    subject: 'x',
    structured: { amt: 40 },
    messageId: '<m@x.test>',
    headers: { 'ACCP-Content-Digest': 'alg=sha-256; root=FAKE; payload=FAKE', 'X-Fine': 'ok' },
  });
  const count = (raw.match(/ACCP-Content-Digest:/gi) || []).length;
  assert.equal(count, 1, 'only the computed digest header may appear');
  assert.ok(!raw.includes('root=FAKE'), 'the injected value must be dropped');
  assert.match(raw, /X-Fine: ok/, 'non-reserved caller headers still pass');
});

test('C8 — a swapped attachment is detected', async () => {
  const raw = honest({
    attachments: [{ filename: 'invoice.txt', contentType: 'text/plain', content: Buffer.from('pay 40').toString('base64') }],
  });
  // Replace the attachment content bytes in transit. The payload bytes are
  // untouched, so the payload stays verified — the tampering surfaces in
  // modifiedParts, which the agent contract requires it to check.
  const tampered = swapBody(raw, 'pay 40', 'pay 4000');
  const msg = await ingestTo(tampered);
  assert.ok(msg.modifiedParts!.includes('attachments'), 'attachment tampering must surface');
  assert.ok(msg.modifiedParts!.includes('root'), 'and break the set-level root');
  assert.equal(msg.payloadIntegrity, 'verified', 'the payload bytes themselves are intact');
});

test('C9 — an unrecognised algorithm is never verified', async () => {
  const raw = honest().replace(/alg=sha-256/i, 'alg=bogus-md4');
  const msg = await ingestTo(raw);
  assert.equal(msg.payloadIntegrity, 'unverified');
  assert.deepEqual(msg.modifiedParts, ['alg']);
});

test('C10 — a payload re-enveloped under a different sender fails', async () => {
  // Keep the digest, change the From. Every leaf binds to From, so all fail.
  const raw = honest().replace('From: buyer@partner.test', 'From: attacker@evil.test');
  const msg = await ingestTo(raw);
  assert.notEqual(msg.payloadIntegrity, 'verified');
});

test('C5 — length-prefixing makes the leaf pre-image injective', () => {
  const env = (mid: string): DigestEnvelope => ({ messageId: mid, from: 'a@x.test', date: 'd' });
  // The classic ambiguity: (mid="X", content="Y\0Z") vs (mid="X\0Y", content="Z").
  const a = buildContentDigest(env('X'), { payload: 'Y\0Z' }).leaves.payload;
  const b = buildContentDigest(env('X\0Y'), { payload: 'Z' }).leaves.payload;
  assert.notEqual(a, b, 'a NUL in one field must not shift into another');
});

test('S1/S2 — tamper_evident and dmarc_method are exposed for the agent to reason with', async () => {
  // DMARC passes via SPF only, DKIM fails: authenticated envelope, no body cover.
  const spfOnly = await ingestTo(honest(), { spf: 'PASS', dkim: 'FAIL', dmarc: 'PASS' });
  assert.equal(spfOnly.authResults?.tamperEvident, false, 'no DKIM ⇒ not tamper-evident');
  assert.equal(spfOnly.authResults?.dmarcMethod, 'spf', 'DMARC carried by SPF alone');

  const dkimPass = await ingestTo(honest(), { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' });
  assert.equal(dkimPass.authResults?.tamperEvident, true);
  assert.equal(dkimPass.authResults?.dmarcMethod, 'both');
});

test('a payload altered in transit (single digest) is reported modified', async () => {
  const raw = honest();
  const hp = parseRawMessage(raw);
  const tampered = hp.structuredRaw!.replace('"quantity": 40', '"quantity": 4000');
  const msg = await ingestTo(swapBody(raw, hp.structuredRaw!, tampered), { spf: 'PASS', dkim: 'FAIL', dmarc: 'PASS' });
  assert.equal(msg.payloadIntegrity, 'modified');
  assert.ok(msg.modifiedParts!.includes('payload') || msg.modifiedParts!.includes('root'));
  assert.deepEqual(msg.structured, { sku: 'W-1', quantity: 4000 });
});

test('S3 — a redelivered Message-ID is flagged as a replay', async () => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent } = await seedAgent(platform, account, 'seller');
  const raw = honest().replace(/To: [^\r]+/, `To: ${agent.address}`);

  const first = await platform.inbound.ingest({ raw, recipients: [agent.address], verdicts: { dmarc: 'PASS' } });
  const second = await platform.inbound.ingest({ raw, recipients: [agent.address], verdicts: { dmarc: 'PASS' } });

  assert.equal(first.delivered[0].isReplay, false, 'the first arrival is not a replay');
  assert.equal(second.delivered[0].isReplay, true, 'the redelivery of the same Message-ID is');
});
