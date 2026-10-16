import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from '../config.js';
import type { Core } from '../core.js';
import type { DB } from '../db/index.js';
import type { JobRunner } from '../jobs.js';
import { record } from '../audit.js';
import { getBlob } from '../blobs.js';
import { canI, clusterUid, KubeError, listContexts } from '../kube.js';
import { createPlan, PilotError, planView, requestStep, runView, startRun, type Step } from '../pilot.js';

const fail = (reply: FastifyReply, e: unknown) => {
  if (e instanceof PilotError) return reply.code(e.status).send({ error: e.status === 404 ? 'NotFound' : e.status === 409 ? 'Conflict' : 'BadRequest', message: e.message });
  if (e instanceof KubeError) return reply.code(502).send({ error: e.reason, message: e.message });
  throw e;
};

const imageRef = { type: 'string', minLength: 1, maxLength: 512, pattern: '^[a-zA-Z0-9._:/@-]+$' } as const;

export function pilotRoutes(app: FastifyInstance, db: DB, core: Core, config: Config, jobs: JobRunner): void {
  /** Binds a write-capable context (the pilot login) to a registered target cluster. */
  app.put<{ Params: { id: string }; Body: { contextName: string | null } }>('/api/clusters/:id/pilot-context', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['contextName'], properties: { contextName: { anyOf: [{ type: 'string', minLength: 1, maxLength: 253 }, { type: 'null' }] } } } },
  }, async (request, reply) => {
    try {
      const c = await db.selectFrom('clusters').selectAll().where('id', '=', request.params.id).where('retired_at', 'is', null).executeTakeFirst();
      if (!c) throw new PilotError(404, 'No cluster with that id.');
      if (c.role !== 'target') throw new PilotError(400, 'Pilot logins are only for VKS target clusters.');
      const name = request.body.contextName;
      if (name !== null) {
        if (!(await listContexts(config)).some(x => x.name === name)) throw new PilotError(400, 'That context is not in the kubeconfig the engine reads.');
        const registered = await db.selectFrom('clusters').select('context_name').where('context_name', '=', name).where('retired_at', 'is', null).executeTakeFirst();
        if (registered) throw new PilotError(400, 'That context is registered as a cluster for inventory. Use the separate, namespace-scoped pilot login (scripts/pilot-kubeconfig).');
        if ((await clusterUid(config, name)) !== c.observed_uid) throw new PilotError(400, 'That context reaches a different cluster than this target.');
        // A pilot login must be limited to namespaces: refuse one that can write cluster-wide.
        if (await canI(config, name, ['create', 'deployments.apps', '--all-namespaces'])) throw new PilotError(400, 'That context can create Deployments in every namespace. Use a namespace-scoped pilot login (scripts/pilot-kubeconfig).');
      }
      await db.updateTable('clusters').set({ pilot_context_name: name }).where('id', '=', c.id).execute();
      await record(db, 'cluster.pilot-context', `cluster/${c.id}`, { context: name });
      return { id: c.id, pilotContextName: name };
    } catch (e) { return fail(reply, e); }
  });

  /** Everything the workload panel needs for pilots: containers, the latest plan, and runs. */
  app.get<{ Params: { id: string; wid: string } }>('/api/projects/:id/workloads/:wid/pilot', async (request, reply) => {
    const w = await db.selectFrom('workloads').selectAll().where('id', '=', request.params.wid).where('project_id', '=', request.params.id).executeTakeFirst();
    if (!w) return reply.code(404).send({ error: 'NotFound', message: 'No workload with that id.' });
    const snap = w.snapshot_id ? await db.selectFrom('snapshots').select('blob_hash').where('id', '=', w.snapshot_id).executeTakeFirst() : undefined;
    let containers: { name: string; image: string; init: boolean }[] = [];
    if (snap) {
      const inv = await getBlob<{ items: { kind: string; metadata: { name: string; namespace?: string }; spec?: { template?: { spec?: { containers?: { name: string; image: string }[]; initContainers?: { name: string; image: string }[] } } } }[] }>(db, snap.blob_hash);
      const r = inv.items.find(x => `${x.metadata.namespace ?? 'default'}/${x.kind}/${x.metadata.name}` === w.resource_id || `${x.metadata.namespace ?? 'cluster'}/${x.kind}/${x.metadata.name}` === w.resource_id);
      const spec = r?.spec?.template?.spec;
      containers = [...(spec?.initContainers ?? []).map(c => ({ name: c.name, image: c.image, init: true })), ...(spec?.containers ?? []).map(c => ({ name: c.name, image: c.image, init: false }))];
    }
    const planRow = await db.selectFrom('plans').selectAll().where('workload_id', '=', w.id).orderBy('created_at', 'desc').limit(1).executeTakeFirst();
    const plan = planRow ? planView(planRow, await getBlob(db, planRow.blob_hash)) : null;
    const runs = await db.selectFrom('runs').select(['id', 'state', 'created_at', 'updated_at', 'plan_id']).where('workload_id', '=', w.id).orderBy('created_at', 'desc').limit(20).execute();
    const project = await db.selectFrom('projects').select('target_cluster_id').where('id', '=', w.project_id).executeTakeFirst();
    const target = project?.target_cluster_id ? await db.selectFrom('clusters').select(['name', 'context_name', 'pilot_context_name']).where('id', '=', project.target_cluster_id).executeTakeFirst() : undefined;
    return {
      workload: w.resource_id, state: w.state, containers, plan, planInputs: planRow?.settings ? JSON.parse(planRow.settings) : null,
      runs: runs.map(r => ({ id: r.id, state: r.state, planId: r.plan_id, createdAt: r.created_at, updatedAt: r.updated_at })),
      target: target ? { name: target.name ?? target.context_name, pilotContext: target.pilot_context_name } : null,
    };
  });

  app.post<{ Params: { id: string; wid: string }; Body: { serviceAccount?: string; images?: Record<string, string>; settings?: Record<string, unknown> } }>('/api/projects/:id/workloads/:wid/plans', {
    schema: { body: { type: 'object', additionalProperties: false, properties: {
      serviceAccount: { type: 'string', maxLength: 253, pattern: '^([a-z0-9]([-a-z0-9.]*[a-z0-9])?)?$' },
      images: { type: 'object', maxProperties: 50, propertyNames: imageRef, additionalProperties: imageRef },
      settings: { type: 'object', additionalProperties: false, properties: {
        smokePort: { type: 'integer', minimum: 1, maximum: 65535 }, smokePath: { type: 'string', maxLength: 500 }, expectedStatus: { type: 'integer', minimum: 200, maximum: 499 },
        maxLatencyMs: { type: 'integer', minimum: 1, maximum: 15000 }, smokeMarker: { type: 'string', maxLength: 200 }, rolloutSeconds: { type: 'integer', minimum: 30, maximum: 900 } } } } } },
  }, async (request, reply) => {
    try {
      const body = request.body;
      return reply.code(201).send(await createPlan(db, core, request.params.id, request.params.wid, { serviceAccount: body.serviceAccount || undefined, images: body.images, settings: body.settings }));
    } catch (e) { return fail(reply, e); }
  });

  app.post<{ Params: { pid: string }; Body: { acknowledgePrerequisites: boolean } }>('/api/plans/:pid/runs', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['acknowledgePrerequisites'], properties: { acknowledgePrerequisites: { type: 'boolean' } } } },
  }, async (request, reply) => {
    try {
      const runId = await startRun(db, request.params.pid, request.body.acknowledgePrerequisites);
      const run = await db.selectFrom('runs').select('project_id').where('id', '=', runId).executeTakeFirstOrThrow();
      await jobs.enqueue('pilot', { runId, step: 'validate' }, run.project_id);
      return reply.code(201).send({ runId });
    } catch (e) { return fail(reply, e); }
  });

  for (const step of ['validate', 'deploy', 'observe', 'inspect', 'cleanup', 'discard'] as const) {
    app.post<{ Params: { rid: string }; Body: { confirmWorkload?: string; confirmRun?: string; acknowledgeExternalState?: boolean } }>(`/api/runs/:rid/${step}`, {
      schema: { body: { type: 'object', additionalProperties: false, properties: { confirmWorkload: { type: 'string', maxLength: 600 }, confirmRun: { type: 'string', maxLength: 80 }, acknowledgeExternalState: { type: 'boolean' } } } },
    }, async (request, reply) => {
      try {
        await requestStep(db, request.params.rid, step, request.body ?? {});
        if (step !== 'discard') {
          const run = await db.selectFrom('runs').select('project_id').where('id', '=', request.params.rid).executeTakeFirstOrThrow();
          await jobs.enqueue('pilot', { runId: request.params.rid, step: step as Step, confirmWorkload: request.body?.confirmWorkload, confirmRun: request.body?.confirmRun }, run.project_id);
        }
        return reply.code(202).send(await runView(db, request.params.rid));
      } catch (e) { return fail(reply, e); }
    });
  }

  app.get<{ Params: { rid: string } }>('/api/runs/:rid', async (request, reply) => {
    const v = await runView(db, request.params.rid);
    return v ?? reply.code(404).send({ error: 'NotFound', message: 'No run with that id.' });
  });

  app.get<{ Querystring: { projectId?: string } }>('/api/runs', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { projectId: { type: 'string', maxLength: 64 } } } },
  }, async request => {
    let q = db.selectFrom('runs as r').innerJoin('workloads as w', 'w.id', 'r.workload_id').innerJoin('projects as p', 'p.id', 'w.project_id')
      .select(['r.id', 'r.state', 'r.created_at', 'r.updated_at', 'r.status_detail', 'w.resource_id', 'w.id as workload_id', 'p.id as project_id', 'p.name as project_name']).orderBy('r.created_at', 'desc').limit(200);
    if (request.query.projectId) q = q.where('p.id', '=', request.query.projectId);
    const rows = await q.execute();
    return { items: rows.map(r => ({ id: r.id, state: r.state, detail: r.status_detail, workload: r.resource_id, workloadId: r.workload_id, projectId: r.project_id, projectName: r.project_name, createdAt: r.created_at, updatedAt: r.updated_at })) };
  });
}
