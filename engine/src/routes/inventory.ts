import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from '../config.js';
import type { Core } from '../core.js';
import type { DB } from '../db/index.js';
import type { JobRunner } from '../jobs.js';
import { jobView } from '../jobs.js';
import { record } from '../audit.js';
import { diffSnapshot, InventoryError, latestAnalysis, storeSnapshot } from '../inventory.js';
import { effectivePlatform } from '../platform.js';

const side = { enum: ['source', 'target'] } as const;
const notFound = (reply: FastifyReply, what = 'project') => reply.code(404).send({ error: 'NotFound', message: `No ${what} with that id.` });

export function inventoryRoutes(app: FastifyInstance, db: DB, core: Core, config: Config, jobs: JobRunner): void {
  const project = (id: string) => db.selectFrom('projects').selectAll().where('id', '=', id).executeTakeFirst();

  /** Assign the source and target clusters (or clear them with null). */
  app.patch<{ Params: { id: string }; Body: { sourceClusterId?: string | null; targetClusterId?: string | null } }>('/api/projects/:id/clusters', {
    schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { sourceClusterId: { type: ['string', 'null'] }, targetClusterId: { type: ['string', 'null'] } } } },
  }, async (request, reply) => {
    const p = await project(request.params.id); if (!p) return notFound(reply);
    const update: { source_cluster_id?: string | null; target_cluster_id?: string | null; updated_at: string } = { updated_at: new Date().toISOString() };
    for (const [key, column, role] of [['sourceClusterId', 'source_cluster_id', 'source'], ['targetClusterId', 'target_cluster_id', 'target']] as const) {
      const value = request.body[key];
      if (value === undefined) continue;
      if (value !== null) {
        const c = await db.selectFrom('clusters').select(['role', 'retired_at']).where('id', '=', value).executeTakeFirst();
        if (!c || c.retired_at) return reply.code(400).send({ error: 'BadRequest', message: `No registered cluster with id ${value}.` });
        if (c.role !== role) return reply.code(400).send({ error: 'BadRequest', message: `That cluster is registered as a ${c.role}, not a ${role}.` });
      }
      update[column] = value;
    }
    const src = update.source_cluster_id === undefined ? p.source_cluster_id : update.source_cluster_id;
    const tgt = update.target_cluster_id === undefined ? p.target_cluster_id : update.target_cluster_id;
    if (src && tgt && src === tgt) return reply.code(400).send({ error: 'BadRequest', message: 'Source and target must be different clusters.' });
    await db.updateTable('projects').set(update).where('id', '=', p.id).execute();
    await record(db, 'project.clusters', `project/${p.id}`, { sourceClusterId: src, targetClusterId: tgt });
    return { id: p.id, sourceClusterId: src, targetClusterId: tgt };
  });

  app.post<{ Params: { id: string }; Body: { side: 'source' | 'target' } }>('/api/projects/:id/collect', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['side'], properties: { side } } },
  }, async (request, reply) => {
    const p = await project(request.params.id); if (!p) return notFound(reply);
    const clusterId = request.body.side === 'source' ? p.source_cluster_id : p.target_cluster_id;
    if (!clusterId) return reply.code(400).send({ error: 'BadRequest', message: `Choose a ${request.body.side} cluster for this project first.` });
    const running = await db.selectFrom('jobs').select('id').where('project_id', '=', p.id).where('type', '=', 'collect').where('state', 'in', ['Queued', 'Running']).where('payload', 'like', `%"side":"${request.body.side}"%`).executeTakeFirst();
    if (running) return reply.code(409).send({ error: 'Conflict', message: 'A collection for this side is already running.', jobId: running.id });
    const jobId = await jobs.enqueue('collect', { projectId: p.id, side: request.body.side, clusterId }, p.id);
    await record(db, 'inventory.collect', `project/${p.id}`, { side: request.body.side, job: jobId });
    return reply.code(202).send({ jobId });
  });

  /** Upload a collector or kubectl JSON export, for clusters the engine cannot reach. */
  app.post<{ Params: { id: string }; Body: { side: 'source' | 'target'; inventory: unknown } }>('/api/projects/:id/snapshots', {
    bodyLimit: 75 * 1024 * 1024,
    schema: { body: { type: 'object', additionalProperties: false, required: ['side', 'inventory'], properties: { side, inventory: { anyOf: [{ type: 'object' }, { type: 'array' }] } } } },
  }, async (request, reply) => {
    const p = await project(request.params.id); if (!p) return notFound(reply);
    try { return reply.code(201).send(await storeSnapshot(db, core, { projectId: p.id, side: request.body.side, origin: 'imported', clusterId: null, raw: request.body.inventory })); }
    catch (e) { if (e instanceof InventoryError) return reply.code(400).send({ error: 'BadRequest', message: e.message }); throw e; }
  });

  /** The illustrative inventory shipped with the planning core, for trying the engine without a cluster. */
  app.post<{ Params: { id: string } }>('/api/projects/:id/demo', async (request, reply) => {
    const p = await project(request.params.id); if (!p) return notFound(reply);
    const raw = JSON.parse(fs.readFileSync(path.join(config.coreDir, 'demo.json'), 'utf8'));
    return reply.code(201).send(await storeSnapshot(db, core, { projectId: p.id, side: 'source', origin: 'demo', clusterId: null, raw }));
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/snapshots', async (request, reply) => {
    const p = await project(request.params.id); if (!p) return notFound(reply);
    const rows = await db.selectFrom('snapshots as s').leftJoin('clusters as c', 'c.id', 's.cluster_id')
      .select(['s.id', 's.side', 's.origin', 's.resource_count', 's.collected_at', 's.stored_at', 's.coverage', 'c.context_name']).where('s.project_id', '=', p.id).orderBy('s.stored_at', 'desc').orderBy('s.id', 'desc').limit(100).execute();
    return { items: rows.map(r => ({ id: r.id, side: r.side, origin: r.origin, resources: r.resource_count, collectedAt: r.collected_at, storedAt: r.stored_at, context: r.context_name, coverage: JSON.parse(r.coverage) })) };
  });

  app.get<{ Params: { id: string; sid: string } }>('/api/projects/:id/snapshots/:sid/diff', async (request, reply) => {
    const d = await diffSnapshot(db, core, request.params.id, request.params.sid);
    return d ?? notFound(reply, 'snapshot');
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/workloads', async (request, reply) => {
    const p = await project(request.params.id); if (!p) return notFound(reply);
    const rows = await db.selectFrom('workloads').selectAll().where('project_id', '=', p.id).orderBy('namespace').orderBy('kind').orderBy('name').execute();
    const latest = await latestAnalysis(db, p.id);
    const estate = latest ? latest.analysis.findings.filter(f => !latest.analysis.workloadSet.has(f.resource)) : [];
    const sev: Record<string, number> = {};
    for (const f of latest?.analysis.findings ?? []) sev[f.severity] = (sev[f.severity] ?? 0) + 1;
    return {
      snapshotId: latest?.snapshotId ?? null,
      findingsBySeverity: sev,
      estateFindings: estate.length,
      items: rows.map(w => ({ id: w.id, resource: w.resource_id, kind: w.kind, namespace: w.namespace, name: w.name, state: w.state, blockers: w.blockers, reviews: w.reviews, updatedAt: w.updated_at, platform: effectivePlatform(w.platform, w.platform_override), platformDetected: w.platform, platformOverride: w.platform_override })),
    };
  });

  /** Override whether a workload is an application or a platform add-on ('app', 'platform', or null for automatic). */
  app.put<{ Params: { id: string; wid: string }; Body: { as: 'app' | 'platform' | null } }>('/api/projects/:id/workloads/:wid/classification', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['as'], properties: { as: { anyOf: [{ type: 'string', enum: ['app', 'platform'] }, { type: 'null' }] } } } },
  }, async (request, reply) => {
    const w = await db.selectFrom('workloads').selectAll().where('id', '=', request.params.wid).where('project_id', '=', request.params.id).executeTakeFirst();
    if (!w) return notFound(reply, 'workload');
    await db.updateTable('workloads').set({ platform_override: request.body.as }).where('id', '=', w.id).execute();
    await record(db, 'workload.classification', `workload/${w.id}`, { resource: w.resource_id, as: request.body.as ?? 'automatic' });
    return { id: w.id, platform: effectivePlatform(w.platform, request.body.as), platformDetected: w.platform, platformOverride: request.body.as };
  });

  /** Findings for one workload, plus findings on the resources it is connected to. */
  app.get<{ Params: { id: string; wid: string } }>('/api/projects/:id/workloads/:wid', async (request, reply) => {
    const w = await db.selectFrom('workloads').selectAll().where('id', '=', request.params.wid).where('project_id', '=', request.params.id).executeTakeFirst();
    if (!w) return notFound(reply, 'workload');
    const latest = await latestAnalysis(db, w.project_id);
    const edges = latest?.analysis.edges.filter(e => e.from === w.resource_id || e.to === w.resource_id) ?? [];
    const related = new Set(edges.flatMap(e => [e.from, e.to]).filter(r => r !== w.resource_id));
    const findings = latest?.analysis.findings.filter(f => f.resource === w.resource_id || related.has(f.resource)) ?? [];
    return { id: w.id, resource: w.resource_id, kind: w.kind, namespace: w.namespace, name: w.name, state: w.state, findings, edges };
  });

  /** Inventory-wide findings that are not about a single workload. */
  app.get<{ Params: { id: string } }>('/api/projects/:id/findings', async (request, reply) => {
    const p = await project(request.params.id); if (!p) return notFound(reply);
    const latest = await latestAnalysis(db, p.id);
    const all = latest ? latest.analysis.findings.filter(f => !latest.analysis.workloadSet.has(f.resource)) : [];
    // Bounded response: the most severe first, at most 500.
    const order = ['Blocker', 'Review', 'Unknown', 'Info'];
    const items = [...all].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity)).slice(0, 500);
    return { snapshotId: latest?.snapshotId ?? null, total: all.length, items };
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => {
    const j = await db.selectFrom('jobs').selectAll().where('id', '=', request.params.id).executeTakeFirst();
    return j ? jobView(j) : notFound(reply, 'job');
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/jobs', async request => ({
    items: (await db.selectFrom('jobs').selectAll().where('project_id', '=', request.params.id).orderBy('created_at', 'desc').limit(20).execute()).map(jobView),
  }));
}
