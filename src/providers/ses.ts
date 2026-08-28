import type { EmailProvider, ProviderSendRequest, ProviderSendResult } from './types.js';
import { ProviderError } from './types.js';

/** SES error codes worth another attempt rather than a permanent failure. */
const RETRYABLE = new Set([
  'Throttling',
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceUnavailable',
  'InternalFailure',
  'RequestTimeout',
  'LimitExceededException',
]);

interface SesClientLike {
  send(command: unknown): Promise<{ MessageId?: string }>;
}

/**
 * SESv2 adapter. `@aws-sdk/client-sesv2` is an optional dependency, imported
 * lazily so the platform runs with the memory provider without it installed.
 */
export class SesProvider implements EmailProvider {
  readonly name = 'ses';
  private client: SesClientLike | null = null;
  private commandCtor: (new (input: unknown) => unknown) | null = null;

  constructor(private readonly region: string) {}

  private async load(): Promise<void> {
    if (this.client) return;
    let sdk: Record<string, unknown>;
    try {
      // Indirect specifier: keeps the optional dependency out of the build graph.
      const specifier = '@aws-sdk/client-sesv2';
      sdk = (await import(specifier)) as Record<string, unknown>;
    } catch {
      throw new ProviderError(
        'AGENTMAIL_PROVIDER=ses requires the optional dependency @aws-sdk/client-sesv2.',
        false,
      );
    }
    const ClientCtor = sdk.SESv2Client as new (config: unknown) => SesClientLike;
    this.commandCtor = sdk.SendEmailCommand as new (input: unknown) => unknown;
    this.client = new ClientCtor({ region: this.region });
  }

  async send(request: ProviderSendRequest): Promise<ProviderSendResult> {
    await this.load();
    const Command = this.commandCtor!;
    const command = new Command({
      // Tenant scoping: SES validates the identity, configuration set and
      // template against this tenant and rejects the send otherwise.
      TenantName: request.tenantName,
      ConfigurationSetName: request.configSetName ?? undefined,
      FromEmailAddress: request.from.email,
      Destination: { ToAddresses: request.destinations },
      Content: { Raw: { Data: Buffer.from(request.raw, 'utf8') } },
      EmailTags: Object.entries(request.tags).map(([Name, Value]) => ({ Name, Value })),
    });

    try {
      const response = await this.client!.send(command);
      return { providerMessageId: response.MessageId ?? '' };
    } catch (error) {
      const name = (error as { name?: string }).name ?? 'Unknown';
      const message = (error as Error).message ?? String(error);
      throw new ProviderError(`SES ${name}: ${message}`, RETRYABLE.has(name));
    }
  }
}
