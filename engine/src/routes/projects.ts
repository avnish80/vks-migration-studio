import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../db/index.js';
import { record } from '../audit.js';

const projectBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
    description: { type: 'string', maxLength: 2000 },
  },
} as const;

type Row = { id: string; name: string; description: string; source_cluster_id: string | null; target_cluster_id: string | null; created_at: string; updated_at: string };
const view = (p: Row) => ({ id: p.id, name: p.name, description: p.description, sourceClusterId: p.source_cluster_id, targetClusterId: p.target_cluster_id, createdAt: p.created_at, updatedAt: p.updated_at });
const COLUMNS = ['id', 'name', 'description', 'source_cluster_id', 'target_cluster_id', 'created_at', 'updated_at'] as const;

export function projectRoutes(app: FastifyInstance, db: DB): void {
  app.get('/api/projects', async () => {
    const rows = await db.selectFrom('projects').select(COLUMNS).orderBy('created_at', 'desc').execute();
    return { items: rows.map(view) };
  });

  app.post<{ Body: { name: string; description?: string } }>('/api/projects', { schema: { body: projectBody } }, async (request, reply) => {
    const now = new Date().toISOString();
    const row = { id: crypto.randomUUID(), name: request.body.name.trim(), description: request.body.description?.trim() ?? '', source_cluster_id: null, target_cluster_id: null, settings: '{}', created_at: now, updated_at: now };
    await db.transaction().execute(async trx => {
      await trx.insertInto('projects').values(row).execute();
      await record(trx as unknown as DB, 'project.create', 'project/' + row.id, { name: row.name });
    });
    return reply.code(201).send(view(row));
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const row = await db.selectFrom('projects').select(COLUMNS).where('id', '=', request.params.id).executeTakeFirst();
    if (!row) return reply.code(404).send({ error: 'NotFound', message: 'No project with that id.' });
    return view(row);
  });
}
