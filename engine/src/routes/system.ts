import type { FastifyInstance } from 'fastify';
import { VERSION } from '../version.js';
import type { Core } from '../core.js';

export function systemRoutes(app: FastifyInstance, core: Core): void {
  app.get('/api/health', { config: { public: true } }, async () => ({ status: 'ok' }));
  app.get('/api/version', async () => ({ version: VERSION, coreModules: Object.keys(core.modules) }));
  /** Lets the UI confirm its stored token is valid. */
  app.get('/api/session', async () => ({ authenticated: true, actor: 'local-user', productionGate: 'Closed' }));
}
