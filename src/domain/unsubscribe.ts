import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Id } from '../types.js';

export interface UnsubscribeClaim {
  accountId: Id;
  listId: Id | null;
  email: string;
}

/**
 * Stateless unsubscribe tokens, so the link in a campaign keeps working after
 * the message log is aged out (FR-8.7, NFR-4.3).
 */
export function signUnsubscribe(secret: string, claim: UnsubscribeClaim): string {
  const payload = Buffer.from(
    JSON.stringify({ a: claim.accountId, l: claim.listId, e: claim.email.toLowerCase() }),
    'utf8',
  ).toString('base64url');
  const mac = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function verifyUnsubscribe(secret: string, token: string): UnsubscribeClaim | null {
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return null;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return { accountId: parsed.a, listId: parsed.l ?? null, email: parsed.e };
  } catch {
    return null;
  }
}
