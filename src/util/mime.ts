/**
 * Minimal RFC 5322 / MIME builder and parser.
 *
 * Only what this platform emits and ingests: multipart/alternative for
 * text+html, multipart/mixed for attachments, and the `agentmail.json` part
 * that carries an agent's structured payload across external transport.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Address, Attachment } from '../types.js';
import { formatAddressList, parseAddressList } from './email.js';

/* ACCP wire constants — see docs/accp/SPEC.md. Header names carry no `X-`
 * prefix, per RFC 6648. */
export const ACCP_VERSION = '0.2';
export const STRUCTURED_PART_NAME = 'accp.json';
export const STRUCTURED_MEDIA_TYPE = 'application/accp+json';

export const HEADER_VERSION = 'ACCP-Version';
export const HEADER_INTENT = 'ACCP-Intent';
export const HEADER_CONVERSATION = 'ACCP-Conversation';
export const HEADER_HOPS = 'ACCP-Hops';
export const HEADER_AGENT = 'ACCP-Agent';
export const HEADER_CAPABILITY = 'ACCP-Capability';
export const HEADER_CORRELATION = 'ACCP-Correlation';
export const HEADER_IDEMPOTENCY = 'ACCP-Idempotency-Key';
export const HEADER_EXPIRES = 'ACCP-Expires';
export const HEADER_CONTENT_DIGEST = 'ACCP-Content-Digest';
/** Superseded by ACCP-Content-Digest; still read on the way in. */
export const HEADER_PAYLOAD_DIGEST = 'ACCP-Payload-Digest';

/**
 * Content commitment (v2), borrowing machinery from proof systems without any
 * of the zero-knowledge. Hardened after the adversarial review recorded in
 * docs/accp/integrity-review.md, which broke the v1 scheme.
 *
 * 1. **Commit to parts separately.** A list footer rewrites `text`, not
 *    `payload`. Per-part leaves (payload, text, html, attachments) let a
 *    receiver say "the prose changed, the payload did not".
 * 2. **Bind the commitment to the envelope.** Each leaf and the root hash the
 *    Message-ID *and the From address* (the root also the Date), so a
 *    (digest, payload) pair cannot be spliced into another message or
 *    re-enveloped under another sender.
 * 3. **Length-prefix every field.** The pre-image is injective: no byte inside
 *    a field — a NUL included — can be read as a boundary. v1's `||0x00||`
 *    delimiter was not injective.
 * 4. **Domain separation, versioned.** Labels (`ACCP-leaf-v2`, `ACCP-root-v2`)
 *    stop a digest computed for one role being reused as another.
 *
 * Deliberately *not* copied: a Merkle tree. Logarithmic membership proofs pay
 * off over thousands of leaves; a message has four. The root binds the set and
 * gives one value to sign — verified by RECOMPUTING it from content, never
 * (as v1 did) from the header's own claimed leaves.
 */
const LEAF_LABEL = 'ACCP-leaf-v3';
const ROOT_LABEL = 'ACCP-root-v3';

/**
 * Content parts committed to, in a fixed order. `attachments` is a single leaf
 * over the ordered attachment set (C8). The envelope — message-id and sender —
 * is folded into every leaf and the root (C4, C10) so a payload cannot be
 * re-enveloped under a different sender and still verify.
 */
export const COMMITTED_PARTS = ['payload', 'text', 'html', 'attachments'] as const;
export type CommittedPart = (typeof COMMITTED_PARTS)[number];

function b64(buffer: Buffer): string {
  return buffer.toString('base64');
}

/**
 * Length-prefixed field, so the hash pre-image is injective: any byte inside a
 * field — a NUL included — can never be read as a field boundary (fixes C5).
 * Eight-byte big-endian length, then the UTF-8 bytes.
 */
function field(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64BE(BigInt(bytes.length));
  return Buffer.concat([prefix, bytes]);
}

/** The envelope facts every leaf and the root bind to. */
export interface DigestEnvelope {
  messageId: string;
  from: string;
  date: string;
}

/** Leaf digest for one named part, bound to the message and its sender. */
export function partDigest(part: string, env: DigestEnvelope, content: string): string {
  return b64(
    createHash('sha256')
      .update(field(LEAF_LABEL))
      .update(field(part))
      .update(field(env.messageId))
      .update(field(env.from))
      .update(field(content))
      .digest(),
  );
}

