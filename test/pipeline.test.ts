import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyWebhookSignature } from '../src/util/crypto.js';
import { newHarness, seedAccount } from './helpers.js';

test('the transactional queue always drains before the campaign queue', async () => {
  const { platform, provider } = newHarness();
  const { account } = await seedAccount(platform, 'acme', 'acme.test');

  await platform.sending.send(account, {
    from: 'news@acme.test',
    to: 'subscriber@example.test',
    subject: 'Monthly newsletter',
    html: '<p>news</p>',
    kind: 'campaign',
  });
  await platform.sending.send(account, {
    from: 'auth@acme.test',
    to: 'user@example.test',
    subject: 'Reset your password',
    html: '<p>reset</p>',
  });

  await platform.drain();
  assert.deepEqual(
    provider.sent.map((request) => request.destinations[0]),
    ['user@example.test', 'subscriber@example.test'],
    'the password reset must not queue behind the broadcast',
  );
});

test('a transient provider failure is retried, not lost', async () => {
  const { platform, provider } = newHarness();
  const { account } = await seedAccount(platform, 'acme', 'acme.test');
  provider.failCount = 2;
  provider.failRetryable = true;

  const { message } = await platform.sending.send(account, {
    from: 'auth@acme.test',
    to: 'user@example.test',
    subject: 'Retry me',
    text: 'hello',
  });

  // Two failures, then success; the backoff makes the retry visible later.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await platform.worker.runOnce(Date.now() + attempt * 60_000);
  }

  const final = await platform.store.getMessage(message.id);
  assert.equal(final?.status, 'sent');
  assert.equal(provider.sent.length, 1);
  assert.equal(platform.queues.transactional.deadLetters().length, 0);
});

test('a permanent provider failure lands in the dead letter queue and marks the message failed', async () => {
  const { platform, provider } = newHarness();
  const { account } = await seedAccount(platform, 'acme', 'acme.test');
  provider.failCount = 1;
  provider.failRetryable = false;

  const { message } = await platform.sending.send(account, {
    from: 'auth@acme.test',
    to: 'user@example.test',
    subject: 'Doomed',
    text: 'hello',
  });
  await platform.worker.runOnce();

  const final = await platform.store.getMessage(message.id);
  assert.equal(final?.status, 'failed');
  assert.match(final?.error ?? '', /injected provider failure/);
  assert.equal(platform.queues.transactional.deadLetters().length, 1);
});

test('suppressed recipients are dropped before the provider sees them', async () => {
  const { platform, provider } = newHarness();
  const { account } = await seedAccount(platform, 'acme', 'acme.test');
  await platform.suppression.add(account.id, 'gone@example.test', 'hard_bounce');

  const result = await platform.sending.send(account, {
    from: 'news@acme.test',
    to: ['gone@example.test'],
    subject: 'Hello again',
    text: 'hi',
  });

  assert.equal(result.message.status, 'skipped');
  assert.deepEqual(result.skipped, ['gone@example.test']);
  await platform.drain();
  assert.equal(provider.sent.length, 0);
});

test('hard bounces suppress immediately, soft bounces only on the third failure', async () => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme', 'acme.test');

  const send = async (to: string) => {
    const { message } = await platform.sending.send(account, {
      from: 'auth@acme.test',
      to,
      subject: 'Ping',
      text: 'ping',
    });
    await platform.drain();
    return (await platform.store.getMessage(message.id))!;
  };

  const hard = await send('nobody@example.test');
  await platform.delivery.ingestProviderEvent({
    providerMessageId: hard.providerMessageId!,
    type: 'bounce',
    bounceType: 'permanent',
  });
  assert.ok(await platform.suppression.isSuppressed(account.id, 'nobody@example.test'));

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const soft = await send('full-inbox@example.test');
    await platform.delivery.ingestProviderEvent({
      providerMessageId: soft.providerMessageId!,
      type: 'bounce',
      bounceType: 'transient',
    });
    const suppressed = await platform.suppression.isSuppressed(account.id, 'full-inbox@example.test');
    assert.equal(Boolean(suppressed), attempt === 3, `attempt ${attempt}`);
  }
});

