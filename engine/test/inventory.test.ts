import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Migrator } from 'kysely/migration';
import { auth, makeApp } from './helpers.js';
import type { DB } from '../src/db/index.js';
import { openDatabase, migrate } from '../src/db/index.js';
import { provider } from '../src/db/migrations.js';
import { JobFailure, JobRunner } from '../src/jobs.js';

const FAKE = path.resolve('test/fixtures/fake-kubectl.cjs');
let app: FastifyInstance; let db: DB; let kubeDir: string; let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  kubeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-kube-'));
  fs.writeFileSync(path.join(kubeDir, 'lab-source.uid'), '11111111-1111-1111-1111-111111111111');
  fs.writeFileSync(path.join(kubeDir, 'lab-target.uid'), '22222222-2222-2222-2222-222222222222');
  fs.writeFileSync(path.join(kubeDir, 'config'), 'apiVersion: v1\n');
  fs.symlinkSync(FAKE, path.join(kubeDir, 'kubectl'));   // collect.py runs "kubectl" from PATH
  Object.assign(process.env, { FAKE_KUBE_DIR: kubeDir, STUDIO_KUBECTL: FAKE, KUBECONFIG: path.join(kubeDir, 'config'), PATH: `${kubeDir}${path.delimiter}${process.env.PATH}` });
});
afterEach(async () => { await app?.close(); process.env = saved; });

async function setup() {
  const made = await makeApp();
  ({ app, db } = made);
  return made;
}
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => app.inject({ method, url, headers: auth, ...(payload === undefined ? {} : { payload: payload as object }) });
async function waitForJob(id: string) {
  for (let i = 0; i < 200; i++) {
    const job = (await call('GET', `/api/jobs/${id}`)).json();
    if (['Succeeded', 'Failed'].includes(job.state)) return job;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('job did not finish');
}
async function project() { return (await call('POST', '/api/projects', { name: 'Lab' })).json().id as string; }
async function register(contextName: string, role: string) { return call('POST', '/api/clusters', { contextName, role }); }

describe('clusters', () => {
  it('lists kubeconfig contexts without credentials', async () => {
    await setup();
    const res = await call('GET', '/api/kube/contexts');
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((c: { name: string }) => c.name)).toContain('lab-source');
    expect(res.body).not.toContain('admin@corp');
    expect(res.body).not.toContain('REDACTED');
  });

  it('registers clusters by identity and refuses duplicates', async () => {
    await setup();
    const src = await register('lab-source', 'source');
    expect(src.statusCode).toBe(201);
    expect(src.json().clusterUid).toBe('11111111-1111-1111-1111-111111111111');
    expect((await register('lab-source', 'source')).statusCode).toBe(409);
    const alias = await register('alias-of-source', 'target');
    expect(alias.statusCode).toBe(409);
    expect(alias.json().message).toContain('same cluster');
    expect((await register('not-in-kubeconfig', 'source')).statusCode).toBe(400);
    expect((await register('lab-target', 'target')).statusCode).toBe(201);
  });

  it('explains cluster failures without exposing raw kubectl output', async () => {
    await setup();
    const denied = await register('denied', 'source');
    expect(denied.statusCode).toBe(502);
    expect(denied.json().error).toBe('Forbidden');
    expect(denied.body).not.toContain('secret-user');
    const down = await register('down', 'source');
    expect(down.json().error).toBe('Unreachable');
    expect(down.body).not.toContain('10.9.9.9');
  });

  it('detects a context that now points at another cluster', async () => {
    await setup();
    const id = (await register('lab-source', 'source')).json().id;
    fs.writeFileSync(path.join(kubeDir, 'lab-source.uid'), '99999999-9999-9999-9999-999999999999');
    const check = (await call('POST', `/api/clusters/${id}/check`)).json();
    expect(check.lastError).toContain('different cluster');
  });
});

