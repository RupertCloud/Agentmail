import assert from 'node:assert/strict';
import test from 'node:test';
import { StaticDnsResolver } from '../src/domain/dns.js';
import { Platform } from '../src/platform.js';
import { AwsControlPlane, LocalControlPlane } from '../src/providers/control-plane.js';
import { MemoryProvider } from '../src/providers/memory.js';

function harness() {
  const controlPlane = new LocalControlPlane('agentmail.test');
  const platform = new Platform({
    provider: new MemoryProvider(),
    controlPlane,
    dns: new StaticDnsResolver(),
    config: {
      platformDomain: 'agentmail.test',
      agentDomain: 'agents.agentmail.test',
      awsRegion: 'eu-west-1',
      awsAccountId: '123456789012',
      secret: 'test-secret',
    },
  });
  return { platform, controlPlane };
}

test('creating an account provisions its SES tenant', async () => {
  const { platform, controlPlane } = harness();
  const { account } = await platform.accounts.createAccount({ name: 'Acme' });

  assert.equal(account.tenantName, 't-acme');
  assert.ok(controlPlane.tenants.has('t-acme'), 'the tenant must exist before the account can send');
});

test('adding a domain provisions the identity and returns the DKIM tokens SES generated', async () => {
  const { platform, controlPlane } = harness();
  const { account } = await platform.accounts.createAccount({ name: 'Acme' });
  const domain = await platform.domains.add(account.id, 'acme.test');

  // The tokens in the records must be the ones the control plane issued —
  // locally-invented selectors could never verify against real SES.
  const issued = controlPlane.identities.get('acme.test');
  assert.ok(issued);
  const dkim = domain.records.filter((record) => record.purpose === 'dkim');
  assert.equal(dkim.length, 3);
  for (const [index, record] of dkim.entries()) {
    assert.equal(record.name, `${issued.dkimTokens[index]}._domainkey.acme.test`);
    assert.equal(record.value, `${issued.dkimTokens[index]}.dkim.agentmail.test`);
  }

  assert.equal(controlPlane.mailFrom.get('acme.test'), 'mail.acme.test');
  assert.ok(controlPlane.configurationSets.has(domain.configSetName));

  // Both the identity and the configuration set are bound to the tenant, which
  // is what makes SES refuse a cross-tenant send.
  const associated = controlPlane.associations
    .filter((entry) => entry.tenantName === 't-acme')
    .map((entry) => entry.resourceArn);
  assert.ok(associated.some((arn) => arn.endsWith('identity/acme.test')));
  assert.ok(associated.some((arn) => arn.endsWith(`configuration-set/${domain.configSetName}`)));
});

test('removing a domain tears down the SES identity', async () => {
  const { platform, controlPlane } = harness();
  const { account } = await platform.accounts.createAccount({ name: 'Acme' });
  const domain = await platform.domains.add(account.id, 'acme.test');
  assert.ok(controlPlane.identities.has('acme.test'));

  await platform.domains.remove(account.id, domain.id);
  assert.equal(controlPlane.identities.has('acme.test'), false);
});

test('the AWS control plane builds the ARNs SES needs for tenant association', () => {
  const aws = new AwsControlPlane('eu-west-1', '123456789012');
  assert.equal(
    aws.arnFor('identity', 'acme.com'),
    'arn:aws:ses:eu-west-1:123456789012:identity/acme.com',
  );
  assert.equal(
    aws.arnFor('configuration-set', 'cs-acme-com'),
    'arn:aws:ses:eu-west-1:123456789012:configuration-set/cs-acme-com',
  );
  // Real Easy DKIM CNAMEs point at amazonses.com, not at the platform domain.
  assert.equal(aws.dkimTarget('abc123'), 'abc123.dkim.amazonses.com');
});

test('verification reports SES status, not just DNS', async () => {
  const { platform } = harness();
  const { account } = await platform.accounts.createAccount({ name: 'Acme' });
  const domain = await platform.domains.add(account.id, 'acme.test');

  // Nothing published yet: every record stays pending.
  const unpublished = await platform.domains.verify(account.id, domain.id);
  assert.equal(unpublished.status, 'pending');
  assert.ok(unpublished.records.every((record) => record.status === 'pending'));
  assert.ok(
    unpublished.warnings.some((warning) => /No MX record/.test(warning)),
    'a missing MAIL FROM MX must be called out',
  );
});
