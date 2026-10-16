import { useEffect, useRef, useState } from 'react';
import { api, type PilotInfo, type Plan } from '../api';
import { addUnsavedGuard, navigate } from '../router';

const OPEN_STATES = ['Validating', 'Validated', 'Deploying', 'PilotPassed', 'NeedsRecovery', 'Observing', 'Inspecting', 'Inspected', 'Cleaning', 'CleanupPending', 'NeedsReview'];
const pinned = (image: string) => /@sha256:[a-f0-9]{64}$/.test(image);

/** Plan and start a single-workload pilot from the workload panel. */
export function PilotSection({ projectId, workloadId }: { projectId: string; workloadId: string }) {
  const [info, setInfo] = useState<PilotInfo>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState(false);
  const load = () => api<PilotInfo>(`/api/projects/${projectId}/workloads/${workloadId}/pilot`).then(setInfo, e => setError(e.message));
  useEffect(() => { void load(); }, [projectId, workloadId]);

  if (error) return <div className="alert error" role="alert">{error}</div>;
  if (!info) return <p aria-busy="true">Loading pilot…</p>;
  const open = info.runs.find(r => OPEN_STATES.includes(r.state));

  return (
    <section className="pilot">
      <h3>Pilot</h3>
      {!info.target && <p className="hint">Choose a VKS target cluster for this project to plan a pilot.</p>}
      {info.target && !info.target.pilotContext && (
        <p className="hint">The target cluster <strong>{info.target.name}</strong> has no pilot login yet. Create one with <span className="mono">scripts/pilot-kubeconfig.sh</span> and choose it on the <a href="/clusters" onClick={e => { e.preventDefault(); navigate('/clusters'); }}>Clusters</a> page.</p>
      )}
      {open && (
        <div className="alert info" role="status">
          <span>A pilot run is open ({open.state}).</span>{' '}
          <a href={`/runs?run=${open.id}`} onClick={e => { e.preventDefault(); navigate(`/runs?run=${open.id}`); }}>Open run</a>
        </div>
      )}
      {info.target?.pilotContext && !open && (editing || !info.plan
        ? <PlanForm info={info} projectId={projectId} workloadId={workloadId} onDone={async () => { setEditing(false); await load(); }} onCancel={info.plan ? () => setEditing(false) : undefined} />
        : <PlanSummary plan={info.plan!} onEdit={() => setEditing(true)} />)}
      {info.runs.length > 0 && (
        <>
          <h3>Runs</h3>
          <ul className="plain">{info.runs.map(r => (
            <li key={r.id}><a href={`/runs?run=${r.id}`} onClick={e => { e.preventDefault(); navigate(`/runs?run=${r.id}`); }}>{new Date(r.createdAt).toLocaleString()}</a> · <span className={`badge run-${r.state}`}>{r.state}</span></li>
          ))}</ul>
        </>
      )}
    </section>
  );
}

