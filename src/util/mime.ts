/**
 * Minimal RFC 5322 / MIME builder and parser.
 *
 * Only what this platform emits and ingests: multipart/alternative for
 * text+html, multipart/mixed for attachments, and the `agentmail.json` part
 * that carries an agent's structured payload across external transport.
 */
import { randomBytes } from 'node:crypto';
import type { Address, Attachment } from '../types.js';
import { formatAddressList, parseAddressList } from './email.js';

export const STRUCTURED_PART_NAME = 'agentmail.json';
export const HEADER_PAYLOAD = 'X-AgentMail-Payload';
export const HEADER_HOPS = 'X-AgentMail-Hops';
export const HEADER_AGENT = 'X-AgentMail-Agent';
export const HEADER_THREAD = 'X-AgentMail-Thread';

export interface RawMessageInput {
  from: Address;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  replyTo?: Address[];
  subject: string;
  text?: string | null;
  html?: string | null;
  headers?: Record<string, string>;
  attachments?: Attachment[];
  structured?: unknown;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  date?: Date;
}

function boundary(): string {
  return `----=_AgentMail_${randomBytes(12).toString('hex')}`;
}

function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function foldHeader(name: string, value: string): string {
  const line = `${name}: ${value}`;
  if (line.length <= 78) return line;
  const parts: string[] = [];
  let current = `${name}:`;
  for (const token of value.split(' ')) {
    if (current.length + token.length + 1 > 76) {
      parts.push(current);
      current = ` ${token}`;
    } else {
      current += ` ${token}`;
    }
  }
  parts.push(current);
  return parts.join('\r\n');
}

function base64Body(content: string | Buffer): string {
  const b64 = Buffer.isBuffer(content)
    ? content.toString('base64')
    : Buffer.from(content, 'utf8').toString('base64');
  return (b64.match(/.{1,76}/g) ?? []).join('\r\n');
}

function part(contentType: string, content: string, extraHeaders: string[] = []): string {
  return [
    `Content-Type: ${contentType}`,
    'Content-Transfer-Encoding: base64',
    ...extraHeaders,
    '',
    base64Body(content),
  ].join('\r\n');
}

/** Serialises a message to raw RFC 5322 bytes suitable for SES SendRawEmail. */
export function buildRawMessage(input: RawMessageInput): string {
  const headers: string[] = [];
  const push = (name: string, value: string) => headers.push(foldHeader(name, value));

  push('From', formatAddressList([input.from]));
  push('To', formatAddressList(input.to));
  if (input.cc?.length) push('Cc', formatAddressList(input.cc));
  if (input.replyTo?.length) push('Reply-To', formatAddressList(input.replyTo));
  push('Subject', encodeHeaderValue(input.subject));
  push('Message-ID', input.messageId);
  push('Date', (input.date ?? new Date()).toUTCString());
  push('MIME-Version', '1.0');
  if (input.inReplyTo) push('In-Reply-To', input.inReplyTo);
  if (input.references?.length) push('References', input.references.join(' '));
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    push(name, encodeHeaderValue(value));
  }

  const bodyParts: string[] = [];
  const text = input.text ?? '';
  const html = input.html ?? '';
  if (text) bodyParts.push(part('text/plain; charset=UTF-8', text));
  if (html) bodyParts.push(part('text/html; charset=UTF-8', html));
  if (!bodyParts.length) bodyParts.push(part('text/plain; charset=UTF-8', ''));

  let body: string;
  let contentType: string;

  if (bodyParts.length > 1) {
    const alt = boundary();
    contentType = `multipart/alternative; boundary="${alt}"`;
    body = wrapParts(alt, bodyParts);
  } else {
    const single = bodyParts[0];
    const headerEnd = single.indexOf('\r\n\r\n');
    contentType = single.slice('Content-Type: '.length, single.indexOf('\r\n'));
    body = single.slice(headerEnd + 4);
    headers.push('Content-Transfer-Encoding: base64');
  }

  const mixedParts: string[] = [];
  if (input.structured !== undefined) {
    mixedParts.push(
      part('application/json; charset=UTF-8', JSON.stringify(input.structured, null, 2), [
        `Content-Disposition: inline; filename="${STRUCTURED_PART_NAME}"`,
      ]),
    );
  }
  for (const attachment of input.attachments ?? []) {
    mixedParts.push(
      [
        `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${attachment.filename}"`,
        '',
        (attachment.content.match(/.{1,76}/g) ?? []).join('\r\n'),
      ].join('\r\n'),
    );
  }

  if (mixedParts.length) {
    const mixed = boundary();
    const inner =
      bodyParts.length > 1
        ? [`Content-Type: ${contentType}`, '', body].join('\r\n')
        : [`Content-Type: ${contentType}`, 'Content-Transfer-Encoding: base64', '', body].join('\r\n');
    const combined = wrapParts(mixed, [inner, ...mixedParts]);
    return [
      ...headers.filter((h) => !h.startsWith('Content-Transfer-Encoding:')),
      foldHeader('Content-Type', `multipart/mixed; boundary="${mixed}"`),
      '',
      combined,
    ].join('\r\n');
  }

  return [...headers, foldHeader('Content-Type', contentType), '', body].join('\r\n');
}

