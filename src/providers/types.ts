import type { Address } from '../types.js';

export interface ProviderSendRequest {
  /** SES tenant name; the isolation boundary described in SRS §3.1. */
  tenantName: string;
  configSetName?: string | null;
  from: Address;
  /** Envelope recipients: to + cc + bcc, already expanded. */
  destinations: string[];
  /** Complete RFC 5322 message. */
  raw: string;
  tags: Record<string, string>;
}

export interface ProviderSendResult {
  providerMessageId: string;
}

/** A transient failure is retried by the worker; a permanent one is not. */
export class ProviderError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = retryable;
  }
}

export interface EmailProvider {
  readonly name: string;
  send(request: ProviderSendRequest): Promise<ProviderSendResult>;
}
