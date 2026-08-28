import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRawMessage } from '../src/util/mime.js';
import { api, newHarness, seedAccount, seedAgent, startServer } from './helpers.js';
import type { Agent } from '../src/types.js';
import type { Platform } from '../src/platform.js';

/**
 * Delivers one ACCP message to `agent` under the given authentication verdicts
 * and returns the stored inbound message, so a test can vary exactly one of the
 * two integrity questions — is the sender who they claim, is the body intact.
 */
async function deliver(
  platform: Platform,
  agent: Agent,
  verdicts: Record<string, string>,
  overrides: Record<string, unknown> = {},
) {
  const raw = buildRawMessage({
    from: { email: 'buyer@partner.test' },
    to: [{ email: agent.address }],
    subject: 'Refund policy',
    text: 'Our refund window is 30 days.',
    structured: { refund_window_days: 30 },
    context: { principal: { type: 'organization', id: 'partner.test' } },
    messageId: `<${Math.random().toString(36).slice(2)}@partner.test>`,
    ...overrides,
  } as never);
  await platform.inbound.ingest({ raw, recipients: [agent.address], verdicts: verdicts as never });
  const [message] = await platform.mailbox.list(agent);
  return message;
}

async function harness() {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent } = await seedAgent(platform, account, 'support');
  return { platform, account, agent };
}

/* ------------------------------------------------------- the trust ladder */

