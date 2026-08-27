import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AuthContext } from '../domain/accounts.js';
import { ApiError } from '../errors.js';
import type { Platform } from '../platform.js';
import { RateLimiter } from './ratelimit.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerEmailRoutes } from './routes/emails.js';
import { registerPlatformRoutes } from './routes/platform.js';
import { registerPublicRoutes } from './routes/public.js';
import { Router, type RequestContext } from './router.js';

const MAX_BODY_BYTES = 60 * 1024 * 1024;

export function buildRouter(): Router {
  const router = new Router();
  registerPublicRoutes(router);
  registerEmailRoutes(router);
  registerAgentRoutes(router);
  registerPlatformRoutes(router);
  return router;
}

export interface ServerOptions {
  rateLimit?: RateLimiter;
}

export function createServer(platform: Platform, options: ServerOptions = {}): Server {
  const router = buildRouter();
  const limiter = options.rateLimit ?? new RateLimiter();

  return createHttpServer((req, res) => {
    void handle(platform, router, limiter, req, res).catch((error) => {
      writeJson(res, 500, { error: { type: 'internal_error', message: 'Unexpected error.' } });
      // eslint-disable-next-line no-console
      console.error('[agentmail] unhandled request error', error);
    });
  });
}

async function handle(
  platform: Platform,
  router: Router,
  limiter: RateLimiter,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requestId = `req_${Math.random().toString(36).slice(2, 12)}`;
  res.setHeader('x-request-id', requestId);

  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const { route, params } = router.match(req.method ?? 'GET', url.pathname);
    const rawBody = await readBody(req);
    const body = parseBody(rawBody, req.headers['content-type']);

    const ctx: RequestContext = {
      platform,
      req,
      res,
      method: req.method ?? 'GET',
      path: url.pathname,
      params,
      query: url.searchParams,
      headers: req.headers,
      body,
      rawBody,
      // Populated below for authenticated routes; public routes never read it.
      auth: null as unknown as AuthContext,
    };

    if (router.requiresAuth(route)) {
      const header = req.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      ctx.auth = await platform.accounts.authenticate(token);

      const limit = limiter.check(ctx.auth.key.id);
      res.setHeader('x-ratelimit-limit', String(limit.limit));
      res.setHeader('x-ratelimit-remaining', String(limit.remaining));
      res.setHeader('x-ratelimit-reset', String(limit.resetSeconds));
      if (!limit.allowed) {
        res.setHeader('retry-after', String(limit.resetSeconds));
        throw new ApiError(429, 'rate_limited', 'Too many requests. Slow down and retry.');
      }
    }

    const result = await route.handler(ctx);
    if (result.headers) for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);

    if (result.status === 204 || result.body === undefined) {
      res.writeHead(result.status);
      res.end();
      return;
    }
    if (typeof result.body === 'string') {
      res.writeHead(result.status);
      res.end(result.body);
      return;
    }
    writeJson(res, result.status, result.body);
  } catch (error) {
    if (error instanceof ApiError) {
      writeJson(res, error.statusCode, { error: error.toJSON(), request_id: requestId });
      return;
    }
    throw error;
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError(413, 'payload_too_large', 'Request body exceeds 60 MB.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseBody(raw: string, contentType: string | undefined): Record<string, unknown> {
  if (!raw.trim()) return {};
  if (contentType && !contentType.includes('json')) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    throw new ApiError(400, 'invalid_request', 'Request body is not valid JSON.');
  }
}
