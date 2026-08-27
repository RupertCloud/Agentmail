import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthContext } from '../domain/accounts.js';
import { ApiError, notFound } from '../errors.js';
import type { Platform } from '../platform.js';

export interface RequestContext {
  platform: Platform;
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
  rawBody: string;
  /** Populated by the auth middleware for `/v1` routes. */
  auth: AuthContext;
}

export interface HttpResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (ctx: RequestContext) => Promise<HttpResponse>;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  /** `/v1` routes require a bearer key; public ones do not. */
  authenticated: boolean;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, authenticated = true): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split('/').filter(Boolean),
      handler,
      authenticated,
    });
    return this;
  }

  get(pattern: string, handler: Handler, authenticated = true): this {
    return this.add('GET', pattern, handler, authenticated);
  }
  post(pattern: string, handler: Handler, authenticated = true): this {
    return this.add('POST', pattern, handler, authenticated);
  }
  patch(pattern: string, handler: Handler, authenticated = true): this {
    return this.add('PATCH', pattern, handler, authenticated);
  }
  delete(pattern: string, handler: Handler, authenticated = true): this {
    return this.add('DELETE', pattern, handler, authenticated);
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } {
    const parts = path.split('/').filter(Boolean);
    let pathMatched = false;

    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (const [index, segment] of route.segments.entries()) {
        if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(parts[index]);
        else if (segment !== parts[index]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      pathMatched = true;
      if (route.method === method.toUpperCase()) return { route, params };
    }

    if (pathMatched) throw new ApiError(405, 'method_not_allowed', `${method} is not allowed on ${path}.`);
    throw notFound('Route');
  }

  requiresAuth(route: { authenticated: boolean }): boolean {
    return route.authenticated;
  }
}
