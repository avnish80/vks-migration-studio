import type { FastifyInstance } from 'fastify';
import type { DB } from '../db/index.js';

export function auditRoutes(app: FastifyInstance, db: DB): void {
  // Query strings are text; numbers are checked by pattern and converted here (no global coercion).
  app.get<{ Querystring: { limit?: string; before?: string } }>('/api/audit', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' }, before: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' } } } },
  }, async (request, reply) => {
    const limit = Number(request.query.limit ?? 100);
    if (limit > 500) return reply.code(400).send({ error: 'BadRequest', message: 'limit must be 500 or less' });
    let query = db.selectFrom('audit').selectAll().orderBy('seq', 'desc').limit(limit);
    if (request.query.before) query = query.where('seq', '<', Number(request.query.before));
    const rows = await query.execute();
    return { items: rows.map(r => ({ seq: r.seq, at: r.at, actor: r.actor, action: r.action, subject: r.subject, detail: JSON.parse(r.detail) })) };
  });
}