function wrapParts(bound: string, parts: string[]): string {
  return [...parts.map((p) => `--${bound}\r\n${p}`), `--${bound}--`, ''].join('\r\n');
}

/* --------------------------------------------------------------------- parse */

export interface ParsedMessage {
  headers: Record<string, string>;
  from: Address[];
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  subject: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  text: string | null;
  html: string | null;
  structured: unknown;
  attachments: Attachment[];
}

export function parseRawMessage(raw: string): ParsedMessage {
  const normalized = raw.replace(/\r\n/g, '\n');
  const split = normalized.indexOf('\n\n');
  const headerBlock = split === -1 ? normalized : normalized.slice(0, split);
  const body = split === -1 ? '' : normalized.slice(split + 2);
  const headers = parseHeaders(headerBlock);

  const result: ParsedMessage = {
    headers,
    from: parseAddressList(headers.from),
    to: parseAddressList(headers.to),
    cc: parseAddressList(headers.cc),
    replyTo: parseAddressList(headers['reply-to']),
    subject: decodeEncodedWords(headers.subject ?? ''),
    messageId: headers['message-id'] ?? null,
    inReplyTo: headers['in-reply-to'] ?? null,
    references: (headers.references ?? '').split(/\s+/).filter(Boolean),
    text: null,
    html: null,
    structured: undefined,
    attachments: [],
  };

  walkPart(headers, body, result);
  return result;
}

function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const unfolded = block.replace(/\n[ \t]+/g, ' ');
  for (const line of unfolded.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
  }
  return headers;
}

function walkPart(headers: Record<string, string>, body: string, out: ParsedMessage): void {
  const contentType = headers['content-type'] ?? 'text/plain';
  const mediaType = contentType.split(';')[0].trim().toLowerCase();

  if (mediaType.startsWith('multipart/')) {
    const match = contentType.match(/boundary="?([^";]+)"?/i);
    if (!match) return;
    for (const section of splitOnBoundary(body, match[1])) {
      const idx = section.indexOf('\n\n');
      const subHeaders = parseHeaders(idx === -1 ? section : section.slice(0, idx));
      const subBody = idx === -1 ? '' : section.slice(idx + 2);
      walkPart(subHeaders, subBody, out);
    }
    return;
  }

  const disposition = headers['content-disposition'] ?? '';
  const filename = (disposition.match(/filename="?([^";]+)"?/i) ?? [])[1];
  const decoded = decodeBody(body, headers['content-transfer-encoding']);

  if (mediaType === 'application/json' && filename === STRUCTURED_PART_NAME) {
    try {
      out.structured = JSON.parse(decoded.toString('utf8'));
    } catch {
      out.structured = undefined;
    }
    return;
  }
  if (/attachment/i.test(disposition)) {
    out.attachments.push({
      filename: filename ?? 'attachment',
      contentType: mediaType,
      content: decoded.toString('base64'),
    });
    return;
  }
  if (mediaType === 'text/plain' && out.text == null) out.text = decoded.toString('utf8').trim();
  else if (mediaType === 'text/html' && out.html == null) out.html = decoded.toString('utf8').trim();
}

function splitOnBoundary(body: string, bound: string): string[] {
  const marker = `--${bound}`;
  const chunks = body.split(marker);
  return chunks
    .slice(1, chunks.length)
    .filter((chunk) => !chunk.startsWith('--'))
    .map((chunk) => chunk.replace(/^\n/, '').replace(/\n$/, ''));
}

function decodeBody(body: string, encoding: string | undefined): Buffer {
  const enc = (encoding ?? '7bit').trim().toLowerCase();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64');
  if (enc === 'quoted-printable') return Buffer.from(decodeQuotedPrintable(body), 'binary');
  return Buffer.from(body, 'utf8');
}

function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function decodeEncodedWords(input: string): string {
  return input.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset, kind, data) => {
    const buf =
      kind.toUpperCase() === 'B'
        ? Buffer.from(data, 'base64')
        : Buffer.from(decodeQuotedPrintable(String(data).replace(/_/g, ' ')), 'binary');
    try {
      return new TextDecoder(String(charset).toLowerCase()).decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  });
}