test('a verified message under DKIM PASS is remembered as attested, and may be acted on', async () => {
  const { platform, agent } = await harness();
  const message = await deliver(platform, agent, { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' });
  assert.equal(message.payloadIntegrity, 'verified');

  const memory = await platform.memory.rememberFromMessage(agent, message, {
    key: 'policy.refund_window',
    value: 30,
    summary: 'Partner states a 30-day refund window.',
  });

  assert.equal(memory.trust, 'attested');
  assert.equal(platform.memory.mayActOn(memory), true);
  // The chain back to the wire is intact, not just a note that it was fine.
  assert.equal(memory.provenance.messageId, message.id);
  assert.equal(memory.provenance.rfcMessageId, message.rfcMessageId);
  assert.equal(memory.provenance.integrity, 'verified');
  assert.equal(memory.provenance.dkim, 'PASS');
  assert.equal(memory.provenance.assertedBy, 'partner.test');
  assert.ok(memory.provenance.contentDigest, 'the digest itself must be carried forward');
});

test('DMARC on SPF alone is authenticated, never attested — and must not be acted on', async () => {
  const { platform, agent } = await harness();
  // The sender is who they claim; nothing says the body is what they wrote.
  const message = await deliver(platform, agent, { spf: 'PASS', dkim: 'FAIL', dmarc: 'PASS' });

  const memory = await platform.memory.rememberFromMessage(agent, message, {
    key: 'policy.refund_window',
    value: 30,
  });

  assert.equal(memory.trust, 'authenticated');
  assert.equal(platform.memory.mayActOn(memory), false);
});

test('an unauthenticated message is only asserted', async () => {
  const { platform, agent } = await harness();
  const { account } = await seedAccount(platform, 'other');
  const { agent: open } = await seedAgent(platform, account, 'open', { inboxPolicy: 'open' });
  const message = await deliver(platform, open, { spf: 'FAIL', dkim: 'FAIL', dmarc: 'FAIL' });

  const memory = await platform.memory.rememberFromMessage(open, message, {
    key: 'policy.refund_window',
    value: 30,
  });

  assert.equal(memory.trust, 'asserted');
  assert.equal(platform.memory.mayActOn(memory), false);
  void agent;
});

/* ------------------------------------------- inference cannot launder trust */

test('an inference is never stronger than the weakest memory it came from', async () => {
  const { platform, agent } = await harness();
  const strong = await deliver(platform, agent, { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' });
  const attested = await platform.memory.rememberFromMessage(agent, strong, {
    key: 'fact.a',
    value: true,
  });
  assert.equal(attested.trust, 'attested');

  const weak = await platform.memory.remember(agent, {
    key: 'fact.b',
    value: true,
    origin: 'human',
    assertedBy: 'ada@acme.test',
  });
  assert.equal(weak.trust, 'authenticated');

  const conclusion = await platform.memory.remember(agent, {
    key: 'fact.conclusion',
    value: 'refund approved',
    origin: 'inference',
    derivedFrom: [attested.id, weak.id],
  });

  // Capped at `derived` regardless — combining knowledge does not create it.
  assert.equal(conclusion.trust, 'derived');
  assert.equal(platform.memory.mayActOn(conclusion), false);
});

test('an agent cannot promote its own belief by asserting a trust level', async () => {
  const { platform, agent } = await harness();
  // A caller-supplied `trust` is not part of the input type, and is ignored
  // even when forced through: trust is computed from provenance alone.
  const memory = await platform.memory.remember(agent, {
    key: 'policy.refund_window',
    value: 90,
    origin: 'seed',
    trust: 'attested',
  } as never);
  assert.equal(memory.trust, 'authenticated');
  assert.equal(platform.memory.mayActOn(memory), false);
});

test('an inference cannot cite another agent’s memory', async () => {
  const { platform, account, agent } = await harness();
  const { agent: other } = await seedAgent(platform, account, 'billing');
  const theirs = await platform.memory.remember(other, {
    key: 'fact.theirs',
    value: 1,
    origin: 'seed',
  });

  await assert.rejects(
    platform.memory.remember(agent, {
      key: 'fact.mine',
      value: 2,
      origin: 'inference',
      derivedFrom: [theirs.id],
    }),
    /unknown memory/,
  );
});

/* ------------------------------------------------- supersede, expire, forget */

test('a later fact supersedes the earlier one for the same key', async () => {
  const { platform, agent } = await harness();
  const first = await platform.memory.remember(agent, {
    key: 'policy.refund_window',
    value: 30,
    origin: 'seed',
  });
  const second = await platform.memory.remember(agent, {
    key: 'policy.refund_window',
    value: 14,
    origin: 'seed',
  });

  assert.equal(second.supersedes, first.id);
  const live = await platform.memory.recall(agent, { key: 'policy.refund_window' });
  assert.equal(live.length, 1);
  assert.equal(live[0].value, 14);

  // The superseded row is still there for the audit, just not recalled.
  const all = await platform.memory.recall(agent, {
    key: 'policy.refund_window',
    includeSuperseded: true,
  });
  assert.equal(all.length, 2);
});

test('expired memory is not recalled and cannot be acted on', async () => {
  const { platform, agent } = await harness();
  const memory = await platform.memory.remember(agent, {
    key: 'quote.valid',
    value: 500,
    origin: 'seed',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });

  assert.equal(platform.memory.mayActOn(memory), false);
  assert.deepEqual(await platform.memory.recall(agent, { key: 'quote.valid' }), []);
  const withExpired = await platform.memory.recall(agent, {
    key: 'quote.valid',
    includeExpired: true,
  });
  assert.equal(withExpired.length, 1);
});

test('forget tombstones but keeps the record; purge removes it', async () => {
  const { platform, agent } = await harness();
  const memory = await platform.memory.remember(agent, {
    key: 'fact.x',
    value: 1,
    origin: 'seed',
  });

  const forgotten = await platform.memory.forget(agent, memory.id, 'retracted by sender');
  assert.ok(forgotten.revokedAt);
  assert.equal(forgotten.revokedReason, 'retracted by sender');
  assert.deepEqual(await platform.memory.recall(agent, { key: 'fact.x' }), []);
  // Still retrievable by id, so an audit can explain what was believed and when.
  assert.ok(await platform.memory.get(agent, memory.id));

  await platform.memory.purge(agent, memory.id);
  await assert.rejects(platform.memory.get(agent, memory.id), /not found|Memory/i);
});

test('min_trust filters recall to what is strong enough', async () => {
  const { platform, agent } = await harness();
  const message = await deliver(platform, agent, { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' });
  await platform.memory.rememberFromMessage(agent, message, { key: 'strong', value: 1 });
  await platform.memory.remember(agent, { key: 'weak', value: 2, origin: 'seed' });

  const acted = await platform.memory.recall(agent, { minTrust: 'attested' });
  assert.deepEqual(acted.map((m) => m.key), ['strong']);
  const all = await platform.memory.recall(agent, {});
  assert.equal(all.length, 2);
});

test('one agent cannot read or forget another agent’s memory', async () => {
  const { platform, account, agent } = await harness();
  const { agent: other } = await seedAgent(platform, account, 'billing');
  const memory = await platform.memory.remember(agent, {
    key: 'fact.private',
    value: 'secret',
    origin: 'seed',
  });

  await assert.rejects(platform.memory.get(other, memory.id), /another agent/);
  await assert.rejects(platform.memory.forget(other, memory.id), /another agent/);
  assert.deepEqual(await platform.memory.recall(other, {}), []);
});

test('a memory cannot be built from a message in another mailbox', async () => {
  const { platform, account, agent } = await harness();
  const { agent: other } = await seedAgent(platform, account, 'billing');
  const message = await deliver(platform, agent, { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' });

  await assert.rejects(
    platform.memory.rememberFromMessage(other, message, { key: 'stolen', value: 1 }),
    /another mailbox/,
  );
});

/* ------------------------------------------------------- over the HTTP API */

test('the API derives trust from the named message, not from what the caller claims', async (t) => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent, apiKey } = await seedAgent(platform, account, 'support');
  const server = await startServer(platform);
  t.after(async () => {
    await server.close();
    await platform.close();
  });

  // Authenticated sender, broken DKIM: the strongest this can ever become is
  // `authenticated`, whatever the caller puts in the request body.
  const message = await deliver(platform, agent, { spf: 'PASS', dkim: 'FAIL', dmarc: 'PASS' });

  const created = await api(server.baseUrl, apiKey, 'POST', `/v1/agents/me/memory`, {
    key: 'policy.refund_window',
    value: 30,
    origin: 'message',
    message_id: message.id,
    // All three are ignored — the platform reads the verdict off the message.
    trust: 'attested',
    provenance: { origin: 'message', integrity: 'verified', dkim: 'PASS' },
    integrity: 'verified',
  });

  assert.equal(created.status, 201);
  assert.equal(created.json.trust, 'authenticated');
  assert.equal(created.json.provenance.dkim, 'FAIL');
  assert.equal(created.json.provenance.integrity, 'verified');

  const read = await api(server.baseUrl, apiKey, 'GET', `/v1/agents/me/memory/${created.json.id}`);
  assert.equal(read.json.may_act_on, false);
});

test('the API refuses a memory citing a message the agent does not own', async (t) => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent } = await seedAgent(platform, account, 'support');
  const { apiKey: otherKey } = await seedAgent(platform, account, 'billing');
  const server = await startServer(platform);
  t.after(async () => {
    await server.close();
    await platform.close();
  });

  const message = await deliver(platform, agent, { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' });
  const refused = await api(server.baseUrl, otherKey, 'POST', '/v1/agents/me/memory', {
    key: 'stolen',
    value: 1,
    origin: 'message',
    message_id: message.id,
  });
  assert.ok(refused.status >= 400, `expected a refusal, got ${refused.status}`);
});
