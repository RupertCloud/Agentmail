import assert from 'node:assert/strict';
import test from 'node:test';
import { newHarness, seedAccount, seedAgent } from './helpers.js';

test('agent-to-agent mail is delivered internally without touching the provider', async () => {
  const { platform, provider } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent: buyer } = await seedAgent(platform, account, 'buyer');
  const { agent: seller } = await seedAgent(platform, account, 'seller');

  const result = await platform.sending.send(
    account,
    {
      to: seller.address,
      subject: 'Quote request',
      structured: { sku: 'WIDGET-1', quantity: 40 },
    },
    buyer,
  );

  assert.equal(result.message.transport, 'internal');
  assert.equal(result.message.status, 'delivered');
  assert.equal(result.internal.length, 1);
  assert.equal(provider.sent.length, 0, 'internal delivery must not reach the provider');

  const inbox = await platform.mailbox.list(seller);
  assert.equal(inbox.length, 1);
  assert.deepEqual(inbox[0].structured, { sku: 'WIDGET-1', quantity: 40 });
  assert.equal(inbox[0].mailboxState, 'unread');
  assert.equal(inbox[0].hops, 1);
});

test('claim leases a message and ack completes it', async () => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent: buyer } = await seedAgent(platform, account, 'buyer');
  const { agent: seller } = await seedAgent(platform, account, 'seller');

  await platform.sending.send(account, { to: seller.address, subject: 'Hello', text: 'hi' }, buyer);

  const claimed = await platform.mailbox.claim(seller, { max: 5, worker: 'worker-1' });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].mailboxState, 'claimed');
  assert.equal(claimed[0].claimedBy, 'worker-1');

  const second = await platform.mailbox.claim(seller, { max: 5, worker: 'worker-2' });
  assert.equal(second.length, 0, 'a leased message must not be handed to a second worker');

  const acked = await platform.mailbox.ack(seller, claimed[0].id);
  assert.equal(acked.mailboxState, 'acked');
});

test('an expired lease returns the message to the inbox', async () => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent: buyer } = await seedAgent(platform, account, 'buyer');
  const { agent: seller } = await seedAgent(platform, account, 'seller');

  await platform.sending.send(account, { to: seller.address, subject: 'Hello', text: 'hi' }, buyer);
  const [claimed] = await platform.mailbox.claim(seller, { leaseSeconds: 5 });

  const later = new Date(Date.now() + 10_000).toISOString();
  const reclaimed = await platform.mailbox.reclaimExpired(later);
  assert.equal(reclaimed, 1);

  const again = await platform.mailbox.claim(seller);
  assert.equal(again.length, 1);
  assert.equal(again[0].id, claimed.id);
  assert.equal(again[0].deliveryAttempts, 2);
});

test('replies thread and the hop counter climbs', async () => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent: buyer } = await seedAgent(platform, account, 'buyer');
  const { agent: seller } = await seedAgent(platform, account, 'seller');

  const first = await platform.sending.send(
    account,
    { to: seller.address, subject: 'Quote request', text: 'How much?' },
    buyer,
  );
  const [received] = await platform.mailbox.list(seller);

  const reply = await platform.sending.send(
    account,
    {
      to: buyer.address,
      subject: 'Re: Quote request',
      text: '40 units at 12 each.',
      inReplyTo: received.rfcMessageId,
    },
    seller,
  );

  assert.equal(reply.message.threadId, received.threadId);
  assert.equal(reply.message.hops, 2);
  assert.deepEqual(reply.message.references, [first.message.rfcMessageId]);

  const buyerInbox = await platform.mailbox.list(buyer);
  assert.equal(buyerInbox.length, 1);
  assert.equal(buyerInbox[0].threadId, first.message.threadId);
});

test('the hop ceiling stops a runaway agent loop', async () => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent: a } = await seedAgent(platform, account, 'ping', { maxHops: 3 });
  const { agent: b } = await seedAgent(platform, account, 'pong', { maxHops: 3 });

  let last = await platform.sending.send(account, { to: b.address, subject: 'ping', text: 'ping' }, a);
  let sender = b;
  let target = a;

  for (let i = 0; i < 2; i += 1) {
    last = await platform.sending.send(
      account,
      { to: target.address, subject: 'Re: ping', text: 'pong', inReplyTo: last.message.rfcMessageId },
      sender,
    );
    [sender, target] = [target, sender];
  }
  assert.equal(last.message.hops, 3);

  await assert.rejects(
    () =>
      platform.sending.send(
        account,
        { to: target.address, subject: 'Re: ping', text: 'pong', inReplyTo: last.message.rfcMessageId },
        sender,
      ),
    /automated hops/,
  );
});

test('inbox policy keeps unauthenticated strangers out', async () => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent } = await seedAgent(platform, account, 'private', { inboxPolicy: 'allowlist', allowlist: ['@partner.test'] });

  const raw = [
    'From: stranger@elsewhere.test',
    `To: ${agent.address}`,
    'Subject: Hello',
    '',
    'let me in',
  ].join('\r\n');

  const rejected = await platform.inbound.ingest({ raw, recipients: [agent.address] });
  assert.equal(rejected.delivered.length, 0);
  assert.match(rejected.rejected[0].reason, /allowlist/);

  const allowed = await platform.inbound.ingest({
    raw: raw.replace('stranger@elsewhere.test', 'bot@partner.test'),
    recipients: [agent.address],
  });
  assert.equal(allowed.delivered.length, 1);
});

test('long-poll wakes as soon as internal mail arrives', async () => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent: buyer } = await seedAgent(platform, account, 'buyer');
  const { agent: seller } = await seedAgent(platform, account, 'seller');

  const waiting = platform.mailbox.wait(seller, { timeoutSeconds: 5, claim: true });
  setTimeout(() => {
    void platform.sending.send(account, { to: seller.address, subject: 'Now', text: 'now' }, buyer);
  }, 10);

  const messages = await waiting;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].subject, 'Now');
  assert.equal(messages[0].mailboxState, 'claimed');
});
