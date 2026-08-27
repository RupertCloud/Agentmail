import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_BYTES = 24;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

export interface GeneratedKey {
  /** Shown to the caller exactly once. */
  secret: string;
  /** Non-secret display prefix. */
  prefix: string;
  hash: string;
}

/**
 * API keys are stored as salted scrypt hashes (NFR-3.2). The plaintext is
 * returned once and never persisted.
 */
export function generateApiKey(environment = 'live'): GeneratedKey {
  const body = randomBytes(KEY_BYTES).toString('base64url');
  const secret = `am_${environment}_${body}`;
  return { secret, prefix: secret.slice(0, 12), hash: hashApiKey(secret) };
}

export function hashApiKey(secret: string, salt?: Buffer): string {
  const s = salt ?? randomBytes(SALT_BYTES);
  const derived = scryptSync(secret, s, HASH_BYTES);
  return `scrypt$${s.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyApiKey(secret: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = scryptSync(secret, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Webhook signature: `t=<unix>,v1=<hex hmac of "t.body">` (NFR-3.5). */
export function signWebhook(secret: string, body: string, timestamp: number): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  toleranceSeconds = 300,
  now = Date.now(),
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((pair) => {
      const idx = pair.indexOf('=');
      return [pair.slice(0, idx).trim(), pair.slice(idx + 1).trim()];
    }),
  );
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const provided = String(parts.v1 ?? '');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}
