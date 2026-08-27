import { forbidden, notFound } from '../errors.js';
import type { Store } from '../store/types.js';
import type { Id, Suppression, SuppressionReason } from '../types.js';
import { newId } from '../util/ids.js';
import { audit } from './audit.js';

/** Complaint suppressions are permanent and cannot be lifted (FR-7.6). */
const IRREVERSIBLE: SuppressionReason[] = ['complaint', 'hard_bounce'];

export class SuppressionService {
  constructor(private readonly store: Store) {}

  async add(
    accountId: Id,
    email: string,
    reason: SuppressionReason,
    options: { listId?: Id | null; note?: string } = {},
  ): Promise<Suppression> {
    return this.store.addSuppression({
      id: newId('sup'),
      accountId,
      email: email.toLowerCase(),
      reason,
      listId: options.listId ?? null,
      note: options.note ?? null,
      createdAt: new Date().toISOString(),
    });
  }

  async isSuppressed(accountId: Id, email: string): Promise<Suppression | null> {
    return this.store.findSuppression(accountId, email);
  }

  async list(accountId: Id): Promise<Suppression[]> {
    return this.store.listSuppressions(accountId);
  }

  async remove(accountId: Id, id: Id): Promise<void> {
    const entries = await this.store.listSuppressions(accountId);
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) throw notFound('Suppression');
    if (IRREVERSIBLE.includes(entry.reason)) {
      throw forbidden(`A ${entry.reason} suppression cannot be removed.`);
    }
    await this.store.deleteSuppression(id);
    await audit(this.store, {
      accountId,
      actor: 'api',
      action: 'suppression.removed',
      target: id,
      metadata: { email: entry.email, reason: entry.reason },
    });
  }
}
