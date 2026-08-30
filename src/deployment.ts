import type { Config } from './config.js';

/**
 * Reserved and special-use top-level domains (RFC 2606, RFC 6761, RFC 6762).
 * None of them resolve on the public internet, so mail addressed under one can
 * never leave or arrive.
 */
const UNROUTABLE_TLDS = ['test', 'example', 'invalid', 'localhost', 'local'];

/**
 * Configuration that is fine on a laptop and wrong on a deployment anyone else
 * can reach. Surfaced on /health and written to stderr at startup, so a
 * misconfigured service says so rather than looking healthy.
 */
export function configWarnings(config: Config, providerName: string): string[] {
  const warnings: string[] = [];

  if (config.secretIsDefault) {
    warnings.push('AGENTMAIL_SECRET is unset; inbound and event ingest are disabled.');
  }
  if (config.store === 'memory') {
    warnings.push('Store is in-memory: all accounts, mailboxes and messages are lost on restart.');
  }
  if (providerName === 'memory') {
    warnings.push('Provider is in-memory: accepted messages are recorded but never sent.');
  }

  const tld = config.agentDomain.split('.').pop()?.toLowerCase() ?? '';
  if (UNROUTABLE_TLDS.includes(tld)) {
    warnings.push(
      `Agent addresses are issued under .${tld}, a reserved TLD that does not resolve. ` +
        'Agents can still reach each other internally, but no mail can enter or leave. ' +
        'Set AGENTMAIL_DOMAIN to a domain you control.',
    );
  }

  return warnings;
}
