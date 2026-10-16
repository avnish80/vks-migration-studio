import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, makeApp } from './helpers.js';
import type { DB } from '../src/db/index.js';
import { sql } from 'kysely';

let app: FastifyInstance; let db: DB;
afterEach(async () => { await app?.close(); await db?.destroy(); });

describe('projects and audit', () => {
  it('creates, lists and reads projects, and audits the create', async () => {
    ({ app, db } = await makeApp());
    const created = await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: '  Payments to VKS ', description: 'Wave 1' } });
    expect(created.statusCode).toBe(201);
    const project = created.json();
    expect(project.name).toBe('Payments to VKS');
    expect((await app.inject({ url: '/api/projects', headers: auth })).json().items).toHaveLength(1);
    expect((await app.inject({ url: `/api/projects/${project.id}`, headers: auth })).json().id).toBe(project.id);
    expect((await app.inject({ url: '/api/projects/nope', headers: auth })).statusCode).toBe(404);
    const audit = (await app.inject({ url: '/api/audit', headers: auth })).json().items;
    expect(audit[0]).toMatchObject({ action: 'project.create', subject: `project/${project.id}`, detail: { name: 'Payments to VKS' } });
    expect((await app.inject({ url: '/api/audit?limit=1', headers: auth })).json().items).toHaveLength(1);
    for (const q of ['limit=0', 'limit=501', 'limit=abc', 'other=1']) expect((await app.inject({ url: `/api/audit?${q}`, headers: auth })).statusCode, q).toBe(400);
  });

  it('validates project input', async () => {
    ({ app, db } = await makeApp());
    for (const payload of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(101) }, { name: 'ok', extra: 1 }, { name: 5 }]) {
      const res = await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('keeps the audit log append-only', async () => {
    ({ app, db } = await makeApp());
    await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'a' } });
    await expect(sql`update audit set action = 'x'`.execute(db)).rejects.toThrow(/append-only/);
    await expect(sql`delete from audit`.execute(db)).rejects.toThrow(/append-only/);
  });

  it('allows only one unresolved run per workload', async () => {
    ({ app, db } = await makeApp());
    const now = new Date().toISOString();
    await db.insertInto('projects').values({ id: 'p', name: 'p', description: '', source_cluster_id: null, target_cluster_id: null, settings: '{}', created_at: now, updated_at: now }).execute();
    await db.insertInto('workloads').values({ id: 'w', project_id: 'p', resource_id: 'app/Deployment/web', state: 'Planned', wave_id: null, updated_at: now }).execute();
    await db.insertInto('blobs').values({ hash: 'h', size: 0, compressed: Buffer.alloc(0), created_at: now }).execute();
    await db.insertInto('plans').values({ id: 'plan', workload_id: 'w', input_hash: 'i', blob_hash: 'h', created_at: now }).execute();
    const run = (id: string, state: string) => db.insertInto('runs').values({ id, plan_id: 'plan', workload_id: 'w', run_label: id, state, lease_owner: null, heartbeat_at: null, created_at: now, updated_at: now }).execute();
    await run('r1', 'Piloting');
    await expect(run('r2', 'Piloting')).rejects.toThrow(/UNIQUE/);
    await db.updateTable('runs').set({ state: 'Cleaned' }).where('id', '=', 'r1').execute();
    await run('r2', 'Piloting');
  });
});
