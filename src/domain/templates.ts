import { badRequest, conflict, notFound } from '../errors.js';
import type { Store } from '../store/types.js';
import type { Id, Template } from '../types.js';
import { htmlToText, renderTemplate } from '../util/email.js';
import { newId } from '../util/ids.js';

export interface TemplateInput {
  name: string;
  subject: string;
  html: string;
  text?: string;
}

export class TemplateService {
  constructor(private readonly store: Store) {}

  async create(accountId: Id, input: TemplateInput): Promise<Template> {
    if (!input.name.trim()) throw badRequest('Template name is required.', 'name');
    if (await this.store.findTemplateByName(accountId, input.name)) {
      throw conflict(`A template named "${input.name}" already exists.`);
    }
    return this.store.createTemplate({
      id: newId('tpl'),
      accountId,
      name: input.name,
      version: 1,
      subject: input.subject,
      html: input.html,
      text: input.text ?? htmlToText(input.html),
      createdAt: new Date().toISOString(),
    });
  }

  async get(accountId: Id, id: Id): Promise<Template> {
    const template = await this.store.getTemplate(id);
    if (!template || template.accountId !== accountId) throw notFound('Template');
    return template;
  }

  async list(accountId: Id): Promise<Template[]> {
    return this.store.listTemplates(accountId);
  }

  /** Editing bumps the version rather than rewriting history (FR-5.1). */
  async update(accountId: Id, id: Id, patch: Partial<TemplateInput>): Promise<Template> {
    const template = await this.get(accountId, id);
    const html = patch.html ?? template.html;
    return this.store.updateTemplate(id, {
      subject: patch.subject ?? template.subject,
      html,
      text: patch.text ?? (patch.html ? htmlToText(html) : template.text),
      version: template.version + 1,
    });
  }

  async remove(accountId: Id, id: Id): Promise<void> {
    await this.get(accountId, id);
    await this.store.deleteTemplate(id);
  }

  async preview(
    accountId: Id,
    id: Id,
    variables: Record<string, unknown>,
  ): Promise<{ subject: string; html: string; text: string }> {
    const template = await this.get(accountId, id);
    return {
      subject: renderTemplate(template.subject, variables),
      html: renderTemplate(template.html, variables),
      text: renderTemplate(template.text, variables),
    };
  }
}
