import { randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { Store } from '../store/types.js';
import type { DnsRecord, Domain, Id } from '../types.js';
import { newId } from '../util/ids.js';
import type { DnsResolver } from './dns.js';

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;

export class DomainService {
  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly dns: DnsResolver,
  ) {}

  async add(accountId: Id, input: string): Promise<Domain> {
    const domain = input.trim().toLowerCase().replace(/\.$/, '');
    if (!DOMAIN_RE.test(domain)) throw badRequest('That is not a valid domain name.', 'domain');
    if (await this.store.findDomain(accountId, domain)) {
      throw conflict(`Domain ${domain} is already registered on this account.`);
    }

    const mailFromSubdomain = `mail.${domain}`;
    const tokens = Array.from({ length: 3 }, () => randomBytes(16).toString('hex'));

    const records: DnsRecord[] = [
      ...tokens.map<DnsRecord>((token) => ({
        type: 'CNAME',
        name: `${token}._domainkey.${domain}`,
        value: `${token}.dkim.${this.config.platformDomain}`,
        purpose: 'dkim',
        status: 'pending',
      })),
      {
        type: 'MX',
        name: mailFromSubdomain,
        value: `feedback-smtp.${this.config.awsRegion}.amazonses.com`,
        priority: 10,
        purpose: 'mail_from',
        status: 'pending',
      },
      {
        type: 'TXT',
        name: mailFromSubdomain,
        value: 'v=spf1 include:amazonses.com ~all',
        purpose: 'mail_from',
        status: 'pending',
      },
      {
        type: 'TXT',
        name: domain,
        value: 'v=spf1 include:amazonses.com ~all',
        purpose: 'spf',
        status: 'pending',
      },
    ];

    return this.store.createDomain({
      id: newId('dom'),
      accountId,
      domain,
      mailFromSubdomain,
      configSetName: `cs-${domain.replace(/[^a-z0-9]/g, '-')}`,
      status: 'pending',
      records,
      warnings: [],
      verifiedAt: null,
      createdAt: new Date().toISOString(),
    });
  }

  async get(accountId: Id, id: Id): Promise<Domain> {
    const domain = await this.store.getDomain(id);
    if (!domain || domain.accountId !== accountId) throw notFound('Domain');
    return domain;
  }

  async list(accountId: Id): Promise<Domain[]> {
    return this.store.listDomains(accountId);
  }

  async remove(accountId: Id, id: Id): Promise<void> {
    await this.get(accountId, id);
    await this.store.deleteDomain(id);
  }

  /**
   * Re-checks every published record and re-runs the deliverability
   * diagnostics. A domain is verified once all three DKIM CNAMEs and the
   * MAIL FROM MX resolve (DR-1, DR-2).
   */
  async verify(accountId: Id, id: Id): Promise<Domain> {
    const domain = await this.get(accountId, id);
    const records: DnsRecord[] = [];

    for (const record of domain.records) {
      records.push({ ...record, status: (await this.check(record)) ? 'verified' : 'pending' });
    }

    const required = records.filter((r) => r.purpose === 'dkim' || (r.purpose === 'mail_from' && r.type === 'MX'));
    const verified = required.every((r) => r.status === 'verified');
    const warnings = await this.diagnose(domain, records);

    return this.store.updateDomain(id, {
      records,
      warnings,
      status: verified ? 'verified' : 'pending',
      verifiedAt: verified ? domain.verifiedAt ?? new Date().toISOString() : null,
    });
  }

  private async check(record: DnsRecord): Promise<boolean> {
    if (record.type === 'CNAME') {
      const values = await this.dns.resolveCname(record.name);
      return values.some((value) => value.toLowerCase().replace(/\.$/, '') === record.value.toLowerCase());
    }
    if (record.type === 'MX') {
      const values = await this.dns.resolveMx(record.name);
      return values.some((mx) => mx.exchange.toLowerCase().replace(/\.$/, '') === record.value.toLowerCase());
    }
    const values = await this.dns.resolveTxt(record.name);
    return values.some((value) => value.trim() === record.value);
  }

  /**
   * The three misconfigurations that silently destroy delivery (FR-2.4, DR-3):
   * a strict DMARC policy with nothing aligned to satisfy it, more than one SPF
   * record, and a MAIL FROM subdomain with no MX.
   */
  private async diagnose(domain: Domain, records: DnsRecord[]): Promise<string[]> {
    const warnings: string[] = [];

    const dmarc = (await this.dns.resolveTxt(`_dmarc.${domain.domain}`)).find((v) =>
      v.toLowerCase().startsWith('v=dmarc1'),
    );
    const policy = dmarc?.match(/\bp\s*=\s*(none|quarantine|reject)/i)?.[1]?.toLowerCase();
    const dkimReady = records.filter((r) => r.purpose === 'dkim').every((r) => r.status === 'verified');
    const mailFromReady = records
      .filter((r) => r.purpose === 'mail_from')
      .every((r) => r.status === 'verified');

    if (policy && policy !== 'none' && !dkimReady && !mailFromReady) {
      warnings.push(
        `DMARC policy is p=${policy} but neither DKIM nor an aligned MAIL FROM is in place yet. ` +
          'Mail sent now will be quarantined or rejected. Publish the DKIM records first.',
      );
    }

    const spfRecords = (await this.dns.resolveTxt(domain.domain)).filter((v) =>
      v.toLowerCase().startsWith('v=spf1'),
    );
    if (spfRecords.length > 1) {
      warnings.push(
        `${spfRecords.length} SPF records found on ${domain.domain}. RFC 7208 permits exactly one; ` +
          'merge them into a single record or SPF fails outright.',
      );
    }

    const mx = await this.dns.resolveMx(domain.mailFromSubdomain);
    if (!mx.length) {
      warnings.push(
        `No MX record on ${domain.mailFromSubdomain}. Without it the custom MAIL FROM does not work, ` +
          'so SPF cannot align for DMARC.',
      );
    }

    return warnings;
  }
}
