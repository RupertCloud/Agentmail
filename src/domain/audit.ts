import type { Store } from '../store/types.js';
import type { AuditEntry, Id } from '../types.js';
import { newId } from '../util/ids.js';

/**
 * Append-only record of administrative and policy actions (FR-12.8). Writing
 * an entry must never fail the operation it describes, so callers do not await
 * a rollback path — but the write itself is awaited so ordering holds.
 */
export async function audit(
  store: Store,
  entry: {
    accountId?: Id | null;
    actor: string;
    action: string;
    target: string;
    metadata?: Record<string, unknown>;
  },
): Promise<AuditEntry | null> {
  try {
    return await store.appendAudit({
      id: newId('aud'),
      accountId: entry.accountId ?? null,
      actor: entry.actor,
      action: entry.action,
      target: entry.target,
      metadata: entry.metadata ?? {},
      occurredAt: new Date().toISOString(),
    });
  } catch {
    return null;
  }
}
