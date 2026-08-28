import { randomBytes } from 'node:crypto';

/**
 * SES control plane — the resources that must exist in AWS before a message
 * can be sent, as distinct from the data plane that sends it.
 *
 * This is a separate port from `EmailProvider` on purpose: sending happens on
 * every message and must be fast, while provisioning happens once per account
 * or domain and is allowed to be slow and chatty.
 */

export interface CreatedIdentity {
  /** The three DKIM selectors AWS generates; these become the CNAME records. */
  dkimTokens: string[];
}

export interface IdentityStatus {
  dkimStatus: 'PENDING' | 'SUCCESS' | 'FAILED' | 'NOT_STARTED' | 'TEMPORARY_FAILURE' | 'UNKNOWN';
  verifiedForSending: boolean;
  mailFromStatus: string | null;
}

export interface SesControlPlane {
  readonly name: string;
  /** One SES tenant per account: the isolation boundary in SRS §3.1. */
  createTenant(tenantName: string): Promise<void>;
  deleteTenant(tenantName: string): Promise<void>;
  createConfigurationSet(configSetName: string): Promise<void>;
  /** Creates the domain identity with Easy DKIM at 2048 bits (DR-1). */
  createIdentity(domain: string, configSetName: string): Promise<CreatedIdentity>;
  /** Custom MAIL FROM subdomain, so SPF aligns for DMARC (DR-2). */
  setMailFrom(domain: string, mailFromDomain: string): Promise<void>;
  /** Binds an identity or configuration set to a tenant. */
  associateWithTenant(tenantName: string, resourceArn: string): Promise<void>;
  getIdentityStatus(domain: string): Promise<IdentityStatus>;
  deleteIdentity(domain: string): Promise<void>;
  /** ARN for a resource this control plane owns, for tenant association. */
  arnFor(kind: 'identity' | 'configuration-set', name: string): string;
  /** CNAME target a DKIM token points at. */
  dkimTarget(token: string): string;
}

/**
 * Development control plane. Generates plausible DKIM selectors locally so the
 * onboarding flow can be exercised end to end without an AWS account.
 *
 * The records it issues are deliberately not real: they point at the platform
 * domain and will never verify against live DNS. Anything relying on real
 * verification must run against `AwsControlPlane`.
 */
export class LocalControlPlane implements SesControlPlane {
  readonly name = 'local';

  constructor(private readonly platformDomain = 'agentmail.test') {}
  readonly tenants = new Set<string>();
  readonly identities = new Map<string, CreatedIdentity>();
  readonly configurationSets = new Set<string>();
  readonly associations: Array<{ tenantName: string; resourceArn: string }> = [];
  readonly mailFrom = new Map<string, string>();

  async createTenant(tenantName: string): Promise<void> {
    this.tenants.add(tenantName);
  }
  async deleteTenant(tenantName: string): Promise<void> {
    this.tenants.delete(tenantName);
  }
  async createConfigurationSet(configSetName: string): Promise<void> {
    this.configurationSets.add(configSetName);
  }
  async createIdentity(domain: string): Promise<CreatedIdentity> {
    const identity = { dkimTokens: Array.from({ length: 3 }, () => randomBytes(16).toString('hex')) };
    this.identities.set(domain, identity);
    return identity;
  }
  async setMailFrom(domain: string, mailFromDomain: string): Promise<void> {
    this.mailFrom.set(domain, mailFromDomain);
  }
  async associateWithTenant(tenantName: string, resourceArn: string): Promise<void> {
    this.associations.push({ tenantName, resourceArn });
  }
  async getIdentityStatus(domain: string): Promise<IdentityStatus> {
    return {
      dkimStatus: this.identities.has(domain) ? 'PENDING' : 'NOT_STARTED',
      verifiedForSending: false,
      mailFromStatus: this.mailFrom.get(domain) ?? null,
    };
  }
  async deleteIdentity(domain: string): Promise<void> {
    this.identities.delete(domain);
    this.mailFrom.delete(domain);
  }
  arnFor(kind: 'identity' | 'configuration-set', name: string): string {
    return `arn:aws:ses:local:000000000000:${kind}/${name}`;
  }
  dkimTarget(token: string): string {
    return `${token}.dkim.${this.platformDomain}`;
  }
}

/** Raised when a control-plane call fails, with the AWS error name preserved. */
export class ControlPlaneError extends Error {
  constructor(readonly operation: string, readonly awsErrorName: string, message: string) {
    super(`SES ${operation} failed (${awsErrorName}): ${message}`);
    this.name = 'ControlPlaneError';
  }
}

interface SesClientLike {
  send(command: unknown): Promise<Record<string, unknown>>;
}

type Ctor = new (input: unknown) => unknown;

/**
 * Real SESv2 control plane.
 *
 * `@aws-sdk/client-sesv2` is an optional dependency loaded on first use, so the
 * platform runs without it when configured for local development.
 */
export class AwsControlPlane implements SesControlPlane {
  readonly name = 'aws';
  private client: SesClientLike | null = null;
  private commands: Record<string, Ctor> = {};

  constructor(
    private readonly region: string,
    /** Needed to build resource ARNs; SES does not return them on create. */
    private readonly accountId: string,
  ) {}

