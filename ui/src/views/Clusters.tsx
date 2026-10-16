import { useEffect, useState } from 'react';
import { api, ApiError, type Cluster, type KubeContext, type Side } from '../api';

export function Clusters() {
  const [contexts, setContexts] = useState<KubeContext[] | null>(null);
  const [contextError, setContextError] = useState<{ code: string; message: string }>();
  const [clusters, setClusters] = useState<Cluster[] | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const load = async () => {
    api<{ items: Cluster[] }>('/api/clusters').then(r => setClusters(r.items), e => setError(e.message));
    try { setContexts((await api<{ items: KubeContext[] }>('/api/kube/contexts')).items); setContextError(undefined); }
    catch (e) { setContexts([]); setContextError({ code: e instanceof ApiError && e.status === 503 ? 'unavailable' : 'error', message: e instanceof Error ? e.message : 'Could not read the kubeconfig.' }); }
  };
  useEffect(() => { void load(); }, []);

  const register = async (contextName: string, role: Side) => {
    setBusy(contextName); setError(undefined);
    try { await api('/api/clusters', { method: 'POST', body: JSON.stringify({ contextName, role }) }); await load(); }
    catch (e) { setError(`${contextName}: ${e instanceof Error ? e.message : 'registration failed'}`); }
    finally { setBusy(undefined); }
  };
  const check = async (c: Cluster) => {
    setBusy(c.id);
    try { const updated = await api<Cluster>(`/api/clusters/${c.id}/check`, { method: 'POST' }); setClusters(list => list?.map(x => x.id === c.id ? updated : x) ?? null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Check failed'); }
    finally { setBusy(undefined); }
  };
  const remove = async (c: Cluster) => {
    if (!window.confirm(`Remove ${c.name} from the engine? The cluster itself is not changed.`)) return;
    try { await api(`/api/clusters/${c.id}`, { method: 'DELETE' }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not remove the cluster.'); }
  };

  return (
    <>
      <header><div><h1>Clusters</h1><p className="lede">Source and VKS target clusters, from the kubeconfig the engine reads. The engine records each cluster's identity and never stores credentials.</p></div></header>
      {error && <div className="alert error" role="alert">{error}</div>}

      <h3>Registered</h3>
      {clusters && clusters.length === 0 && <div className="card empty"><p>No clusters registered yet. Pick a context below.</p></div>}
      {clusters && clusters.length > 0 && (
        <table className="spaced">
          <thead><tr><th>Cluster</th><th>Role</th><th>Identity</th><th>Status</th><th>Pilot login</th><th /></tr></thead>
          <tbody>{clusters.map(c => (
            <tr key={c.id}>
              <td>{c.name}<div className="hint mono">{c.contextName}</div></td>
              <td><span className={`badge ${c.role}`}>{c.role}</span></td>
              <td className="mono" title="kube-system namespace UID">{c.clusterUid?.slice(0, 8)}…</td>
              <td>{c.lastError ? <span className="text-danger">{c.lastError}</span> : c.lastSeenAt ? `Reachable · checked ${new Date(c.lastSeenAt).toLocaleString()}` : 'Not checked'}</td>
              <td>{c.role === 'target' ? <PilotLogin cluster={c} contexts={(contexts ?? []).filter(x => !x.registered || x.name === c.pilotContextName).map(x => x.name)} onSaved={load} /> : <span className="hint">—</span>}</td>
              <td className="row-actions">
                <button className="btn outline small" disabled={busy === c.id} onClick={() => void check(c)}>{busy === c.id ? 'Checking…' : 'Check'}</button>
                <button className="link" onClick={() => void remove(c)}>Remove</button>
              </td>
            </tr>
          ))}</tbody>
        </table>
      )}

      <h3>Contexts in the kubeconfig</h3>
      {contextError && (
        <div className={`alert ${contextError.code === 'unavailable' ? 'info' : 'error'}`} role="status">
          <div>
            <strong>{contextError.message}</strong>
            <p className="hint">Run the engine where it can reach your clusters, with a kubeconfig mounted (see the README). In GitHub Codespaces there are no clusters to reach: use <em>Load demo inventory</em> or <em>Import inventory</em> on a project instead.</p>
          </div>
        </div>
      )}
      {contexts && contexts.length > 0 && (
        <table>
          <thead><tr><th>Context</th><th>API server</th><th /></tr></thead>
          <tbody>{contexts.map(c => (
            <tr key={c.name}>
              <td>{c.name}{c.current && <span className="hint"> · current</span>}</td>
              <td className="mono">{c.server}</td>
              <td className="row-actions">
                {c.registered ? <span className="hint">Registered</span> : (<>
                  <button className="btn outline small" disabled={!!busy} onClick={() => void register(c.name, 'source')}>Add as source</button>
                  <button className="btn outline small" disabled={!!busy} onClick={() => void register(c.name, 'target')}>Add as VKS target</button>
                </>)}
                {busy === c.name && <span className="hint">Checking identity…</span>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </>
  );
}

/** The write-capable context used for pilots on a target cluster; must reach the same cluster. */
function PilotLogin({ cluster, contexts, onSaved }: { cluster: Cluster; contexts: string[]; onSaved: () => void }) {
  const [value, setValue] = useState(cluster.pilotContextName ?? '');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError(undefined);
    try { await api(`/api/clusters/${cluster.id}/pilot-context`, { method: 'PUT', body: JSON.stringify({ contextName: value || null }) }); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not set the pilot login.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="pilot-login">
      <select aria-label={`Pilot login for ${cluster.name}`} value={value} onChange={e => setValue(e.target.value)}>
        <option value="">None</option>
        {contexts.map(n => <option key={n} value={n}>{n}</option>)}
      </select>
      {value !== (cluster.pilotContextName ?? '') && <button className="btn outline small" disabled={busy} onClick={() => void save()}>{busy ? 'Checking…' : 'Save'}</button>}
      {error && <div className="text-danger" role="alert">{error}</div>}
    </div>
  );
}