describe('inventory', () => {
  it('collects, stores, analyses and lists workloads with findings', async () => {
    await setup();
    const pid = await project();
    const src = (await register('lab-source', 'source')).json().id;
    const tgt = (await register('lab-target', 'target')).json().id;
    expect((await call('PATCH', `/api/projects/${pid}/clusters`, { sourceClusterId: tgt })).statusCode).toBe(400);
    expect((await call('PATCH', `/api/projects/${pid}/clusters`, { sourceClusterId: src, targetClusterId: tgt })).statusCode).toBe(200);
    const started = await call('POST', `/api/projects/${pid}/collect`, { side: 'source' });
    expect(started.statusCode).toBe(202);
    const job = await waitForJob(started.json().jobId);
    expect(job.state, job.error).toBe('Succeeded');
    const list = (await call('GET', `/api/projects/${pid}/workloads`)).json();
    const web = list.items.find((w: { resource: string }) => w.resource === 'app/Deployment/web');
    expect(web).toMatchObject({ kind: 'Deployment', namespace: 'app', name: 'web' });
    expect(web.blockers + web.reviews).toBeGreaterThan(0);
    const detail = (await call('GET', `/api/projects/${pid}/workloads/${web.id}`)).json();
    expect(detail.findings.length).toBeGreaterThan(0);
    // The collector strips env values; nothing secret reaches the store.
    const blobs = await db.selectFrom('blobs').select('compressed').execute();
    expect(blobs.some(b => zlib.gunzipSync(b.compressed).toString().includes('ENV_SECRET_VALUE'))).toBe(false);
    const audit = (await call('GET', '/api/audit')).json().items.map((a: { action: string }) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['cluster.register', 'inventory.collect', 'inventory.store', 'job.collect.succeeded']));
  });

  it('refuses to collect when the context now reaches a different cluster', async () => {
    await setup();
    const pid = await project();
    const src = (await register('lab-source', 'source')).json().id;
    await call('PATCH', `/api/projects/${pid}/clusters`, { sourceClusterId: src });
    fs.writeFileSync(path.join(kubeDir, 'lab-source.uid'), '99999999-9999-9999-9999-999999999999');
    const job = await waitForJob((await call('POST', `/api/projects/${pid}/collect`, { side: 'source' })).json().jobId);
    expect(job.state).toBe('Failed');
    expect(job.error).toContain('different cluster');
    expect((await call('GET', `/api/projects/${pid}/snapshots`)).json().items).toHaveLength(0);
  });

  it('needs a cluster before collecting', async () => {
    await setup();
    const res = await call('POST', `/api/projects/${await project()}/collect`, { side: 'target' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('target cluster');
  });

  it('loads the demo, imports a changed inventory and diffs the two', async () => {
    await setup();
    const pid = await project();
    expect((await call('POST', `/api/projects/${pid}/demo`)).statusCode).toBe(201);
    const demo = JSON.parse(fs.readFileSync(path.resolve('../dist/demo.json'), 'utf8'));
    demo.items = demo.items.filter((r: { kind: string; metadata: { name: string } }) => !(r.kind === 'Deployment' && r.metadata.name === 'inference'));
    demo.collection = { ...demo.collection, collectedAt: new Date(Date.now() + 1000).toISOString() };
    const imported = await call('POST', `/api/projects/${pid}/snapshots`, { side: 'source', inventory: demo });
    expect(imported.statusCode).toBe(201);
    const snaps = (await call('GET', `/api/projects/${pid}/snapshots`)).json().items;
    expect(snaps.map((s: { origin: string }) => s.origin)).toEqual(['imported', 'demo']);
    const diff = (await call('GET', `/api/projects/${pid}/snapshots/${snaps[0].id}/diff`)).json();
    expect(diff.previousId).toBe(snaps[1].id);
    expect(diff.counts.removed).toBeGreaterThanOrEqual(1);
    const states = (await call('GET', `/api/projects/${pid}/workloads`)).json().items;
    expect(states.find((w: { resource: string }) => w.resource === 'analytics/Deployment/inference').state).toBe('NotInLatestSnapshot');
    expect((await call('GET', `/api/projects/${pid}/findings`)).json().items.length).toBeGreaterThan(0);
  });

  it('rejects invalid imports', async () => {
    await setup();
    const pid = await project();
    for (const inventory of [{ items: [] }, { items: [{ kind: 'Deployment' }] }, { nope: 1 }]) {
      const res = await call('POST', `/api/projects/${pid}/snapshots`, { side: 'source', inventory });
      expect(res.statusCode, JSON.stringify(inventory)).toBe(400);
    }
  });
});

describe('job runner', () => {
  it('requeues retryable work and fails other work after an engine crash', async () => {
    const db2 = openDatabase(':memory:'); await migrate(db2);
    let runs = 0;
    const runner = new JobRunner(db2, { read: { retryable: true, run: async () => { runs++; return 'ok'; } }, write: { retryable: false, run: async () => { runs++; } } }, 60_000);
    const past = new Date(Date.now() - 120_000).toISOString();
    for (const [id, type] of [['a', 'read'], ['b', 'write']]) {
      await db2.insertInto('jobs').values({ id: id!, type: type!, project_id: null, payload: '{}', state: 'Running', attempts: 1, lease_owner: 'dead-engine', lease_until: past, progress: null, result: null, error: null, created_at: past, updated_at: past }).execute();
    }
    await runner.drain();
    const jobs = await db2.selectFrom('jobs').select(['id', 'state', 'error']).orderBy('id').execute();
    expect(jobs[0]).toMatchObject({ id: 'a', state: 'Succeeded' });
    expect(jobs[1]).toMatchObject({ id: 'b', state: 'Failed' });
    expect(jobs[1]!.error).toContain('Review');
    expect(runs).toBe(1);
  });

  it('shows JobFailure messages and hides unexpected errors', async () => {
    const db2 = openDatabase(':memory:'); await migrate(db2);
    const runner = new JobRunner(db2, { known: { retryable: false, run: async () => { throw new JobFailure('Shown to the user'); } }, bug: { retryable: false, run: async () => { throw new Error('/secret/path stack'); } } }, 60_000);
    await runner.stop();   // keep enqueue from running jobs in the background
    await runner.enqueue('known', {}); await runner.enqueue('bug', {});
    (runner as unknown as { stopped: boolean }).stopped = false;
    await runner.drain();
    const errors = (await db2.selectFrom('jobs').select('error').orderBy('created_at').execute()).map(j => j.error);
    expect(errors).toContain('Shown to the user');
    expect(errors.join()).not.toContain('/secret/path');
  });
});

describe('migrations', () => {
  it('upgrades a 1.0 database with snapshots', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mig-')), 'studio.db');
    const db1 = openDatabase(file);
    await new Migrator({ db: db1, provider }).migrateTo('001_initial');
    const now = new Date().toISOString();
    await db1.insertInto('projects').values({ id: 'p', name: 'p', description: '', source_cluster_id: null, target_cluster_id: null, settings: '{}', created_at: now, updated_at: now }).execute();
    await (db1 as any).insertInto('clusters').values({ id: 'c', context_name: 'ctx', role: 'target', observed_uid: 'u', last_seen_at: null, created_at: now }).execute();
    await db1.insertInto('blobs').values({ hash: 'h', size: 0, compressed: Buffer.alloc(0), created_at: now }).execute();
    await (db1 as any).insertInto('snapshots').values({ id: 's', project_id: 'p', cluster_id: 'c', blob_hash: 'h', collected_at: now, coverage: '{}' }).execute();
    expect(await migrate(db1)).toEqual(['002_inventory']);
    const s = await db1.selectFrom('snapshots').selectAll().executeTakeFirstOrThrow();
    expect(s).toMatchObject({ id: 's', side: 'target', origin: 'collected', cluster_id: 'c' });
    await db1.destroy();
  });
});
