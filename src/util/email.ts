import type { Address } from '../types.js';

const ADDRESS_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;

export function isValidEmail(email: string): boolean {
  return ADDRESS_RE.test(email.trim());
}

/** Parses `Name <a@b.com>`, `<a@b.com>` and `a@b.com`. */
export function parseAddress(input: string): Address {
  const raw = input.trim();
  const angle = raw.match(/^(.*?)<([^>]+)>$/);
  if (angle) {
    const name = angle[1].trim().replace(/^"(.*)"$/, '$1').trim();
    const email = angle[2].trim().toLowerCase();
    return name ? { email, name } : { email };
  }
  return { email: raw.toLowerCase() };
}

/** Splits a header value on commas that are not inside quotes or angle brackets. */
export function parseAddressList(input: string | string[] | undefined | null): Address[] {
  if (input == null) return [];
  const items = Array.isArray(input) ? input : splitAddresses(input);
  return items.map((item) => (typeof item === 'string' ? parseAddress(item) : item)).filter((a) => a.email);
}

function splitAddresses(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngle = false;
  for (const ch of input) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === '<') inAngle = true;
    else if (ch === '>') inAngle = false;
    if (ch === ',' && !inQuotes && !inAngle) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export function formatAddress(address: Address): string {
  if (!address.name) return address.email;
  const needsQuotes = /[",<>:;@\\]/.test(address.name);
  const name = needsQuotes ? `"${address.name.replace(/(["\\])/g, '\\$1')}"` : address.name;
  return `${name} <${address.email}>`;
}

export function formatAddressList(addresses: Address[]): string {
  return addresses.map(formatAddress).join(', ');
}

export function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).toLowerCase();
}

export function localPartOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? email : email.slice(0, at).toLowerCase();
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

/**
 * Plain-text fallback generated from HTML when the caller supplies only HTML
 * (FR-5.3). Not a full renderer — it keeps block structure and link targets,
 * which is what recipients and spam filters care about.
 */
export function htmlToText(html: string): string {
  let out = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  out = out.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
    const text = String(label).replace(/<[^>]+>/g, '').trim();
    if (!text) return String(href);
    return text === href ? text : `${text} (${href})`;
  });

  out = out
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li|blockquote|table|section|article)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '');

  for (const [entity, ch] of Object.entries(ENTITIES)) out = out.split(entity).join(ch);
  out = out.replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)));

  return out
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Template syntax (FR-5.2): `{{path.to.value}}` is HTML-escaped,
 * `{{{path.to.value}}}` is inserted raw. Unknown paths render empty.
 */
export function renderTemplate(source: string, variables: Record<string, unknown>): string {
  return source
    .replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_m, path) => stringify(lookup(variables, path)))
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path) => escapeHtml(stringify(lookup(variables, path))));
}

function lookup(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, source);
}

function stringify(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Normalised subject used as a threading fallback when references are absent. */
export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(\s*(re|fwd|fw|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, '')
    .trim()
    .toLowerCase();
}
