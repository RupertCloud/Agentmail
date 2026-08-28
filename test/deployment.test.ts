import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { configWarnings } from '../src/deployment.js';

const base = (overrides: Record<string, string> = {}) =>
  loadConfig({
    AGENTMAIL_SECRET: 'a-real-secret',
    AGENTMAIL_DOMAIN: 'agentmail.example.com',
    ...overrides,
  } as NodeJS.ProcessEnv);

test('a fully configured deployment warns about nothing', () => {
  const config = { ...base(), store: 'postgres' as const };
  assert.deepEqual(configWarnings(config, 'ses'), []);
});

test('an unset secret, a volatile store and a silent provider each warn', () => {
  const config = base({ AGENTMAIL_SECRET: '' });
  const warnings = configWarnings(config, 'memory');
  assert.ok(warnings.some((w) => /AGENTMAIL_SECRET/.test(w)));
  assert.ok(warnings.some((w) => /in-memory: all accounts/.test(w)));
  assert.ok(warnings.some((w) => /never sent/.test(w)));
});

test('agent addresses under a reserved TLD are called out', () => {
  // This is the state the live deployment was in: AGENTMAIL_DOMAIN unset, so
  // every agent got an address under .test, which cannot resolve.
  for (const tld of ['test', 'example', 'invalid', 'localhost', 'local']) {
    const config = base({ AGENTMAIL_DOMAIN: `agentmail.${tld}` });
    const warnings = configWarnings({ ...config, store: 'postgres' }, 'ses');
    assert.equal(warnings.length, 1, `.${tld} should warn`);
    assert.match(warnings[0], new RegExp(`\\.${tld}, a reserved TLD`));
    assert.match(warnings[0], /AGENTMAIL_DOMAIN/);
  }
});

test('a real domain does not warn, and an explicit agent domain is respected', () => {
  const config = {
    ...base({ AGENTMAIL_AGENT_DOMAIN: 'bots.acme.co.uk' }),
    store: 'postgres' as const,
  };
  assert.deepEqual(configWarnings(config, 'ses'), []);
});

test('an empty or whitespace-only secret counts as unset', () => {
  // A dashboard field left blank, or AGENTMAIL_SECRET=$SOME_UNSET_VAR, must not
  // enable ingest with an empty HMAC key.
  for (const value of ['', '   ', '\t\n']) {
    const config = loadConfig({ AGENTMAIL_SECRET: value } as NodeJS.ProcessEnv);
    assert.equal(config.secretIsDefault, true, `"${value}" should count as unset`);
    assert.notEqual(config.secret, '', 'the signing key must never be empty');
  }

  const real = loadConfig({ AGENTMAIL_SECRET: '  a-real-secret  ' } as NodeJS.ProcessEnv);
  assert.equal(real.secretIsDefault, false);
  assert.equal(real.secret, 'a-real-secret', 'surrounding whitespace is trimmed');
});
