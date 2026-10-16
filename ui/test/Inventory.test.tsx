import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/App';

type Reply = { status: number; body: unknown };
function mockApi(routes: Record<string, (init?: RequestInit) => Reply>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = `${init?.method ?? 'GET'} ${url}`;
    const handler = routes[key] ?? (url === '/api/version' ? () => ({ status: 200, body: { version: 't', coreModules: [] } }) : undefined);
    const { status, body } = handler ? handler(init) : { status: 404, body: { message: `no mock for ${key}` } };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}
const project = { id: 'p1', name: 'Payments', description: '', sourceClusterId: 'c1', targetClusterId: null, createdAt: '', updatedAt: '' };
const cluster = { id: 'c1', contextName: 'lab-source', name: 'lab-source', role: 'source', clusterUid: '11111111-aaaa', lastSeenAt: new Date().toISOString(), lastError: null, createdAt: '' };

beforeEach(() => { localStorage.setItem('vks-migration-studio.token', 'tok'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); window.history.replaceState(null, '', '/'); });

describe('clusters page', () => {
  it('registers a context and explains a missing kubeconfig', async () => {
    window.history.replaceState(null, '', '/clusters');
    let registered = false;
    const calls = mockApi({
      'GET /api/clusters': () => ({ status: 200, body: { items: registered ? [cluster] : [] } }),
      'GET /api/kube/contexts': () => ({ status: 200, body: { items: [{ name: 'lab-source', cluster: 'c', server: 'https://lab:6443', namespace: '', current: true, registered }] } }),
      'POST /api/clusters': () => { registered = true; return { status: 201, body: cluster }; },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add as source' }));
    expect(await screen.findByText(/Reachable/)).toBeTruthy();
    expect(JSON.parse(String(calls.find(c => c.init?.method === 'POST')!.init!.body))).toEqual({ contextName: 'lab-source', role: 'source' });
  });

  it('shows guidance when the engine has no kubeconfig', async () => {
    window.history.replaceState(null, '', '/clusters');
    mockApi({
      'GET /api/clusters': () => ({ status: 200, body: { items: [] } }),
      'GET /api/kube/contexts': () => ({ status: 503, body: { error: 'NoKubeconfig', message: 'No kubeconfig is available to the engine.' } }),
    });
    render(<App />);
    expect(await screen.findByText('No kubeconfig is available to the engine.')).toBeTruthy();
    expect(screen.getByText(/Load demo inventory/)).toBeTruthy();
  });
});

describe('project page', () => {
  const base = {
    'GET /api/projects/p1': () => ({ status: 200, body: project }),
    'GET /api/clusters': () => ({ status: 200, body: { items: [cluster] } }),
    'GET /api/projects/p1/snapshots': () => ({ status: 200, body: { items: [] } }),
  };

  it('starts a collection and shows its progress', async () => {
    window.history.replaceState(null, '', '/estate?project=p1');
    let jobs: unknown[] = [];
    const calls = mockApi({
      ...base,
      'GET /api/projects/p1/workloads': () => ({ status: 200, body: { snapshotId: null, findingsBySeverity: {}, estateFindings: 0, items: [] } }),
      'GET /api/projects/p1/jobs': () => ({ status: 200, body: { items: jobs } }),
      'POST /api/projects/p1/collect': () => { jobs = [{ id: 'j1', type: 'collect', state: 'Running', progress: 'Collecting inventory', result: null, error: null }]; return { status: 202, body: { jobId: 'j1' } }; },
    });
    render(<App />);
    const buttons = await screen.findAllByRole('button', { name: 'Collect inventory' });
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);   // no target cluster chosen
    fireEvent.click(buttons[0]!);
    expect(await screen.findByText('Collecting inventory')).toBeTruthy();
    expect(JSON.parse(String(calls.find(c => c.url === '/api/projects/p1/collect')!.init!.body))).toEqual({ side: 'source' });
  });

  it('lists workloads, filters them and opens findings', async () => {
    window.history.replaceState(null, '', '/estate?project=p1');
    mockApi({
      ...base,
      'GET /api/projects/p1/jobs': () => ({ status: 200, body: { items: [] } }),
      'GET /api/projects/p1/workloads': () => ({ status: 200, body: { snapshotId: 's', findingsBySeverity: {}, estateFindings: 2, items: [
        { id: 'w1', resource: 'app/Deployment/web', kind: 'Deployment', namespace: 'app', name: 'web', state: 'Blocked', blockers: 1, reviews: 0, updatedAt: '' },
        { id: 'w2', resource: 'app/Deployment/api', kind: 'Deployment', namespace: 'app', name: 'api', state: 'Assessed', blockers: 0, reviews: 1, updatedAt: '' }] } }),
      'GET /api/projects/p1/workloads/w1': () => ({ status: 200, body: { id: 'w1', resource: 'app/Deployment/web', kind: 'Deployment', namespace: 'app', name: 'web', state: 'Blocked', edges: [],
        findings: [{ id: 'F1', resource: 'app/Deployment/web', severity: 'Blocker', category: 'Storage', title: 'Node-local storage', evidence: 'hostPath /data', action: 'Move to a PVC', validation: '' }] } }),
    });
    render(<App />);
    expect(await screen.findByText('web')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter by state'), { target: { value: 'Assessed' } });
    await waitFor(() => expect(screen.queryByText('web')).toBeNull());
    fireEvent.change(screen.getByLabelText('Filter by state'), { target: { value: '' } });
    fireEvent.click(await screen.findByText('web'));
    expect(await screen.findByText('Node-local storage')).toBeTruthy();
    expect(screen.getByText(/Move to a PVC/)).toBeTruthy();
  });
});