function PlanForm({ info, projectId, workloadId, onDone, onCancel }: { info: PilotInfo; projectId: string; workloadId: string; onDone: () => void; onCancel?: () => void }) {
  const prior = info.planInputs;
  const [images, setImages] = useState<Record<string, string>>(() => Object.fromEntries(info.containers.map(c => [c.image, prior?.images?.[c.image] ?? (pinned(c.image) ? c.image : '')])));
  const [serviceAccount, setServiceAccount] = useState(prior?.serviceAccount ?? '');
  const s = (prior?.settings ?? {}) as Record<string, string | number>;
  const [port, setPort] = useState(String(s.smokePort ?? 8080));
  const [smokePath, setSmokePath] = useState(String(s.smokePath ?? '/'));
  const [status, setStatus] = useState(String(s.expectedStatus ?? 200));
  const [marker, setMarker] = useState(String(s.smokeMarker ?? ''));
  const [rollout, setRollout] = useState(String(s.rolloutSeconds ?? 180));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const dirty = useRef(false);
  useEffect(() => addUnsavedGuard(() => dirty.current), []);
  const touch = <T,>(set: (v: T) => void) => (v: T) => { dirty.current = true; set(v); };

  const submit = async () => {
    setBusy(true); setError(undefined);
    try {
      const overrides = Object.fromEntries(Object.entries(images).filter(([src, dest]) => dest.trim() && dest.trim() !== src).map(([src, dest]) => [src, dest.trim()]));
      await api<Plan>(`/api/projects/${projectId}/workloads/${workloadId}/plans`, { method: 'POST', body: JSON.stringify({
        ...(serviceAccount.trim() ? { serviceAccount: serviceAccount.trim() } : {}),
        images: overrides,
        settings: { smokePort: Number(port), smokePath, expectedStatus: Number(status), smokeMarker: marker, rolloutSeconds: Number(rollout) },
      }) });
      dirty.current = false;
      onDone();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not create the plan.'); }
    finally { setBusy(false); }
  };

  return (
    <form className="card" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <h3>Plan a pilot</h3>
      <p className="hint">One replica of this workload, with its matching ClusterIP Services, deployed to the same namespace on {info.target?.name} using the pilot login. Images must be pinned by digest.</p>
      {error && <div className="alert error" role="alert">{error}</div>}
      {info.containers.map(c => (
        <div key={c.image + c.name}>
          <label htmlFor={`img-${c.name}`}>{c.init ? 'Init container' : 'Container'} {c.name}: image on the target</label>
          <input id={`img-${c.name}`} className="mono" placeholder="registry/repo@sha256:…" value={images[c.image] ?? ''} onChange={e => touch(setImages)({ ...images, [c.image]: e.target.value })} />
          <div className="hint">Source: <span className="mono">{c.image}</span>{pinned(c.image) ? ' (already pinned)' : ''}</div>
        </div>
      ))}
      <label htmlFor="sa">Service account on the target <span className="hint">(optional; default: same as source)</span></label>
      <input id="sa" value={serviceAccount} onChange={e => touch(setServiceAccount)(e.target.value)} />
      <fieldset className="row">
        <legend>Smoke test (an HTTP GET to the pilot Pod through a port-forward)</legend>
        <div><label htmlFor="port">Port</label><input id="port" inputMode="numeric" value={port} onChange={e => touch(setPort)(e.target.value)} /></div>
        <div><label htmlFor="path">Path</label><input id="path" value={smokePath} onChange={e => touch(setSmokePath)(e.target.value)} /></div>
        <div><label htmlFor="status">Expected status</label><input id="status" inputMode="numeric" value={status} onChange={e => touch(setStatus)(e.target.value)} /></div>
        <div><label htmlFor="marker">Text the page must contain</label><input id="marker" value={marker} onChange={e => touch(setMarker)(e.target.value)} /></div>
        <div><label htmlFor="rollout">Rollout wait (s)</label><input id="rollout" inputMode="numeric" value={rollout} onChange={e => touch(setRollout)(e.target.value)} /></div>
      </fieldset>
      <div className="actions">
        <button className="btn" type="submit" disabled={busy}>{busy ? 'Planning…' : 'Create plan'}</button>
        {onCancel && <button className="btn outline" type="button" onClick={() => { dirty.current = false; onCancel(); }}>Cancel</button>}
      </div>
    </form>
  );
}

function PlanSummary({ plan, onEdit }: { plan: Plan; onEdit: () => void }) {
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true); setError(undefined);
    try {
      const { runId } = await api<{ runId: string }>(`/api/plans/${plan.id}/runs`, { method: 'POST', body: JSON.stringify({ acknowledgePrerequisites: true }) });
      navigate(`/runs?run=${runId}`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not start the run.'); setBusy(false); }
  };
  return (
    <div className="card">
      <h3>Plan <span className="hint mono" title={plan.revision}>{plan.revision.slice(0, 12)}</span></h3>
      <p className="hint">Created {new Date(plan.createdAt).toLocaleString()} · <button className="link" onClick={onEdit}>Change plan</button></p>
      {error && <div className="alert error" role="alert">{error}</div>}
      {plan.blockers.length > 0 ? (<>
        <div className="alert error"><strong>{plan.blockers.length} blocker{plan.blockers.length > 1 ? 's' : ''}</strong>: this plan cannot run until they are resolved.</div>
        <ul className="findings">{plan.blockers.map((b, i) => <li key={i}><span className="badge sev-Blocker">Blocker</span> {b.reason} <span className="hint mono">{b.resource}</span></li>)}</ul>
      </>) : (<>
        <p>Before the pilot, the following must be in place on the target. The engine checks what it can; the rest is your confirmation.</p>
        <ul className="findings">{plan.prerequisites.map((p, i) => <li key={i}><span className="mono">{p.resource}</span><p className="hint">{p.action}</p></li>)}</ul>
        <label className="check"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /> These prerequisites are in place on the target.</label>
        <div className="actions"><button className="btn" disabled={!ack || busy} onClick={() => void start()}>{busy ? 'Starting…' : 'Start pilot: validate'}</button></div>
      </>)}
      <details><summary>Manifests</summary><pre className="code">{JSON.stringify(plan.manifests, null, 2)}</pre></details>
    </div>
  );
}
