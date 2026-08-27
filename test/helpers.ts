import { Platform } from '../src/platform.js';
import { StaticDnsResolver } from '../src/domain/dns.js';
import { MemoryProvider } from '../src/providers/memory.js';
import type { Account, Agent } from '../src/types.js';

export interface Harness {
  platform: Platform;
  provider: MemoryProvider;
}

export function newHarness(overrides: Partial<Harness> = {}): Harness {
  const provider = new MemoryProvider();
  const platform = new Platform({
    provider,
    dns: new StaticDnsResolver(),
    config: {
      platformDomain: 'agentmail.test',
      agentDomain: 'agents.agentmail.test',
      publicUrl: 'https://api.agentmail.test',
      initialDailySendLimit: 1000,
      secret: 'test-secret',
    },
    fetcher: async () => ({ ok: true, status: 200 }),
  });
  return { platform, provider, ...overrides };
}

/** Creates an account with a pre-verified sending domain. */
export async function seedAccount(
  platform: Platform,
  name: string,
  domain?: string,
): Promise<{ account: Account; apiKey: string }> {
  const { account } = await platform.accounts.createAccount({ name, ownerEmail: `owner@${name}.test` });
  if (domain) {
    const record = await platform.domains.add(account.id, domain);
    await platform.store.updateDomain(record.id, {
      status: 'verified',
      verifiedAt: new Date().toISOString(),
    });
  }
  const { secret } = await platform.accounts.createApiKey(account.id, 'default', 'full');
  return { account, apiKey: secret };
}

export async function seedAgent(
  platform: Platform,
  account: Account,
  slug: string,
  overrides: Partial<Parameters<Platform['agents']['create']>[1]> = {},
): Promise<{ agent: Agent; apiKey: string }> {
  const agent = await platform.agents.create(account, {
    slug,
    displayName: slug,
    inboxPolicy: 'open',
    ...overrides,
  });
  const { secret } = await platform.accounts.createApiKey(account.id, `${slug}-key`, 'agent', {
    agentId: agent.id,
  });
  return { agent, apiKey: secret };
}
