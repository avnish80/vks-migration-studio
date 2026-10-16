import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { DB } from '../db/index.js';
import { record } from '../audit.js';
import { clusterUid, KubeError, listContexts } from '../kube.js';

type Row = { id: string; context_name: string; name: string | null; role: 'source' | 'target'; observed_uid: string | null; last_seen_at: string | null; last_error: string | null; created_at: string };
const view = (c: Row) => ({ id: c.id, contextName: c.context_name, name: c.name ?? c.context_name, role: c.role, clusterUid: c.observed_uid, lastSeenAt: c.last_seen_at, lastError: c.last_error, createdAt: c.created_at });

const kubeReply = (e: unknown) => e instanceof KubeError ? { status: e.reason === 'NoKubeconfig' || e.reason === 'NoKubectl' ? 503 : 502, body: { error: e.reason, message: e.message } } : undefined;

export function clusterRoutes(app: FastifyInstance, db: DB, config: Config): void {
  app.get('/api/kube/contexts', async (_req, reply) => {
    try {
      const contexts = await listContexts(config);
      const registered = new Set((await db.selectFrom('clusters').select('context_name').execute()).map(c => c.context_name));
      return { items: contexts.map(c => ({ ...c, registered: registered.has(c.name) })) };
    } catch (e) {
      const r = kubeReply(e); if (r) return reply.code(r.status).send(r.body);
      throw e;
    }
  });

  app.get('/api/clusters', async () => ({ items: (await db.selectFrom('clusters').selectAll().orderBy('created_at').execute()).map(view) }));

  app.post<{ Body: { contextName: string; role: 'source' | 'target'; name?: string } }>('/api/clusters', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['contextName', 'role'], properties: {
      contextName: { type: 'string', minLength: 1, maxLength: 253 }, role: { enum: ['source', 'target'] }, name: { type: 'string', minLength: 1, maxLength: 100 } } } },
  }, async (request, reply) => {
    const { contextName, role, name } = request.body;
    let contexts;
    try { contexts = await listContexts(config); }
    catch (e) { const r = kubeReply(e); if (r) return reply.code(r.status).send(r.body); throw e; }
    if (!contexts.some(c => c.name === contextName)) return reply.code(400).send({ error: 'BadRequest', message: 'That context is not in the kubeconfig the engine reads.' });
    if (await db.selectFrom('clusters').select('id').where('context_name', '=', contextName).executeTakeFirst()) return reply.code(409).send({ error: 'Conflict', message: 'That context is already registered.' });
    let uid: string;
    try { uid = await clusterUid(config, contextName); }
    catch (e) { const r = kubeReply(e); if (r) return reply.code(r.status).send(r.body); throw e; }
    const same = await db.selectFrom('clusters').select(['context_name']).where('observed_uid', '=', uid).executeTakeFirst();
    if (same) return reply.code(409).send({ error: 'Conflict', message: `This is the same cluster as context ${same.context_name}, which is already registered.` });
    const now = new Date().toISOString();
    const row: Row = { id: crypto.randomUUID(), context_name: contextName, name: name?.trim() || null, role, observed_uid: uid, last_seen_at: now, last_error: null, created_at: now };
    await db.insertInto('clusters').values(row).execute();
    await record(db, 'cluster.register', `cluster/${row.id}`, { context: contextName, role, clusterUid: uid });
    return reply.code(201).send(view(row));
  });

  /** Re-checks that the context still reaches the same cluster. */
  app.post<{ Params: { id: string } }>('/api/clusters/:id/check', async (request, reply) => {
    const c = await db.selectFrom('clusters').selectAll().where('id', '=', request.params.id).executeTakeFirst();
    if (!c) return reply.code(404).send({ error: 'NotFound', message: 'No cluster with that id.' });
    let update: Partial<Row>;
    try {
      const uid = await clusterUid(config, c.context_name);
      update = uid === c.observed_uid ? { last_seen_at: new Date().toISOString(), last_error: null }
        : { last_error: `Context ${c.context_name} now points to a different cluster than when it was registered.` };
    } catch (e) {
      if (!(e instanceof KubeError)) throw e;
      update = { last_error: e.message };
    }
    await db.updateTable('clusters').set(update).where('id', '=', c.id).execute();
    return view({ ...c, ...update } as Row);
  });

  app.delete<{ Params: { id: string } }>('/api/clusters/:id', async (request, reply) => {
    const id = request.params.id;
    const used = await db.selectFrom('projects').select('name').where(eb => eb.or([eb('source_cluster_id', '=', id), eb('target_cluster_id', '=', id)])).executeTakeFirst();
    if (used) return reply.code(409).send({ error: 'Conflict', message: `Project ${used.name} uses this cluster. Change the project first.` });
    const snap = await db.selectFrom('snapshots').select('id').where('cluster_id', '=', id).executeTakeFirst();
    if (snap) return reply.code(409).send({ error: 'Conflict', message: 'Snapshots were collected from this cluster, so it stays registered for the record.' });
    const res = await db.deleteFrom('clusters').where('id', '=', id).executeTakeFirst();
    if (!res.numDeletedRows) return reply.code(404).send({ error: 'NotFound', message: 'No cluster with that id.' });
    await record(db, 'cluster.remove', `cluster/${id}`);
    return reply.code(204).send();
  });
}
