import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, makeApp } from './helpers.js';
import type { DB } from '../src/db/index.js';
import { recoverRuns, runDir } from '../src/pilot.js';
import type { Config } from '../src/config.js';

const FAKE_KUBECTL = path.resolve('test/fixtures/fake-kubectl.cjs');
const FAKE_PYTHON = path.resolve('test/fixtures/fake-python.cjs');
const DIGEST = 'sha256:' + 'a'.repeat(64);
let app: FastifyInstance; let db: DB; let config: Config; let dir: string; let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pilot-'));
  fs.writeFileSync(path.join(dir, 'lab-source.uid'), '11111111-1111-1111-1111-111111111111');
  fs.writeFileSync(path.join(dir, 'lab-target.uid'), '22222222-2222-2222-2222-222222222222');
  fs.writeFileSync(path.join(dir, 'config'), 'apiVersion: v1\n');
  Object.assign(process.env, { STUDIO_KUBECTL: FAKE_KUBECTL, STUDIO_PYTHON: FAKE_PYTHON, KUBECONFIG: path.join(dir, 'config') });
});
afterEach(async () => { await app?.close(); process.env = saved; });

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) => app.inject({ method, url, headers: auth, ...(payload === undefined ? {} : { payload: payload as object }) });
const scenario = (s: Record<string, string>) => fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(s));
const calls = () => fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as string[]);

async function settle(runId: string) {
  for (let i = 0; i < 200; i++) {
    const run = (await call('GET', `/api/runs/${runId}`)).json();
    if (!['Validating', 'Deploying', 'Observing', 'Inspecting', 'Cleaning'].includes(run.state)) return run;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('run did not settle');
}

const source = (image: string) => ({ kind: 'List', sourceVersion: 'v1.30', collection: {}, items: [
  { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'kube-system', uid: '11111111-1111-1111-1111-111111111111' } },
  { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web', namespace: 'app' }, spec: { replicas: 3, selector: { matchLabels: { app: 'web' } }, template: { metadata: { labels: { app: 'web' } }, spec: { containers: [{ name: 'web', image, ports: [{ containerPort: 8080 }] }] } } } },
  { apiVersion: 'v1', kind: 'Service', metadata: { name: 'web', namespace: 'app' }, spec: { selector: { app: 'web' }, ports: [{ port: 80, targetPort: 8080 }] } }] });
const target = { kind: 'List', sourceVersion: 'v1.33', collection: {}, items: [
  { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'kube-system', uid: '22222222-2222-2222-2222-222222222222' } },
  { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'app' } },
  { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'default', namespace: 'app' } }] };

/** A project with a source inventory, a target cluster with a pilot login, and a target inventory. */
async function ready(image = 'example.net/web:1.0') {
  ({ app, db, config } = await makeApp());
  const tgt = (await call('POST', '/api/clusters', { contextName: 'lab-target', role: 'target' })).json().id;
  const pid = (await call('POST', '/api/projects', { name: 'pilot' })).json().id;
  await call('PATCH', `/api/projects/${pid}/clusters`, { targetClusterId: tgt });
  await call('POST', `/api/projects/${pid}/snapshots`, { side: 'source', inventory: source(image) });
  await call('POST', `/api/projects/${pid}/snapshots`, { side: 'target', inventory: target });
  const wid = (await call('GET', `/api/projects/${pid}/workloads`)).json().items.find((w: { resource: string }) => w.resource === 'app/Deployment/web').id;
  return { tgt, pid, wid };
}
async function plan(pid: string, wid: string, body: object) { return call('POST', `/api/projects/${pid}/workloads/${wid}/plans`, body); }