test('complaint suppressions cannot be lifted', async () => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const entry = await platform.suppression.add(account.id, 'angry@example.test', 'complaint');
  await assert.rejects(() => platform.suppression.remove(account.id, entry.id), /cannot be removed/);

  const manual = await platform.suppression.add(account.id, 'oops@example.test', 'manual');
  await platform.suppression.remove(account.id, manual.id);
  assert.equal(await platform.suppression.isSuppressed(account.id, 'oops@example.test'), null);
});

test('an idempotency key collapses a retried send into one message', async () => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme', 'acme.test');

  const input = {
    from: 'auth@acme.test',
    to: 'user@example.test',
    subject: 'Only once',
    text: 'once',
    idempotencyKey: 'reset-42',
  };
  const first = await platform.sending.send(account, input);
  const second = await platform.sending.send(account, input);
  assert.equal(first.message.id, second.message.id);
});

test('the daily send limit blocks a new account before it can damage reputation', async () => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme', 'acme.test');
  await platform.store.updateAccount(account.id, { dailySendLimit: 2 });
  const limited = (await platform.store.getAccount(account.id))!;

  for (let i = 0; i < 2; i += 1) {
    await platform.sending.send(limited, {
      from: 'auth@acme.test',
      to: `user${i}@example.test`,
      subject: 'Ping',
      text: 'ping',
    });
  }
  await assert.rejects(
    () =>
      platform.sending.send(limited, {
        from: 'auth@acme.test',
        to: 'user3@example.test',
        subject: 'Ping',
        text: 'ping',
      }),
    /Daily sending limit/,
  );
});

test('a campaign excludes suppressed contacts and carries a working unsubscribe', async () => {
  const { platform, provider } = newHarness();
  const { account } = await seedAccount(platform, 'acme', 'acme.test');

  const list = await platform.lists.create(account.id, 'Announcements');
  const report = await platform.lists.import(account.id, list.id, [
    { email: 'a@example.test', name: 'A' },
    { email: 'b@example.test', name: 'B' },
    { email: 'a@example.test', name: 'duplicate' },
    { email: 'not-an-address', name: 'C' },
  ]);
  assert.equal(report.imported, 2);
  assert.equal(report.duplicates, 1);
  assert.equal(report.rejected.length, 1);

  await platform.suppression.add(account.id, 'b@example.test', 'complaint');

  const campaign = await platform.campaigns.create(account.id, {
    name: 'Launch',
    from: 'news@acme.test',
    subject: 'We launched',
    html: '<p>Hello {{name}}</p>',
    listIds: [list.id],
  });
  const { queued } = await platform.campaigns.send(account, campaign.id);
  assert.equal(queued, 1, 'the complained address must be excluded');

  await platform.drain();
  assert.equal(provider.sent.length, 1);
  assert.match(provider.sent[0].raw, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);

  const token = provider.sent[0].raw.match(/\/u\/([A-Za-z0-9_.\-]+)/)?.[1];
  assert.ok(token, 'the message must carry an unsubscribe token');

  const { verifyUnsubscribe } = await import('../src/domain/unsubscribe.js');
  const claim = verifyUnsubscribe(platform.config.secret, token!);
  assert.equal(claim?.email, 'a@example.test');
  assert.equal(claim?.listId, list.id);
  assert.equal(verifyUnsubscribe(platform.config.secret, `${token}x`), null, 'a tampered token is refused');
});

test('webhooks are delivered with a verifiable signature', async () => {
  const received: Array<{ body: string; signature: string }> = [];
  const { platform } = newHarness({
    fetcher: async (_url, init) => {
      received.push({ body: init.body, signature: init.headers['agentmail-signature'] });
      return { ok: true, status: 200 };
    },
  });

  const { account } = await seedAccount(platform, 'acme', 'acme.test');
  const webhook = await platform.webhooks.create(account.id, 'https://hooks.example.test/agentmail', [
    'accepted',
    'sent',
  ]);

  await platform.sending.send(account, {
    from: 'auth@acme.test',
    to: 'user@example.test',
    subject: 'Hook me',
    text: 'hi',
  });
  await platform.drain();

  assert.ok(received.length >= 2, 'accepted and sent should both fire');
  for (const delivery of received) {
    assert.ok(
      verifyWebhookSignature(webhook.secret, delivery.body, delivery.signature),
      'signature must verify against the endpoint secret',
    );
    assert.equal(verifyWebhookSignature('wrong-secret', delivery.body, delivery.signature), false);
  }
});
