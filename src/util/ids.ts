import { randomBytes, randomUUID } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Prefixed, sortable-enough identifier: `msg_01j8x...`. */
export function newId(prefix: string): string {
  const now = Date.now();
  let time = '';
  let n = now;
  while (n > 0) {
    time = ALPHABET[n % 36] + time;
    n = Math.floor(n / 36);
  }
  const random = randomBytes(8).toString('hex');
  return `${prefix}_${time}${random}`;
}

export function newUuid(): string {
  return randomUUID();
}

/** RFC 5322 Message-ID, angle brackets included. */
export function newRfcMessageId(domain: string): string {
  return `<${randomUUID()}@${domain}>`;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}