/**
 * Canonical bytes the `attachments` leaf commits to: the count, then each
 * attachment's name, type and content hash — every component length-prefixed.
 *
 * Delimiters would not do. `contentType` comes from an attacker-controllable
 * MIME header, so a `.`/`|`-joined encoding lets one crafted attachment forge
 * as two: put the separator structure inside the content type and the joined
 * string is byte-identical. Length prefixes make the encoding injective.
 */
export function attachmentsContent(attachments: Attachment[] | undefined): string {
  const list = attachments ?? [];
  const parts: Buffer[] = [field(String(list.length))];
  for (const a of list) {
    const hash = createHash('sha256').update(a.content, 'base64').digest('base64');
    parts.push(field(a.filename), field(a.contentType), field(hash));
  }
  return Buffer.concat(parts).toString('base64');
}

/**
 * Binds the leaf set and the envelope together, giving one value to sign.
 * Length-prefixed throughout, so no leaf value can forge a boundary.
 */
export function contentRoot(
  env: DigestEnvelope,
  alg: string,
  leaves: Record<string, string>,
): string {
  const hash = createHash('sha256')
    .update(field(ROOT_LABEL))
    .update(field(env.messageId))
    .update(field(env.from))
    .update(field(env.date))
    .update(field(alg));
  for (const part of COMMITTED_PARTS) {
    hash.update(field(part)).update(field(leaves[part] ?? ''));
  }
  return b64(hash.digest());
}

export interface ContentDigest {
  alg: string;
  root: string;
  leaves: Record<string, string>;
}

export function formatContentDigest(digest: ContentDigest): string {
  const parts = COMMITTED_PARTS.filter((p) => digest.leaves[p] !== undefined).map(
    (p) => `${p}=${digest.leaves[p]}`,
  );
  return [`alg=${digest.alg}`, `root=${digest.root}`, ...parts].join('; ');
}

export function parseContentDigest(header: string | undefined): ContentDigest | null {
  if (!header) return null;
  const fields: Record<string, string> = {};
  for (const piece of header.split(';')) {
    const idx = piece.indexOf('=');
    if (idx === -1) continue;
    const key = piece.slice(0, idx).trim().toLowerCase();
    // A repeated field is an injection attempt, not something to merge. Counting
    // header *lines* is not enough: RFC 5322 folding lets an attacker append
    // `; payload=<forged>` as a continuation of the genuine header, keeping the
    // line count at one. Refuse the whole header instead of taking last-wins.
    if (key in fields) return null;
    fields[key] = piece.slice(idx + 1).trim();
  }
  if (!fields.root) return null;
  const leaves: Record<string, string> = {};
  for (const part of COMMITTED_PARTS) {
    if (fields[part]) leaves[part] = fields[part];
  }
  return { alg: fields.alg ?? 'sha-256', root: fields.root, leaves };
}

/** Computes the commitment for a message about to be sent. */
export function buildContentDigest(
  env: DigestEnvelope,
  contents: Partial<Record<CommittedPart, string>>,
): ContentDigest {
  const alg = 'sha-256';
  const leaves: Record<string, string> = {};
  for (const part of COMMITTED_PARTS) {
    const content = contents[part];
    if (content !== undefined) leaves[part] = partDigest(part, env, content);
  }
  return { alg, root: contentRoot(env, alg, leaves), leaves };
}

/**
 * Pre-standard header and part names this implementation emitted before ACCP
 * was specified. Accepted on the way in, never written on the way out.
 */
