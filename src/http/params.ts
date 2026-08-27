import { badRequest } from '../errors.js';

export function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value == null) return undefined;
  if (typeof value !== 'string') throw badRequest(`\`${field}\` must be a string.`, field);
  return value;
}

export function requiredString(body: Record<string, unknown>, field: string): string {
  const value = optionalString(body, field);
  if (!value) throw badRequest(`\`${field}\` is required.`, field);
  return value;
}

export function optionalObject(body: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  const value = body[field];
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`\`${field}\` must be an object.`, field);
  }
  return value as Record<string, unknown>;
}

export function optionalStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field];
  if (value == null) return undefined;
  const items = Array.isArray(value) ? value : [value];
  if (!items.every((item) => typeof item === 'string')) {
    throw badRequest(`\`${field}\` must be a string or an array of strings.`, field);
  }
  return items as string[];
}

export function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value == null) return undefined;
  if (typeof value !== 'boolean') throw badRequest(`\`${field}\` must be a boolean.`, field);
  return value;
}

export function optionalNumber(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badRequest(`\`${field}\` must be a number.`, field);
  }
  return value;
}

export function queryNumber(query: URLSearchParams, field: string): number | undefined {
  const raw = query.get(field);
  if (raw == null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw badRequest(`\`${field}\` must be a number.`, field);
  return value;
}
