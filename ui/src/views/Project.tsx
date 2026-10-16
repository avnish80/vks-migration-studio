import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Cluster, type Diff, type Finding, type Job, type Project, type Side, type Snapshot, type Workload, type WorkloadDetail, type WorkloadList } from '../api';
import { navigate } from '../router';

const STATE_LABEL: Record<string, string> = { Assessed: 'Assessed', Blocked: 'Blocked', NotInLatestSnapshot: 'Not in latest inventory' };

export function ProjectView({ id }: { id: string }) {
  const [project, setProject] = useState<Project>();
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [workloads, setWorkloads] = useState<WorkloadList>();
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const applyJobsRef = useRef<(l: Job[]) => boolean>(l => { setJobs(l); return false; });

  const load = useCallback(async () => {
    try {
      const [p, c, w, s, j] = await Promise.all([
        api<Project>(`/api/projects/${id}`),
        api<{ items: Cluster[] }>('/api/clusters'),
        api<WorkloadList>(`/api/projects/${id}/workloads`),
        api<{ items: Snapshot[] }>(`/api/projects/${id}/snapshots`),
        api<{ items: Job[] }>(`/api/projects/${id}/jobs`),
      ]);
      setProject(p); setClusters(c.items); setWorkloads(w); setSnapshots(s.items); applyJobsRef.current(j.items);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load the project.'); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  // Job tracking: report every job that finishes while this page is open, then reload the data.
  const mounted = useRef(new Date().toISOString());
  const known = useRef(new Map<string, string>());
  const applyJobs = useCallback((list: Job[]) => {
    let finished = false;
    for (const j of list) {
      const before = known.current.get(j.id);
      known.current.set(j.id, j.state);
      const terminal = j.state === 'Succeeded' || j.state === 'Failed';
      if (!terminal || before === j.state || (before === undefined && j.updatedAt < mounted.current)) continue;
      finished = true;
      if (j.state === 'Failed') setError(j.error ?? 'The job failed.');
      else setNotice('Inventory collected and analysed.');
    }
    setJobs(list);
    return finished;
  }, []);
  applyJobsRef.current = applyJobs;
  const polling = useRef(false);
  const active = jobs.filter(j => j.state === 'Queued' || j.state === 'Running');
  useEffect(() => {
    if (!active.length) return;
    const t = setInterval(async () => {
      if (polling.current) return;   // never stack requests if the engine is slow
      polling.current = true;
      try {
        const j = (await api<{ items: Job[] }>(`/api/projects/${id}/jobs`).catch(() => null))?.items;
        if (j && applyJobs(j)) await load();
      } finally { polling.current = false; }
    }, 1500);
    return () => clearInterval(t);
  }, [active.length, id, load, applyJobs]);

  if (!project) return error ? <div className="alert error" role="alert">{error}</div> : <p aria-busy="true">Loading…</p>;

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    if (busy) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    try { await fn(); if (done) setNotice(done); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Request failed.'); }
    finally { setBusy(false); }
  };
  const setCluster = (side: Side, value: string) => act(() => api(`/api/projects/${id}/clusters`, { method: 'PATCH', body: JSON.stringify(side === 'source' ? { sourceClusterId: value || null } : { targetClusterId: value || null }) }));
  const collect = (side: Side) => act(() => api(`/api/projects/${id}/collect`, { method: 'POST', body: JSON.stringify({ side }) }));
  const demo = () => act(() => api(`/api/projects/${id}/demo`, { method: 'POST' }), 'Demo inventory loaded and analysed.');
  const importFile = (side: Side, file: File) => act(async () => {
    if (file.size > 75 * 1024 * 1024) throw new Error('That file is larger than 75 MB.');
    let inventory: unknown;
    try { inventory = JSON.parse(await file.text()); } catch { throw new Error('That file is not valid JSON.'); }
    await api(`/api/projects/${id}/snapshots`, { method: 'POST', body: JSON.stringify({ side, inventory }) });
  }, `${file.name} imported and analysed.`);

  const counts = workloads?.items.reduce((a, w) => ({ blocked: a.blocked + (w.state === 'Blocked' ? 1 : 0), review: a.review + (w.state !== 'Blocked' && w.reviews ? 1 : 0) }), { blocked: 0, review: 0 }) ?? { blocked: 0, review: 0 };

  return (
    <>
      <p className="crumb"><a href="/estate" onClick={e => { e.preventDefault(); navigate('/estate'); }}>Estate</a> /</p>
      <header><div><h1>{project.name}</h1>{project.description && <p className="lede">{project.description}</p>}</div></header>
      {error && <div className="alert error" role="alert">{error}</div>}
      {notice && <div className="alert info" role="status">{notice}</div>}

      <section className="grid2">
        {(['source', 'target'] as const).map(side => {
          const chosen = side === 'source' ? project.sourceClusterId : project.targetClusterId;
          const options = clusters.filter(c => c.role === side);
          const running = active.some(j => j.type === 'collect');
          return (
            <div className="card" key={side}>
              <h3>{side === 'source' ? 'Source cluster' : 'VKS target cluster'}</h3>
              <label htmlFor={`${side}-cluster`}>Cluster</label>
              <select id={`${side}-cluster`} value={chosen ?? ''} onChange={e => void setCluster(side, e.target.value)}>
                <option value="">Not selected</option>
                {options.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {!options.length && <p className="hint">No {side} clusters registered. <a href="/clusters" onClick={e => { e.preventDefault(); navigate('/clusters'); }}>Register one</a>.</p>}
              <div className="actions">
                <button className="btn" disabled={!chosen || running || busy} onClick={() => void collect(side)}>Collect inventory</button>
                <ImportButton disabled={busy} onFile={f => void importFile(side, f)} />
              </div>
            </div>
          );
        })}
      </section>

      {active.map(j => <div key={j.id} className="alert info" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" /> {j.progress ?? 'Waiting to start…'}</div>)}

      {workloads && workloads.items.length === 0 && !active.length && (
        <div className="card empty">
          <h3>No inventory yet</h3>
          <p>Collect from the source cluster, import an inventory file, or try the illustrative demo inventory.</p>
          <button className="btn outline" disabled={busy} onClick={() => void demo()}>Load demo inventory</button>
        </div>
      )}

      {workloads && workloads.items.length > 0 && (<>
        <div className="tiles">
          <div className="tile"><div className="k">Workloads</div><div className="v">{workloads.items.length}</div></div>
          <div className="tile"><div className="k">Blocked</div><div className="v text-danger">{counts.blocked}</div></div>
          <div className="tile"><div className="k">Need review</div><div className="v">{counts.review}</div></div>
          <div className="tile"><div className="k">Estate-wide findings</div><div className="v">{workloads.estateFindings}</div></div>
        </div>
        <Workloads items={workloads.items} onOpen={setSelected} />
        <EstateFindings key={workloads.snapshotId ?? 'none'} projectId={id} />
      </>)}

      {snapshots.length > 0 && <Snapshots key={snapshots[0]?.id} projectId={id} items={snapshots} />}
      {selected && <WorkloadPanel projectId={id} workloadId={selected} onClose={() => setSelected(undefined)} />}
    </>
  );
}

function ImportButton({ onFile, disabled }: { onFile: (f: File) => void; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (<>
    <button className="btn outline" type="button" disabled={disabled} onClick={() => input.current?.click()}>Import file</button>
    <input ref={input} type="file" accept=".json,application/json" hidden onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
  </>);
}

function Workloads({ items, onOpen }: { items: Workload[]; onOpen: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const shown = useMemo(() => items.filter(w => (!state || w.state === state) && (!q || w.resource.toLowerCase().includes(q.toLowerCase()))), [items, q, state]);
  const states = [...new Set(items.map(w => w.state))];
  return (
    <section>
      <div className="filters">
        <h3>Workloads</h3>
        <input aria-label="Search workloads" placeholder="Search namespace or name" value={q} onChange={e => setQ(e.target.value)} />
        <select aria-label="Filter by state" value={state} onChange={e => setState(e.target.value)}>
          <option value="">All states</option>
          {states.map(s => <option key={s} value={s}>{STATE_LABEL[s] ?? s}</option>)}
        </select>
      </div>
      <table>
        <thead><tr><th>Namespace</th><th>Workload</th><th>Kind</th><th>State</th><th>Blockers</th><th>Review</th></tr></thead>
        <tbody>{shown.map(w => (
          <tr key={w.id} className="clickable" tabIndex={0} aria-label={`Open ${w.namespace}/${w.name}`} onClick={() => onOpen(w.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(w.id); } }}>
            <td>{w.namespace}</td><td>{w.name}</td><td>{w.kind}</td>
            <td><span className={`badge state-${w.state}`}>{STATE_LABEL[w.state] ?? w.state}</span></td>
            <td>{w.blockers || ''}</td><td>{w.reviews || ''}</td>
          </tr>
        ))}</tbody>
      </table>
      {!shown.length && <p className="hint">No workloads match.</p>}
    </section>
  );
}

function FindingList({ items }: { items: Finding[] }) {
  if (!items.length) return <p className="hint">No findings.</p>;
  const order = ['Blocker', 'Review', 'Unknown', 'Info'];
  return (
    <ul className="findings">{[...items].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity)).map((f, i) => (
      <li key={f.id + i}>
        <div><span className={`badge sev-${f.severity}`}>{f.severity}</span> <strong>{f.title}</strong> <span className="hint">· {f.category} · <span className="mono">{f.resource}</span></span></div>
        <p>{f.evidence}</p>
        <p className="hint"><strong>Action:</strong> {f.action}</p>
      </li>
    ))}</ul>
  );
}

function WorkloadPanel({ projectId, workloadId, onClose }: { projectId: string; workloadId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<WorkloadDetail>();
  const [error, setError] = useState<string>();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let current = true;   // ignore responses for a workload that is no longer shown
    setDetail(undefined); setError(undefined);
    api<WorkloadDetail>(`/api/projects/${projectId}/workloads/${workloadId}`).then(d => { if (current) setDetail(d); }, e => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [projectId, workloadId]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('keydown', k); previous?.focus?.(); };
  }, [onClose]);
  return (
    <aside className="panel" role="dialog" aria-modal="true" aria-labelledby="panel-title">
      <div className="panel-head"><h3 id="panel-title">{detail ? `${detail.namespace} / ${detail.name}` : 'Workload'}</h3><button ref={close} className="link" onClick={onClose}>Close</button></div>
      {error && <div className="alert error" role="alert">{error}</div>}
      {!detail && !error && <p aria-busy="true">Loading…</p>}
      {detail && (<>
        <p className="hint">{detail.kind} · {STATE_LABEL[detail.state] ?? detail.state}</p>
        <h3>Findings</h3>
        <FindingList items={detail.findings} />
        {detail.edges.length > 0 && (<>
          <h3>Connected resources</h3>
          <ul className="plain">{detail.edges.map((e, i) => <li key={i} className="mono">{e.from === detail.resource ? `→ ${e.to}` : `← ${e.from}`} <span className="hint">({e.type})</span></li>)}</ul>
        </>)}
      </>)}
    </aside>
  );
}

function EstateFindings({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<Finding[]>();
  const [total, setTotal] = useState(0);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (open && !items && !failed) api<{ items: Finding[]; total: number }>(`/api/projects/${projectId}/findings`).then(r => { setItems(r.items); setTotal(r.total); }, () => setFailed(true)); }, [open, items, failed, projectId]);
  return (
    <details className="card" onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary><strong>Estate-wide findings</strong> <span className="hint">target compatibility, cluster-scoped resources and controllers</span></summary>
      {failed && <div className="alert error" role="alert">Could not load the findings.</div>}
      {items ? <>{total > items.length && <p className="hint">Showing the {items.length} most severe of {total}.</p>}<FindingList items={items} /></> : open && !failed && <p aria-busy="true">Loading…</p>}
    </details>
  );
}

function Snapshots({ projectId, items }: { projectId: string; items: Snapshot[] }) {
  const [diff, setDiff] = useState<Diff & { forId: string }>();
  const [error, setError] = useState<string>();
  const show = async (s: Snapshot) => {
    setError(undefined);
    try { setDiff({ ...(await api<Diff>(`/api/projects/${projectId}/snapshots/${s.id}/diff`)), forId: s.id }); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not compare snapshots.'); }
  };
  return (
    <section>
      <h3>Inventory snapshots</h3>
      <table>
        <thead><tr><th>Collected</th><th>Side</th><th>From</th><th>Resources</th><th>Coverage</th><th /></tr></thead>
        <tbody>{items.map(s => (
          <tr key={s.id}>
            <td title={`Stored ${new Date(s.storedAt).toLocaleString()}`}>{new Date(s.collectedAt).toLocaleString()}</td><td>{s.side}</td>
            <td>{s.origin === 'collected' ? s.context : s.origin === 'demo' ? 'Demo inventory' : 'Imported file'}</td>
            <td>{s.resources}</td>
            <td>{s.coverage.errors.length ? <span title={s.coverage.errors.map(e => `${e.resource}: ${e.reason}`).join('\n')}>{s.coverage.errors.length} kinds not readable</span> : s.origin === 'collected' ? 'All queried kinds read' : '—'}</td>
            <td><button className="link" onClick={() => void show(s)}>Changes</button></td>
          </tr>
        ))}</tbody>
      </table>
      {error && <div className="alert error" role="alert">{error}</div>}
      {diff && (
        <div className="card">
          <h3>Changes {diff.previousId ? 'since the previous snapshot' : '(first snapshot on this side)'}</h3>
          <p>{['added', 'changed', 'recreated', 'removed', 'unchanged'].map(k => `${diff.counts[k] ?? 0} ${k}`).join(' · ')}</p>
          {diff.previousId && diff.rows.length > 0 && <ul className="plain">{diff.rows.slice(0, 100).map(r => <li key={r.id}><span className={`badge change-${r.change}`}>{r.change}</span> <span className="mono">{r.id}</span></li>)}</ul>}
          {diff.rows.length > 100 && <p className="hint">Showing the first 100 changes.</p>}
        </div>
      )}
    </section>
  );
}
