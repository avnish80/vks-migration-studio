import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from '../src/App';

type Reply = { status: number; body: unknown };
function mockApi(routes: Record<string, (init?: RequestInit) => Reply>) {
  const calls: { key: string; body?: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const h = routes[key] ?? (url === '/api/version' ? () => ({ status: 200, body: { version: 't', coreModules: [] } }) : undefined);
    const { status, body } = h ? h(init) : { status: 404, body: { message: `no mock for ${key}` } };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}
const DIGEST = 'example.net/web@sha256:' + 'a'.repeat(64);
const run = (state: string, actions: string[]) => ({ id: 'r1', runLabel: 'r1', projectId: 'p1', workloadId: 'w1', workload: 'app/Deployment/web', planId: 'pl', revision: 'f'.repeat(64), context: 'vks-pilot', state, detail: null, actions, closed: false, createdAt: '', updatedAt: '', job: null,
  steps: [{ id: 'e1', step: 'validate', status: 'Passed', observedAt: new Date().toISOString(), summary: { status: 'Passed' } }] });

beforeEach(() => localStorage.setItem('vks-migration-studio.token', 'tok'));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); window.history.replaceState(null, '', '/'); });

describe('run page', () => {
  it('deploys only after the workload name is typed', async () => {
    window.history.replaceState(null, '', '/runs?run=r1');
    const calls = mockApi({
      'GET /api/runs/r1': () => ({ status: 200, body: run('Validated', ['deploy', 'validate', 'discard']) }),
      'POST /api/runs/r1/deploy': () => ({ status: 202, body: run('PilotPassed', ['observe', 'inspect']) }),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deploy pilot' }));
    const go = await screen.findByRole('button', { name: 'Deploy' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Workload'), { target: { value: 'app/Deployment/web' } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    expect(await screen.findByText('PilotPassed')).toBeTruthy();
    expect(calls.find(c => c.key === 'POST /api/runs/r1/deploy')!.body).toEqual({ confirmWorkload: 'app/Deployment/web' });
  });

  it('cleans up only with the run ID and the external-state acknowledgement', async () => {
    window.history.replaceState(null, '', '/runs?run=r1');
    const calls = mockApi({
      'GET /api/runs/r1': () => ({ status: 200, body: run('Inspected', ['cleanup', 'inspect', 'observe']) }),
      'POST /api/runs/r1/cleanup': () => ({ status: 202, body: run('Cleaned', []) }),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Clean up' }));
    const go = () => screen.getAllByRole('button', { name: 'Clean up' }).at(-1) as HTMLButtonElement;
    fireEvent.change(await screen.findByLabelText(/type the run ID/), { target: { value: 'r1' } });
    expect(go().disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/application owner has reviewed/));
    expect(go().disabled).toBe(false);
    fireEvent.click(go());
    expect(await screen.findByText('Cleaned')).toBeTruthy();
    expect(calls.find(c => c.key === 'POST /api/runs/r1/cleanup')!.body).toEqual({ confirmRun: 'r1', acknowledgeExternalState: true });
  });
});

describe('run page, refreshed confirmation', () => {
  it('reloads the run before asking for the run ID, which an inspection can change', async () => {
    window.history.replaceState(null, '', '/runs?run=r1');
    let reads = 0;
    mockApi({ 'GET /api/runs/r1': () => ({ status: 200, body: { ...run('Inspected', ['cleanup', 'inspect', 'observe']), runLabel: reads++ ? 'label-on-target' : 'r1' } }) });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Clean up' }));
    expect(await screen.findByLabelText(/label-on-target/)).toBeTruthy();
  });
});

describe('pilot section', () => {
  it('plans with a digest-pinned image and starts the run after acknowledging prerequisites', async () => {
    window.history.replaceState(null, '', '/estate?project=p1');
    let plan: unknown = null;
    const calls = mockApi({
      'GET /api/projects/p1': () => ({ status: 200, body: { id: 'p1', name: 'P', description: '', sourceClusterId: null, targetClusterId: 't', createdAt: '', updatedAt: '' } }),
      'GET /api/clusters': () => ({ status: 200, body: { items: [] } }),
      'GET /api/projects/p1/snapshots': () => ({ status: 200, body: { items: [] } }),
      'GET /api/projects/p1/jobs': () => ({ status: 200, body: { items: [] } }),
      'GET /api/projects/p1/workloads': () => ({ status: 200, body: { snapshotId: 's', findingsBySeverity: {}, estateFindings: 0, items: [{ id: 'w1', resource: 'app/Deployment/web', kind: 'Deployment', namespace: 'app', name: 'web', state: 'Assessed', blockers: 0, reviews: 0, updatedAt: '' }] } }),
      'GET /api/projects/p1/workloads/w1': () => ({ status: 200, body: { id: 'w1', resource: 'app/Deployment/web', kind: 'Deployment', namespace: 'app', name: 'web', state: 'Assessed', findings: [], edges: [] } }),
      'GET /api/projects/p1/workloads/w1/pilot': () => ({ status: 200, body: { workload: 'app/Deployment/web', state: 'Assessed', containers: [{ name: 'web', image: 'example.net/web:1.0', init: false }], plan, planInputs: null, runs: [], target: { name: 'vks', pilotContext: 'vks-pilot' } } }),
      'POST /api/projects/p1/workloads/w1/plans': () => { plan = { id: 'pl', workloadId: 'w1', workload: 'app/Deployment/web', revision: 'f'.repeat(64), createdAt: new Date().toISOString(), blockers: [], prerequisites: [{ resource: 'Namespace/app', action: 'Prepare the namespace', status: 'Unverified' }], settings: {}, manifests: { items: [] } }; return { status: 201, body: plan }; },
      'POST /api/plans/pl/runs': () => ({ status: 201, body: { runId: 'r1' } }),
      'GET /api/runs/r1': () => ({ status: 200, body: run('Validating', []) }),
    });
    render(<App />);
    fireEvent.click(await screen.findByText('web'));
    fireEvent.change(await screen.findByLabelText(/Container web: image on the target/), { target: { value: DIGEST } });
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create plan' }));
    const start = await screen.findByRole('button', { name: 'Start pilot: validate' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/prerequisites are in place/));
    fireEvent.click(start);
    expect(await screen.findByText('Validating')).toBeTruthy();
    const body = calls.find(c => c.key === 'POST /api/projects/p1/workloads/w1/plans')!.body as { images: Record<string, string>; settings: { smokePort: number } };
    expect(body.images).toEqual({ 'example.net/web:1.0': DIGEST });
    expect(body.settings.smokePort).toBe(80);
    expect(window.location.search).toBe('?run=r1');
  });
});