  private async load(): Promise<void> {
    if (this.client) return;
    let sdk: Record<string, unknown>;
    try {
      const specifier = '@aws-sdk/client-sesv2';
      sdk = (await import(specifier)) as Record<string, unknown>;
    } catch {
      throw new ControlPlaneError(
        'load',
        'MissingDependency',
        'AGENTMAIL_PROVIDER=ses requires the optional dependency @aws-sdk/client-sesv2.',
      );
    }
    const ClientCtor = sdk.SESv2Client as new (config: unknown) => SesClientLike;
    this.client = new ClientCtor({ region: this.region });
    for (const name of [
      'CreateTenantCommand',
      'DeleteTenantCommand',
      'CreateConfigurationSetCommand',
      'CreateEmailIdentityCommand',
      'PutEmailIdentityMailFromAttributesCommand',
      'CreateTenantResourceAssociationCommand',
      'GetEmailIdentityCommand',
      'DeleteEmailIdentityCommand',
    ]) {
      this.commands[name] = sdk[name] as Ctor;
    }
  }

  private async call<T = Record<string, unknown>>(
    commandName: string,
    input: unknown,
    operation: string,
    /** AWS error names that mean "already in the desired state". */
    tolerate: string[] = [],
  ): Promise<T | null> {
    await this.load();
    const Command = this.commands[commandName];
    try {
      return (await this.client!.send(new Command(input))) as T;
    } catch (error) {
      const name = (error as { name?: string }).name ?? 'Unknown';
      if (tolerate.includes(name)) return null;
      throw new ControlPlaneError(operation, name, (error as Error).message ?? String(error));
    }
  }

  async createTenant(tenantName: string): Promise<void> {
    await this.call('CreateTenantCommand', { TenantName: tenantName }, 'CreateTenant', [
      'AlreadyExistsException',
    ]);
  }

  async deleteTenant(tenantName: string): Promise<void> {
    await this.call('DeleteTenantCommand', { TenantName: tenantName }, 'DeleteTenant', [
      'NotFoundException',
    ]);
  }

  async createConfigurationSet(configSetName: string): Promise<void> {
    await this.call(
      'CreateConfigurationSetCommand',
      {
        ConfigurationSetName: configSetName,
        // SES pauses a tenant on a high-severity reputation finding; this is
        // the per-tenant containment the SRS leans on (§3.1).
        ReputationOptions: { ReputationMetricsEnabled: true },
        SendingOptions: { SendingEnabled: true },
        SuppressionOptions: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] },
      },
      'CreateConfigurationSet',
      ['AlreadyExistsException'],
    );
  }

  async createIdentity(domain: string, configSetName: string): Promise<CreatedIdentity> {
    const response = await this.call<{ DkimAttributes?: { Tokens?: string[] } }>(
      'CreateEmailIdentityCommand',
      {
        EmailIdentity: domain,
        ConfigurationSetName: configSetName,
        DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
      },
      'CreateEmailIdentity',
      ['AlreadyExistsException'],
    );

    const tokens = response?.DkimAttributes?.Tokens;
    if (tokens?.length) return { dkimTokens: tokens };

    // The identity already existed; read its tokens rather than fail.
    const existing = await this.call<{ DkimAttributes?: { Tokens?: string[] } }>(
      'GetEmailIdentityCommand',
      { EmailIdentity: domain },
      'GetEmailIdentity',
    );
    const existingTokens = existing?.DkimAttributes?.Tokens;
    if (!existingTokens?.length) {
      throw new ControlPlaneError('CreateEmailIdentity', 'NoDkimTokens', `SES returned no DKIM tokens for ${domain}.`);
    }
    return { dkimTokens: existingTokens };
  }

  async setMailFrom(domain: string, mailFromDomain: string): Promise<void> {
    await this.call(
      'PutEmailIdentityMailFromAttributesCommand',
      {
        EmailIdentity: domain,
        MailFromDomain: mailFromDomain,
        // Reject rather than silently fall back to amazonses.com, which would
        // break SPF alignment without anyone noticing (DR-2).
        BehaviorOnMxFailure: 'REJECT_MESSAGE',
      },
      'PutEmailIdentityMailFromAttributes',
    );
  }

  async associateWithTenant(tenantName: string, resourceArn: string): Promise<void> {
    await this.call(
      'CreateTenantResourceAssociationCommand',
      { TenantName: tenantName, ResourceArn: resourceArn },
      'CreateTenantResourceAssociation',
      ['AlreadyExistsException'],
    );
  }

  async getIdentityStatus(domain: string): Promise<IdentityStatus> {
    const response = await this.call<{
      DkimAttributes?: { Status?: string };
      VerifiedForSendingStatus?: boolean;
      MailFromAttributes?: { MailFromDomainStatus?: string };
    }>('GetEmailIdentityCommand', { EmailIdentity: domain }, 'GetEmailIdentity', ['NotFoundException']);

    if (!response) return { dkimStatus: 'NOT_STARTED', verifiedForSending: false, mailFromStatus: null };
    return {
      dkimStatus: (response.DkimAttributes?.Status as IdentityStatus['dkimStatus']) ?? 'UNKNOWN',
      verifiedForSending: response.VerifiedForSendingStatus === true,
      mailFromStatus: response.MailFromAttributes?.MailFromDomainStatus ?? null,
    };
  }

  async deleteIdentity(domain: string): Promise<void> {
    await this.call('DeleteEmailIdentityCommand', { EmailIdentity: domain }, 'DeleteEmailIdentity', [
      'NotFoundException',
    ]);
  }

  arnFor(kind: 'identity' | 'configuration-set', name: string): string {
    return `arn:aws:ses:${this.region}:${this.accountId}:${kind}/${name}`;
  }
  dkimTarget(token: string): string {
    return `${token}.dkim.amazonses.com`;
  }
}
