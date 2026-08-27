import { Resolver } from 'node:dns/promises';

export interface MxRecord {
  exchange: string;
  priority: number;
}

/** Narrow DNS port, so verification logic is testable without live DNS. */
export interface DnsResolver {
  resolveCname(name: string): Promise<string[]>;
  resolveTxt(name: string): Promise<string[]>;
  resolveMx(name: string): Promise<MxRecord[]>;
}

export class SystemDnsResolver implements DnsResolver {
  private readonly resolver = new Resolver({ timeout: 5000, tries: 2 });

  async resolveCname(name: string): Promise<string[]> {
    return this.safe(() => this.resolver.resolveCname(name));
  }

  async resolveTxt(name: string): Promise<string[]> {
    const chunks = await this.safe(() => this.resolver.resolveTxt(name));
    return chunks.map((parts) => parts.join(''));
  }

  async resolveMx(name: string): Promise<MxRecord[]> {
    return this.safe(() => this.resolver.resolveMx(name));
  }

  /** A missing record is a normal state during verification, not an error. */
  private async safe<T>(fn: () => Promise<T[]>): Promise<T[]> {
    try {
      return await fn();
    } catch {
      return [];
    }
  }
}

export class StaticDnsResolver implements DnsResolver {
  constructor(
    private readonly records: {
      cname?: Record<string, string[]>;
      txt?: Record<string, string[]>;
      mx?: Record<string, MxRecord[]>;
    } = {},
  ) {}

  async resolveCname(name: string): Promise<string[]> {
    return this.records.cname?.[name.toLowerCase()] ?? [];
  }
  async resolveTxt(name: string): Promise<string[]> {
    return this.records.txt?.[name.toLowerCase()] ?? [];
  }
  async resolveMx(name: string): Promise<MxRecord[]> {
    return this.records.mx?.[name.toLowerCase()] ?? [];
  }
}
