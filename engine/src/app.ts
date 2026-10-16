import fs from 'node:fs';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Config } from './config.js';
import type { DB } from './db/index.js';
import type { Core } from './core.js';
import { tokenMatches } from './token.js';
import { systemRoutes } from './routes/system.js';
import { projectRoutes } from './routes/projects.js';
import { auditRoutes } from './routes/audit.js';

declare module 'fastify' {
  interface FastifyContextConfig { public?: boolean }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

/** Host header name without port, lower-cased. Handles IPv6 literals. */
export function hostname(host: string | undefined): string {
  if (!host) return '';
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0] ?? '';
}

/** True for any request the router treats as API: the matched route, or the decoded path. */
export function isApiRequest(request: { routeOptions: { url?: string }; url: string }): boolean {
  if (request.routeOptions.url?.startsWith('/api/')) return true;
  let path = request.url.split('?')[0] ?? '';
  try { path = decodeURIComponent(path); } catch { /* malformed escape: keep raw */ }
  return path.toLowerCase().replace(/\/+/g, '/').startsWith('/api/');
}

export interface AppOptions { config: Config; db: DB; core: Core; token: string; logger?: boolean }

/** Request URLs are logged without the sign-in token (it arrives once as ?token=). */
export function redactUrl(url: string): string {
  return url.replace(/([?&]token=)[^&#]*/gi, '$1REDACTED');
}

export async function buildApp({ config, db, core, token, logger = false }: AppOptions): Promise<FastifyInstance> {
  // Strict validation: no silent type coercion and no silent stripping of unknown fields.
  const app = Fastify({ logger: logger ? { serializers: { req: (req: { method: string; url: string }) => ({ method: req.method, url: redactUrl(req.url) }) } } : false, bodyLimit: 1024 * 1024, trustProxy: false, ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: true } } });
  const allowed = new Set([...LOCAL_HOSTS, ...config.allowedHosts]);

  // DNS-rebinding protection: a web page cannot reach the engine under another host name.
  app.addHook('onRequest', async (request, reply) => {
    if (!allowed.has(hostname(request.headers.host))) return reply.code(403).send({ error: 'Forbidden', message: 'Host not allowed. Set STUDIO_ALLOWED_HOSTS to add one.' });
    // Cross-site writes are refused even with a token.
    const origin = request.headers.origin;
    if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      let same = false;
      // Same origin, or an origin whose host name was explicitly allowed (a proxy such as
      // GitHub Codespaces port forwarding may rewrite the Host header).
      try {
        const o = new URL(origin);
        same = o.host.toLowerCase() === (request.headers.host ?? '').toLowerCase() || (o.protocol === 'https:' && config.allowedHosts.includes(o.hostname.toLowerCase()));
      } catch { same = false; }
      if (!same) return reply.code(403).send({ error: 'Forbidden', message: 'Cross-origin request refused.' });
    }
    // Decide on the route the router matched, never on the raw URL: the router decodes
    // percent-escapes, so /%61pi/projects matches /api/projects.
    if (isApiRequest(request) && !request.routeOptions.config?.public) {
      const header = request.headers.authorization ?? '';
      const supplied = header.startsWith('Bearer ') ? header.slice(7) : undefined;
      if (!tokenMatches(token, supplied)) return reply.code(401).send({ error: 'Unauthorized', message: 'Missing or invalid access token. Open the link the engine printed at start-up.' });
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    if (isApiRequest(request)) reply.header('cache-control', 'no-store');
    return payload;
  });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.validation) return reply.code(400).send({ error: 'BadRequest', message: error.message });
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) app.log.error(error);
    return reply.code(status).send({ error: status === 500 ? 'InternalError' : 'RequestError', message: status === 500 ? 'Unexpected engine error; see the engine log.' : error.message });
  });

  systemRoutes(app, core);
  projectRoutes(app, db);
  auditRoutes(app, db);

  const uiBuilt = fs.existsSync(config.uiDir) && fs.existsSync(`${config.uiDir}/index.html`);
  if (uiBuilt) await app.register(fastifyStatic, { root: config.uiDir, wildcard: false, index: ['index.html'] });

  app.setNotFoundHandler((request, reply) => {
    if (isApiRequest(request) || !['GET', 'HEAD'].includes(request.method)) return reply.code(404).send({ error: 'NotFound', message: 'No such endpoint.' });
    // Client-side routes fall back to the UI shell.
    if (uiBuilt) return reply.type('text/html').sendFile('index.html');
    return reply.code(404).type('text/plain').send('UI not built. Run npm run build in ui/, or use the API.');
  });

  return app;
}
