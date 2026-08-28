import { badRequest, notFound } from '../errors.js';
import type { Store } from '../store/types.js';
import type { Contact, ContactList, ContactStatus, Id } from '../types.js';
import { isValidEmail } from '../util/email.js';
import { newId } from '../util/ids.js';

export interface ImportRow {
  email: string;
  name?: string;
  [key: string]: unknown;
}

export interface ImportReport {
  imported: number;
  duplicates: number;
  rejected: Array<{ row: number; email: string; reason: string }>;
}

export class ListService {
  constructor(private readonly store: Store) {}

  async create(accountId: Id, name: string, doubleOptin = false): Promise<ContactList> {
    if (!name.trim()) throw badRequest('List name is required.', 'name');
    return this.store.createList({
      id: newId('lst'),
      accountId,
      name,
      doubleOptin,
      createdAt: new Date().toISOString(),
    });
  }

  async get(accountId: Id, id: Id): Promise<ContactList> {
    const list = await this.store.getList(id);
    if (!list || list.accountId !== accountId) throw notFound('List');
    return list;
  }

  async all(accountId: Id): Promise<ContactList[]> {
    return this.store.listLists(accountId);
  }

  async remove(accountId: Id, id: Id): Promise<void> {
    await this.get(accountId, id);
    await this.store.deleteList(id);
  }

  async addContact(
    accountId: Id,
    listId: Id,
    input: ImportRow,
    source = 'api',
  ): Promise<Contact> {
    const list = await this.get(accountId, listId);
    const email = String(input.email ?? '').trim().toLowerCase();
    if (!isValidEmail(email)) throw badRequest(`"${email}" is not a valid email address.`, 'email');

    const { email: _ignored, name, ...customFields } = input;
    return this.store.upsertContact({
      id: newId('con'),
      accountId,
      listId,
      email,
      name: name ?? null,
      customFields: customFields as Record<string, unknown>,
      status: list.doubleOptin ? 'unconfirmed' : 'subscribed',
      source,
      confirmedAt: null,
      createdAt: new Date().toISOString(),
    });
  }

  async contacts(accountId: Id, listId: Id): Promise<Contact[]> {
    await this.get(accountId, listId);
    return this.store.listContacts(listId);
  }

  /** Validates syntax, reports rejected rows with reasons, deduplicates (FR-6.4). */
  async import(accountId: Id, listId: Id, rows: ImportRow[], source = 'csv'): Promise<ImportReport> {
    await this.get(accountId, listId);
    const report: ImportReport = { imported: 0, duplicates: 0, rejected: [] };
    const seen = new Set<string>();

    for (const [index, row] of rows.entries()) {
      const email = String(row.email ?? '').trim().toLowerCase();
      if (!isValidEmail(email)) {
        report.rejected.push({ row: index + 1, email, reason: 'invalid address syntax' });
        continue;
      }
      if (seen.has(email)) {
        report.duplicates += 1;
        continue;
      }
      seen.add(email);
      if (await this.store.findContact(listId, email)) {
        report.duplicates += 1;
        continue;
      }
      await this.addContact(accountId, listId, { ...row, email }, source);
      report.imported += 1;
    }

    return report;
  }

  async setStatus(accountId: Id, listId: Id, email: string, status: ContactStatus): Promise<Contact> {
    await this.get(accountId, listId);
    const contact = await this.store.findContact(listId, email.toLowerCase());
    if (!contact) throw notFound('Contact');
    return this.store.updateContact(contact.id, {
      status,
      confirmedAt: status === 'subscribed' ? contact.confirmedAt ?? new Date().toISOString() : contact.confirmedAt,
    });
  }

  /** Parses a CSV with a header row into import rows. */
  static parseCsv(csv: string): ImportRow[] {
    const lines = csv.split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) return [];
    const headers = splitCsvLine(lines[0]).map((header) => header.trim().toLowerCase());
    return lines.slice(1).map((line) => {
      const cells = splitCsvLine(line);
      const row: ImportRow = { email: '' };
      headers.forEach((header, index) => {
        row[header] = cells[index] ?? '';
      });
      return row;
    });
  }
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(current);
      current = '';
    } else current += ch;
  }
  out.push(current);
  return out;
}