export const LEGACY_HEADERS: Record<string, string> = {
  'x-agentmail-hops': HEADER_HOPS,
  'x-agentmail-agent': HEADER_AGENT,
  'x-agentmail-thread': HEADER_CONVERSATION,
};
export const LEGACY_PART_NAME = 'agentmail.json';

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
  context?: unknown;
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

  const dateString = (input.date ?? new Date()).toUTCString();
  push('From', formatAddressList([input.from]));
  push('To', formatAddressList(input.to));
  if (input.cc?.length) push('Cc', formatAddressList(input.cc));
  if (input.replyTo?.length) push('Reply-To', formatAddressList(input.replyTo));
  push('Subject', encodeHeaderValue(input.subject));
  push('Message-ID', input.messageId);
  push('Date', dateString);
  push('MIME-Version', '1.0');
  if (input.inReplyTo) push('In-Reply-To', input.inReplyTo);
  if (input.references?.length) push('References', input.references.join(' '));
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    // C7: never let a caller supply a content-digest header — that is the
    // sender-side half of the duplicate-header forge. The platform computes the
    // real one below; other ACCP-* headers (Version, Intent, …) are set by the
    // trusted send path and pass through.
    if (/^accp-(content|payload)-digest$/i.test(name.trim())) continue;
    push(name, encodeHeaderValue(value));
  }

  const bodyParts: string[] = [];
  let structuredText: string | undefined;
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
  if (input.structured !== undefined || input.context !== undefined) {
    // ACCP §5.1: `accp` marks the part as enveloped. Its absence is how a
    // receiver recognises a 0.1 part, which carried the payload bare.
    const envelope = {
      accp: ACCP_VERSION,
      ...(input.context === undefined ? {} : { context: input.context }),
      payload: input.structured ?? null,
    };
    const envelopeText = JSON.stringify(envelope, null, 2);
    structuredText = envelopeText;
    mixedParts.push(
      part(`${STRUCTURED_MEDIA_TYPE}; charset=UTF-8`, envelopeText, [
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

  if (structuredText !== undefined) {
    const env: DigestEnvelope = { messageId: input.messageId, from: input.from.email, date: dateString };
    push(
      HEADER_CONTENT_DIGEST,
      formatContentDigest(
        buildContentDigest(env, {
          payload: structuredText,
          ...(text ? { text } : {}),
          ...(html ? { html } : {}),
          // Always commit the attachment set — an empty leaf still detects an
          // attachment appended in transit (C8).
          attachments: attachmentsContent(input.attachments),
        }),
      ),
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
  /** How many raw ACCP-Content-Digest header lines were present (C0). */
  contentDigestCount: number;
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
  context: unknown;
  /** Decoded bytes of the envelope part, for digest verification. */
  structuredRaw: string | null;
  attachments: Attachment[];
}

export function parseRawMessage(raw: string): ParsedMessage {
  const normalized = raw.replace(/\r\n/g, '\n');
  const split = normalized.indexOf('\n\n');
  const headerBlock = split === -1 ? normalized : normalized.slice(0, split);
  const body = split === -1 ? '' : normalized.slice(split + 2);
  const headers = parseHeaders(headerBlock);

  // C0: count raw ACCP-Content-Digest header lines *before* folding merges them.
  // More than one is a forge attempt, and the verifier must refuse to trust any.
  const unfolded = headerBlock.replace(/\n[ \t]+/g, ' ');
  const contentDigestCount = unfolded
    .split('\n')
    .filter((line) => /^accp-content-digest\s*:/i.test(line)).length;

  const result: ParsedMessage = {
    headers,
    contentDigestCount,
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
    context: undefined,
    structuredRaw: null,
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
  for (const [legacy, standard] of Object.entries(LEGACY_HEADERS)) {
    const canonical = standard.toLowerCase();
    if (legacy in headers && !(canonical in headers)) headers[canonical] = headers[legacy];
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

  const isStructured =
    mediaType === STRUCTURED_MEDIA_TYPE ||
    (mediaType === 'application/json' &&
      (filename === STRUCTURED_PART_NAME || filename === LEGACY_PART_NAME));
  if (isStructured) {
    const envelopeText = decoded.toString('utf8');
    out.structuredRaw = envelopeText;
    try {
      const parsed = JSON.parse(envelopeText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'accp' in parsed) {
        out.structured = (parsed as Record<string, unknown>).payload;
        out.context = (parsed as Record<string, unknown>).context;
      } else {
        // ACCP 0.1: the part was the payload itself, and carried no context.
        out.structured = parsed;
      }
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
  // C6: do NOT trim. The sender commits over the exact decoded bytes; trimming
  // here would false-report `modified` on any prose with a trailing newline.
  if (mediaType === 'text/plain' && out.text == null) out.text = decoded.toString('utf8');
  else if (mediaType === 'text/html' && out.html == null) out.html = decoded.toString('utf8');
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
