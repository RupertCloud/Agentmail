import type { Config } from '../config.js';
import { forbidden, unauthorized } from '../errors.js';
import type { SesControlPlane } from '../providers/control-plane.js';
import type { Store } from '../store/types.js';
import type { Account, Agent, ApiKey, Id, KeyScope, Role, User } from '../types.js';
import { generateApiKey, verifyApiKey } from '../util/crypto.js';
import { newId, slugify } from '../util/ids.js';
import { audit } from './audit.js';

export interface AuthContext {
  account: Account;
  key: ApiKey;
  /** Present when the key's scope is `agent`. */
  agent: Agent | null;
}

export interface CreateAccountInput {
  name: string;
  slug?: string;
  plan?: string;
  ownerEmail?: string;
}

export interface CreatedKey {
  key: ApiKey;
  /** Returned once, never stored (FR-3.2). */
  secret: string;
}

export class AccountService {
  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly ses: SesControlPlane,
  ) {}

  async createAccount(input: CreateAccountInput): Promise<{ account: Account; owner: User | null }> {
    const slug = slugify(input.slug ?? input.name);
    if (!slug) throw forbidden('An account needs a name that yields a usable slug.');
    if (await this.store.getAccountBySlug(slug)) {
      throw forbidden(`The account slug "${slug}" is taken.`);
    }

    // FR-1.3: the SES tenant is the isolation boundary, so it exists before the
    // account does. A failure here must not leave an account that cannot send.
    const tenantName = `t-${slug}`;
    await this.ses.createTenant(tenantName);

    const now = new Date().toISOString();
    const account = await this.store.createAccount({
      id: newId('acct'),
      slug,
      name: input.name,
      tenantName,
      status: 'active',
      plan: input.plan ?? 'free',
      dailySendLimit: this.config.initialDailySendLimit,
      createdAt: now,
    });

    let owner: User | null = null;
    if (input.ownerEmail) {
      owner = await this.store.createUser({
        id: newId('user'),
        accountId: account.id,
        email: input.ownerEmail.toLowerCase(),
        role: 'owner',
        createdAt: now,
      });
    }

    await this.store.appendAudit({
      id: newId('aud'),
      accountId: account.id,
      actor: input.ownerEmail ?? 'system',
      action: 'account.created',
      target: account.id,
      metadata: { slug },
      occurredAt: now,
    });

    return { account, owner };
  }

  async addUser(accountId: Id, email: string, role: Role): Promise<User> {
    return this.store.createUser({
      id: newId('user'),
      accountId,
      email: email.toLowerCase(),
      role,
      createdAt: new Date().toISOString(),
    });
  }

  async createApiKey(
    accountId: Id,
    name: string,
    scope: KeyScope,
    options: { agentId?: Id; domainId?: Id; environment?: string } = {},
  ): Promise<CreatedKey> {
    if (scope === 'agent' && !options.agentId) {
      throw forbidden('An agent-scoped key must name the agent it belongs to.');
    }
    const generated = generateApiKey(options.environment ?? 'live');
    const key = await this.store.createApiKey({
      id: newId('key'),
      accountId,
      name,
      prefix: generated.prefix,
      keyHash: generated.hash,
      scope,
      agentId: options.agentId ?? null,
      domainId: options.domainId ?? null,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date().toISOString(),
    });
    await audit(this.store, {
      accountId,
      actor: 'api',
      action: 'api_key.created',
      target: key.id,
      metadata: { scope, name, agent_id: options.agentId ?? null, domain_id: options.domainId ?? null },
    });
    return { key, secret: generated.secret };
  }

  async revokeApiKey(id: Id): Promise<ApiKey> {
    const key = await this.store.updateApiKey(id, { revokedAt: new Date().toISOString() });
    await audit(this.store, {
      accountId: key.accountId,
      actor: 'api',
      action: 'api_key.revoked',
      target: key.id,
      metadata: { name: key.name },
    });
    return key;
  }

  /** Resolves a bearer token to an account, key and (for agent keys) an agent. */
  async authenticate(secret: string | undefined | null): Promise<AuthContext> {
    if (!secret) throw unauthorized();
    const prefix = secret.slice(0, 12);
    const candidates = await this.store.findApiKeysByPrefix(prefix);
    const key = candidates.find((candidate) => verifyApiKey(secret, candidate.keyHash));
    if (!key) throw unauthorized();

    const account = await this.store.getAccount(key.accountId);
    if (!account) throw unauthorized();
    if (account.status === 'suspended') {
      throw forbidden('This account is suspended. Contact support.');
    }

    const agent = key.agentId ? await this.store.getAgent(key.agentId) : null;
    if (key.agentId && !agent) throw unauthorized();

    void this.store.updateApiKey(key.id, { lastUsedAt: new Date().toISOString() }).catch(() => {});
    return { account, key, agent };
  }
}

const SEND_SCOPES: KeyScope[] = ['full', 'send', 'agent'];
const READ_SCOPES: KeyScope[] = ['full', 'send', 'read', 'agent'];

export function requireSend(auth: AuthContext): void {
  if (!SEND_SCOPES.includes(auth.key.scope)) {
    throw forbidden(`This key has scope "${auth.key.scope}" and cannot send.`);
  }
  if (auth.account.status !== 'active') {
    throw forbidden(`This account is ${auth.account.status} and cannot send.`);
  }
}

export function requireRead(auth: AuthContext): void {
  if (!READ_SCOPES.includes(auth.key.scope)) {
    throw forbidden(`This key has scope "${auth.key.scope}" and cannot read.`);
  }
}

/** Management operations (keys, domains, agents, webhooks) need a full key. */
export function requireFull(auth: AuthContext): void {
  if (auth.key.scope !== 'full') {
    throw forbidden('This operation requires a key with scope "full".');
  }
}

/**
 * An agent-scoped key may only reach its own mailbox. This is the structural
 * containment NFR-3.4 asks for: the check is on the credential, not the caller.
 */
export function requireAgentAccess(auth: AuthContext, agentId: Id): void {
  if (auth.key.scope === 'agent' && auth.key.agentId !== agentId) {
    throw forbidden('This key is scoped to a different agent.');
  }
}
