import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { DB } from '../db/index.js';
import { record } from '../audit.js';
import { clusterUid, KubeError, listContexts } from '../kube.js';

type Row = { id: string; context_name: string; name: string | null; role: 'source' | 'target'; observed_uid: string | null; last_seen_at: string | null; last_error: string | null; retired_at: string | null; created_at: string };
const view = (c: Row) => ({ id: c.id, contextName: c.context_name, name: c.name ?? c.context_name, role: c.role, clusterUid: c.observed_uid, lastSeenAt: c.last_seen_at, lastError: c.last_error, createdAt: c.created_at });

const kubeReply = (e: unknown) => e instanceof KubeError ? { status: e.reason === 'NoKubeconfig' || e.reason === 'NoKubectl' ? 503 : 502, body: { error: e.reason, message: e.message } } : undefined;

export function clusterRoutes(app: FastifyInstance, db: DB, config: Config): void {
  app.get('/api/kube/contexts', async (_req, reply) => {
    try {
      const contexts = await listContexts(config);
      const registered = new Set((await db.selectFrom('clusters').select('context_name').where('retired_at', 'is', null).execute()).map(c => c.context_name));
      return { items: contexts.map(c => ({ ...c, registered: registered.has(c.name) })) };
    } catch (e) {
      const r = kubeReply(e); if (r) return reply.code(r.status).send(r.body);
      throw e;
    }
  });

  app.get('/api/clusters', async () => ({ items: (await db.selectFrom('clusters').selectAll().where('retired_at', 'is', null).orderBy('created_at').execute()).map(view) }));

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
    const same = await db.selectFrom('clusters').select(['context_name']).where('observed_uid', '=', uid).where('retired_at', 'is', null).executeTakeFirst();
    if (same) return reply.code(409).send({ error: 'Conflict', message: `This is the same cluster as context ${same.context_name}, which is already registered.` });
    const now = new Date().toISOString();
    const row: Row = { id: crypto.randomUUID(), context_name: contextName, name: name?.trim() || null, role, observed_uid: uid, last_seen_at: now, last_error: null, retired_at: null, created_at: now };
    try { await db.insertInto('clusters').values(row).execute(); }
    catch (e) { if (/UNIQUE/.test(String(e))) return reply.code(409).send({ error: 'Conflict', message: 'That context is already registered.' }); throw e; }
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

  /**
   * Removes a cluster from use. A cluster with collected snapshots is retired rather than deleted, so
   * the record of what was collected from it stays intact and its context name can be registered
   * again, for example after the cluster was rebuilt under the same name. Projects using it are
   * unassigned.
   */
  app.delete<{ Params: { id: string } }>('/api/clusters/:id', async (request, reply) => {
    const c = await db.selectFrom('clusters').selectAll().where('id', '=', request.params.id).where('retired_at', 'is', null).executeTakeFirst();
    if (!c) return reply.code(404).send({ error: 'NotFound', message: 'No cluster with that id.' });
    const running = await db.selectFrom('jobs').select('id').where('state', 'in', ['Queued', 'Running']).where('payload', 'like', `%"clusterId":"${c.id}"%`).executeTakeFirst();
    if (running) return reply.code(409).send({ error: 'Conflict', message: 'A collection from this cluster is running. Wait for it to finish.' });
    const now = new Date().toISOString();
    const hasSnapshots = !!(await db.selectFrom('snapshots').select('id').where('cluster_id', '=', c.id).executeTakeFirst());
    await db.transaction().execute(async trx => {
      await trx.updateTable('projects').set({ source_cluster_id: null, updated_at: now }).where('source_cluster_id', '=', c.id).execute();
      await trx.updateTable('projects').set({ target_cluster_id: null, updated_at: now }).where('target_cluster_id', '=', c.id).execute();
      if (hasSnapshots) await trx.updateTable('clusters').set({ retired_at: now, context_name: `${c.context_name}#retired-${c.id.slice(0, 8)}` }).where('id', '=', c.id).execute();
      else await trx.deleteFrom('clusters').where('id', '=', c.id).execute();
      await record(trx as unknown as DB, hasSnapshots ? 'cluster.retire' : 'cluster.remove', `cluster/${c.id}`, { context: c.context_name });
    });
    return reply.code(204).send();
  });
}
