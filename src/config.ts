export interface Config {
  host: string;
  port: number;
  /** Root domain the platform itself owns. */
  platformDomain: string;
  /** Domain under which hosted agent mailboxes are allocated. */
  agentDomain: string;
  /** Public base URL, used for tracking, unsubscribe and webhook links. */
  publicUrl: string;
  store: 'memory' | 'postgres';
  databaseUrl?: string;
  provider: 'memory' | 'ses';
  awsRegion: string;
  /** AWS account id; SES does not return ARNs on create, so they are built. */
  awsAccountId: string;
  /** Default automated-reply hop ceiling for new agents. */
  defaultMaxHops: number;
  /** Default per-thread ceiling in messages per minute for new agents. */
  defaultMaxThreadRate: number;
  /** Maximum ACCP delegation depth an outbound message may declare. */
  maxDelegationDepth: number;
  /** How long a claimed mailbox message stays leased, in seconds. */
  leaseSeconds: number;
  /** Ceiling on long-poll duration, in seconds. */
  maxWaitSeconds: number;
  /** Sending limit granted to a brand-new account (FR-12.1). */
  initialDailySendLimit: number;
  /** Worker retry ceiling before a message lands in the dead letter queue. */
  maxSendAttempts: number;
  /** HMAC secret for unsubscribe tokens and ingest authentication. */
  secret: string;
  /**
   * True when no secret was configured and the published default is in use.
   * The default is in the repository, so anything it guards is guarded by
   * nothing at all.
   */
  secretIsDefault: boolean;
}

export const DEFAULT_SECRET = 'development-secret-do-not-use-in-production';

function int(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const platformDomain = env.AGENTMAIL_DOMAIN ?? 'agentmail.test';
  const configuredSecret = env.AGENTMAIL_SECRET?.trim();
  const port = int(env.PORT, 8080);
  return {
    host: env.HOST ?? '0.0.0.0',
    port,
    platformDomain,
    agentDomain: env.AGENTMAIL_AGENT_DOMAIN ?? `agents.${platformDomain}`,
    publicUrl: env.AGENTMAIL_PUBLIC_URL ?? `http://localhost:${port}`,
    store: env.AGENTMAIL_STORE === 'postgres' ? 'postgres' : 'memory',
    databaseUrl: env.DATABASE_URL,
    provider: env.AGENTMAIL_PROVIDER === 'ses' ? 'ses' : 'memory',
    awsRegion: env.AWS_REGION ?? 'eu-west-1',
    awsAccountId: env.AWS_ACCOUNT_ID ?? '000000000000',
    defaultMaxHops: int(env.AGENTMAIL_MAX_HOPS, 10),
    defaultMaxThreadRate: int(env.AGENTMAIL_MAX_THREAD_RATE, 30),
    maxDelegationDepth: int(env.AGENTMAIL_MAX_DELEGATION_DEPTH, 5),
    leaseSeconds: int(env.AGENTMAIL_LEASE_SECONDS, 60),
    maxWaitSeconds: int(env.AGENTMAIL_MAX_WAIT_SECONDS, 60),
    initialDailySendLimit: int(env.AGENTMAIL_INITIAL_DAILY_LIMIT, 100),
    maxSendAttempts: int(env.AGENTMAIL_MAX_SEND_ATTEMPTS, 5),
    secret: configuredSecret || DEFAULT_SECRET,
    // Derived from the value, not from whether the variable was set, so
    // explicitly configuring the published default is caught too. An empty or
    // whitespace-only value counts as unset: a dashboard field left blank, or
    // `AGENTMAIL_SECRET=$UNSET_VAR`, must not enable ingest with an empty key.
    secretIsDefault: !configuredSecret || configuredSecret === DEFAULT_SECRET,
  };
}
