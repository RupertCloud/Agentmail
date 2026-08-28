import assert from 'node:assert/strict';
import test from 'node:test';
import { ListService } from '../src/domain/lists.js';
import { generateApiKey, signWebhook, verifyApiKey, verifyWebhookSignature } from '../src/util/crypto.js';
import {
  formatAddress,
  htmlToText,
  normalizeSubject,
  parseAddressList,
  renderTemplate,
} from '../src/util/email.js';
import { buildRawMessage, parseRawMessage } from '../src/util/mime.js';

test('addresses parse and format round trip', () => {
  const parsed = parseAddressList('Ada Lovelace <ada@example.test>, plain@example.test');
  assert.deepEqual(parsed, [
    { email: 'ada@example.test', name: 'Ada Lovelace' },
    { email: 'plain@example.test' },
  ]);
  assert.equal(formatAddress(parsed[0]), 'Ada Lovelace <ada@example.test>');
  assert.equal(formatAddress({ email: 'a@b.test', name: 'Doe, John' }), '"Doe, John" <a@b.test>');

  // A comma inside a quoted display name must not split the list.
  assert.equal(parseAddressList('"Doe, John" <a@b.test>, c@d.test').length, 2);
});

test('html degrades to readable plain text with link targets kept', () => {
  const text = htmlToText(
    '<html><head><style>p{}</style></head><body><h1>Hi</h1><p>See <a href="https://x.test">docs</a>.</p></body></html>',
  );
  assert.equal(text, 'Hi\n\nSee docs (https://x.test).');
});

test('template variables are escaped by default and raw on request', () => {
  const variables = { name: '<script>', order: { id: 7 } };
  assert.equal(renderTemplate('Hi {{name}}', variables), 'Hi &lt;script&gt;');
  assert.equal(renderTemplate('Hi {{{name}}}', variables), 'Hi <script>');
  assert.equal(renderTemplate('Order {{order.id}}', variables), 'Order 7');
  assert.equal(renderTemplate('Unknown {{nope}}!', variables), 'Unknown !');
});

test('subjects normalise for threading', () => {
  assert.equal(normalizeSubject('Re: Fwd: Quote request'), 'quote request');
  assert.equal(normalizeSubject('RE[2]: Quote request'), 'quote request');
});

test('a structured payload survives a MIME round trip', () => {
  const raw = buildRawMessage({
    from: { email: 'buyer@acme.test', name: 'Buyer' },
    to: [{ email: 'seller@example.test' }],
    subject: 'Quote — 40 units',
    text: 'Plain body',
    html: '<p>HTML body</p>',
    structured: { sku: 'WIDGET-1', quantity: 40 },
    attachments: [
      { filename: 'spec.txt', contentType: 'text/plain', content: Buffer.from('spec').toString('base64') },
    ],
    messageId: '<abc@agentmail.test>',
    headers: { 'X-AgentMail-Hops': '2' },
  });

  const parsed = parseRawMessage(raw);
  assert.equal(parsed.subject, 'Quote — 40 units');
  assert.equal(parsed.from[0].email, 'buyer@acme.test');
  assert.equal(parsed.text, 'Plain body');
  assert.equal(parsed.html, '<p>HTML body</p>');
  assert.deepEqual(parsed.structured, { sku: 'WIDGET-1', quantity: 40 });
  assert.equal(parsed.attachments.length, 1);
  assert.equal(Buffer.from(parsed.attachments[0].content, 'base64').toString(), 'spec');
  assert.equal(parsed.headers['x-agentmail-hops'], '2');
});

test('a text-only message round trips without multipart', () => {
  const raw = buildRawMessage({
    from: { email: 'a@acme.test' },
    to: [{ email: 'b@example.test' }],
    subject: 'Simple',
    text: 'just text',
    messageId: '<simple@agentmail.test>',
  });
  assert.match(raw, /Content-Type: text\/plain/);
  const parsed = parseRawMessage(raw);
  assert.equal(parsed.text, 'just text');
  assert.equal(parsed.html, null);
});

test('api keys verify only against their own hash', () => {
  const generated = generateApiKey('test');
  assert.match(generated.secret, /^am_test_/);
  assert.equal(generated.prefix, generated.secret.slice(0, 12));
  assert.ok(verifyApiKey(generated.secret, generated.hash));
  assert.equal(verifyApiKey(`${generated.secret}x`, generated.hash), false);
  assert.equal(generated.hash.includes(generated.secret), false, 'the plaintext must never be stored');
});

test('webhook signatures reject tampering and stale timestamps', () => {
  const now = Date.now();
  const signature = signWebhook('whsec_test', '{"a":1}', Math.floor(now / 1000));
  assert.ok(verifyWebhookSignature('whsec_test', '{"a":1}', signature, 300, now));
  assert.equal(verifyWebhookSignature('whsec_test', '{"a":2}', signature, 300, now), false);
  assert.equal(verifyWebhookSignature('whsec_test', '{"a":1}', signature, 300, now + 600_000), false);
});

test('CSV import parses quoted fields and custom columns', () => {
  const rows = ListService.parseCsv('email,name,company\na@b.test,"Doe, John","Acme, Inc"\nc@d.test,C,');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { email: 'a@b.test', name: 'Doe, John', company: 'Acme, Inc' });
  assert.equal(rows[1].company, '');
});