describe('pilot login', () => {
  it('binds only a context that reaches the same target cluster', async () => {
    const { tgt } = await ready();
    expect((await call('PUT', `/api/clusters/${tgt}/pilot-context`, { contextName: 'lab-source' })).statusCode).toBe(400);
    expect((await call('PUT', `/api/clusters/${tgt}/pilot-context`, { contextName: 'nope' })).statusCode).toBe(400);
    expect((await call('PUT', `/api/clusters/${tgt}/pilot-context`, { contextName: 'lab-target-pilot' })).statusCode).toBe(200);
  });

  it('is required before planning', async () => {
    const { pid, wid } = await ready();
    const res = await plan(pid, wid, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('pilot login');
  });
});

describe('pilot runs', () => {
  it('runs validate → deploy → inspect → clean up with confirmations, recording evidence', async () => {
    const { tgt, pid, wid } = await ready();
    await call('PUT', `/api/clusters/${tgt}/pilot-context`, { contextName: 'lab-target-pilot' });
    // A tag-only image blocks execution; a digest-pinned override clears it.
    const blocked = (await plan(pid, wid, {})).json();
    expect(blocked.blockers.length).toBeGreaterThan(0);
    expect((await call('POST', `/api/plans/${blocked.id}/runs`, { acknowledgePrerequisites: true })).statusCode).toBe(400);
    const p = (await plan(pid, wid, { images: { 'example.net/web:1.0': `example.net/web@${DIGEST}` }, settings: { smokePort: 8080 } })).json();
    expect(p.blockers, JSON.stringify(p.blockers)).toEqual([]);
    expect(p.revision).toMatch(/^[0-9a-f]{64}$/);
    expect((await call('POST', `/api/plans/${blocked.id}/runs`, { acknowledgePrerequisites: true })).statusCode).toBe(400);   // superseded
    expect((await call('POST', `/api/plans/${p.id}/runs`, { acknowledgePrerequisites: false })).statusCode).toBe(400);

    const runId = (await call('POST', `/api/plans/${p.id}/runs`, { acknowledgePrerequisites: true })).json().runId;
    let run = await settle(runId);
    expect(run.state).toBe('Validated');
    expect(run.actions).toEqual(['deploy', 'validate', 'discard']);
    expect((await call('POST', `/api/plans/${p.id}/runs`, { acknowledgePrerequisites: true })).statusCode).toBe(409);   // one unresolved run

    expect((await call('POST', `/api/runs/${runId}/deploy`, { confirmWorkload: 'web' })).statusCode).toBe(400);
    expect((await call('POST', `/api/runs/${runId}/cleanup`, {})).statusCode).toBe(409);
    expect((await call('POST', `/api/runs/${runId}/deploy`, { confirmWorkload: 'app/Deployment/web' })).statusCode).toBe(202);
    run = await settle(runId);
    expect(run.state).toBe('PilotPassed');
    const deployArgs = calls().find(a => a[1] === 'deploy')!;
    expect(deployArgs).toEqual(expect.arrayContaining(['--context', 'lab-target-pilot', '--confirm-workload', 'app/Deployment/web', '--ack-prerequisites']));
    expect((await call('GET', `/api/projects/${pid}/workloads`)).json().items.find((w: { id: string }) => w.id === wid).state).toBe('PilotPassed');

    expect((await call('POST', `/api/runs/${runId}/cleanup`, { confirmRun: runId, acknowledgeExternalState: true })).statusCode).toBe(409);   // inspect first
    await call('POST', `/api/runs/${runId}/inspect`, {});
    run = await settle(runId);
    expect(run.state, JSON.stringify(run.detail)).toBe('Inspected');
    expect((await call('POST', `/api/runs/${runId}/cleanup`, { confirmRun: 'wrong', acknowledgeExternalState: true })).statusCode).toBe(400);
    expect((await call('POST', `/api/runs/${runId}/cleanup`, { confirmRun: runId })).statusCode).toBe(400);
    scenario({ cleanup: 'Absent' });
    expect((await call('POST', `/api/runs/${runId}/cleanup`, { confirmRun: runId, acknowledgeExternalState: true })).statusCode).toBe(202);
    run = await settle(runId);
    expect(run.state).toBe('Cleaned');
    expect(run.closed).toBe(true);
    expect(run.steps.map((s: { step: string; status: string }) => `${s.step}:${s.status}`)).toEqual(['validate:Passed', 'deploy:Passed', 'inspect:ReviewRequired', 'cleanup:Absent']);
    // The original deploy receipt is what inspection and clean-up were given.
    expect(calls().filter(a => a[1] === 'cleanup')[0]).toEqual(expect.arrayContaining(['--confirm-run', runId, '--ack-external-state']));
    // A new run is allowed once the previous one is closed.
    expect((await call('POST', `/api/plans/${p.id}/runs`, { acknowledgePrerequisites: true })).statusCode).toBe(201);
    const audit = (await call('GET', '/api/audit?limit=100')).json().items.map((a: { action: string }) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['pilot.plan', 'pilot.run.start', 'pilot.deploy.request', 'pilot.deploy.passed', 'pilot.cleanup.request', 'pilot.cleanup.absent']));
  });

  it('a failed deploy that created objects needs recovery; one that created nothing closes', async () => {
    const { tgt, pid, wid } = await ready(`example.net/web@${DIGEST}`);
    await call('PUT', `/api/clusters/${tgt}/pilot-context`, { contextName: 'lab-target-pilot' });
    const p = (await plan(pid, wid, {})).json();
    scenario({ deploy: 'FailedCreated' });
    const runId = (await call('POST', `/api/plans/${p.id}/runs`, { acknowledgePrerequisites: true })).json().runId;
    await settle(runId);
    await call('POST', `/api/runs/${runId}/deploy`, { confirmWorkload: 'app/Deployment/web' });
    const run = await settle(runId);
    expect(run.state).toBe('NeedsRecovery');
    expect(run.actions).toEqual(['inspect']);
    expect(run.detail).toContain('Rollout failed');

    scenario({ inspect: 'Absent' });
    await call('POST', `/api/runs/${runId}/inspect`, {});
    expect((await settle(runId)).state).toBe('Absent');

    scenario({ deploy: 'FailedNothing' });
    const second = (await call('POST', `/api/plans/${p.id}/runs`, { acknowledgePrerequisites: true })).json().runId;
    await settle(second);
    await call('POST', `/api/runs/${second}/deploy`, { confirmWorkload: 'app/Deployment/web' });
    expect((await settle(second)).state).toBe('NothingCreated');
  });

  it('refuses to deploy on a validation older than 25 minutes', async () => {
    const { tgt, pid, wid } = await ready(`example.net/web@${DIGEST}`);
    await call('PUT', `/api/clusters/${tgt}/pilot-context`, { contextName: 'lab-target-pilot' });
    const p = (await plan(pid, wid, {})).json();
    const runId = (await call('POST', `/api/plans/${p.id}/runs`, { acknowledgePrerequisites: true })).json().runId;
    await settle(runId);
    await db.updateTable('evidence').set({ observed_at: new Date(Date.now() - 26 * 60_000).toISOString() }).where('run_id', '=', runId).execute();
    const res = await call('POST', `/api/runs/${runId}/deploy`, { confirmWorkload: 'app/Deployment/web' });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('Validate again');
  });

  it('after a restart mid-deploy, the run needs inspection and uses the partial receipt', async () => {
    const { tgt, pid, wid } = await ready(`example.net/web@${DIGEST}`);
    await call('PUT', `/api/clusters/${tgt}/pilot-context`, { contextName: 'lab-target-pilot' });
    const p = (await plan(pid, wid, {})).json();
    const runId = (await call('POST', `/api/plans/${p.id}/runs`, { acknowledgePrerequisites: true })).json().runId;
    await settle(runId);
    // Simulate an engine that died while deploying: busy state, no job, partial receipt on disk.
    await db.updateTable('runs').set({ state: 'Deploying' }).where('id', '=', runId).execute();
    fs.writeFileSync(path.join(runDir(config, runId), 'deploy.json'), JSON.stringify({ kind: 'PilotExecutionResult', runId: 'partial-run', status: 'Started', created: [{ kind: 'Service', name: 'web', namespace: 'app', uid: 'u' }], uncertain: ['Deployment/web'] }));
    expect(await recoverRuns(db)).toBe(1);
    let run = (await call('GET', `/api/runs/${runId}`)).json();
    expect(run.state).toBe('NeedsReview');
    expect(run.actions).toEqual(['inspect']);
    await call('POST', `/api/runs/${runId}/inspect`, {});
    run = await settle(runId);
    expect(run.state).toBe('Inspected');
    const receiptArg = calls().filter(a => a[1] === 'inspect').at(-1)!;
    expect(receiptArg).toContain('--receipt');
  });

  it('discards a validated run that was never deployed', async () => {
    const { tgt, pid, wid } = await ready(`example.net/web@${DIGEST}`);
    await call('PUT', `/api/clusters/${tgt}/pilot-context`, { contextName: 'lab-target-pilot' });
    const p = (await plan(pid, wid, {})).json();
    const runId = (await call('POST', `/api/plans/${p.id}/runs`, { acknowledgePrerequisites: true })).json().runId;
    await settle(runId);
    expect((await call('POST', `/api/runs/${runId}/discard`, {})).json().state).toBe('Discarded');
    expect((await call('POST', `/api/runs/${runId}/deploy`, { confirmWorkload: 'app/Deployment/web' })).statusCode).toBe(409);
  });

  it('lists runs and exposes the containers for the plan form', async () => {
    const { tgt, pid, wid } = await ready();
    await call('PUT', `/api/clusters/${tgt}/pilot-context`, { contextName: 'lab-target-pilot' });
    const info = (await call('GET', `/api/projects/${pid}/workloads/${wid}/pilot`)).json();
    expect(info.containers).toEqual([{ name: 'web', image: 'example.net/web:1.0', init: false }]);
    expect(info.target.pilotContext).toBe('lab-target-pilot');
    expect((await call('GET', `/api/runs?projectId=${pid}`)).json().items).toEqual([]);
  });

  it('rejects unsafe plan inputs', async () => {
    const { tgt, pid, wid } = await ready();
    await call('PUT', `/api/clusters/${tgt}/pilot-context`, { contextName: 'lab-target-pilot' });
    for (const body of [{ images: { 'a': 'x y' } }, { images: { 'a': 'x;rm -rf /' } }, { serviceAccount: 'Bad Name' }, { settings: { smokePort: 0 } }, { settings: { rolloutSeconds: 5 } }, { settings: { smokePath: '//evil' } }, { extra: 1 }]) {
      expect((await plan(pid, wid, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });
});
