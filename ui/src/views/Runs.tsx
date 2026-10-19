import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Run, type RunAction, type RunListItem, type RunStep } from '../api';
import { navigate } from '../router';

const BUSY = ['Validating', 'Deploying', 'Observing', 'Inspecting', 'Cleaning'];
const LABEL: Record<RunAction, string> = { validate: 'Validate again', deploy: 'Deploy pilot', observe: 'Observe', inspect: 'Inspect', cleanup: 'Clean up', discard: 'Discard' };
const STATE_HELP: Record<string, string> = {
  Validated: 'Validation passed. Deploy within 25 minutes, or validate again.',
  ValidationFailed: 'Validation failed; nothing was created. Fix the cause and start a new run.',
  PilotPassed: 'The pilot is running on the target and passed its smoke test. Observe it again, or inspect it before cleaning up.',
  NeedsRecovery: 'The pilot did not pass and objects may exist on the target. Inspect it.',
  NeedsReview: 'Something needs checking before anything else. Inspect the target.',
  Inspected: 'Inspection recorded. Clean up within 9 minutes, or inspect again.',
  CleanupPending: 'Deletion was requested and Kubernetes is still finishing it. Nothing is forced. Inspect again in a little while; the run closes when the objects are gone.',
  Cleaned: 'The pilot objects were deleted from the target.',
  Absent: 'No pilot objects exist on the target.',
  NothingCreated: 'The deploy failed before creating anything.',
  Discarded: 'Discarded before deployment.',
};

export function Runs({ runId }: { runId: string | null }) {
  return runId ? <RunView key={runId} id={runId} /> : <RunList />;
}

function RunList() {
  const [items, setItems] = useState<RunListItem[]>();
  const [error, setError] = useState<string>();
  useEffect(() => { api<{ items: RunListItem[] }>('/api/runs').then(r => setItems(r.items), e => setError(e.message)); }, []);
  return (
    <>
      <header><div><h1>Pilot runs</h1><p className="lede">Single-workload pilots on VKS target clusters. Plan one from a workload on a project page.</p></div></header>
      {error && <div className="alert error" role="alert">{error}</div>}
      {items?.length === 0 && <div className="card empty"><h3>No pilot runs yet</h3><p>Open a project, select a workload and plan a pilot.</p></div>}
      {items && items.length > 0 && (
        <table>
          <thead><tr><th>Started</th><th>Project</th><th>Workload</th><th>State</th></tr></thead>
          <tbody>{items.map(r => (
            <tr key={r.id} className="clickable" tabIndex={0} onClick={() => navigate(`/runs?run=${r.id}`)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/runs?run=${r.id}`); } }}>
              <td>{new Date(r.createdAt).toLocaleString()}</td><td>{r.projectName}</td><td className="mono">{r.workload}</td><td><span className={`badge run-${r.state}`}>{r.state}</span></td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </>
  );
}

function RunView({ id }: { id: string }) {
  const [run, setRun] = useState<Run>();
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState<'deploy' | 'cleanup' | 'discard' | null>(null);
  const polling = useRef(false);
  const load = useCallback(async () => {
    try { setRun(await api<Run>(`/api/runs/${id}`)); } catch (e) { setError(e instanceof Error ? e.message : 'Could not load the run.'); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  const busy = run ? BUSY.includes(run.state) : false;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(async () => { if (polling.current) return; polling.current = true; try { await load(); } finally { polling.current = false; } }, 2000);
    return () => clearInterval(t);
  }, [busy, load]);

  const act = async (action: RunAction, body: object = {}) => {
    setError(undefined);
    try { setRun(await api<Run>(`/api/runs/${id}/${action}`, { method: 'POST', body: JSON.stringify(body) })); setConfirm(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Request failed.'); }
  };

  // Confirmations show values (like the run ID on the target) that a step can change: reload first.
  const choose = async (action: RunAction) => {
    if (action !== 'deploy' && action !== 'cleanup' && action !== 'discard') return act(action);
    await load();
    setConfirm(action);
  };

  if (!run) return error ? <div className="alert error" role="alert">{error}</div> : <p aria-busy="true">Loading…</p>;
  return (
    <>
      <p className="crumb"><a href="/runs" onClick={e => { e.preventDefault(); navigate('/runs'); }}>Pilot runs</a> / <a href={`/estate?project=${run.projectId}`} onClick={e => { e.preventDefault(); navigate(`/estate?project=${run.projectId}`); }}>Project</a></p>
      <header>
        <div>
          <h1 className="mono-title">{run.workload}</h1>
          <p className="lede">Run <span className="mono">{run.runLabel}</span> · target context <span className="mono">{run.context}</span> · plan <span className="mono" title={run.revision}>{run.revision.slice(0, 12)}</span></p>
        </div>
        <span className={`badge large run-${run.state}`}>{run.state}</span>
      </header>
      {error && <div className="alert error" role="alert">{error}</div>}
      {busy && <div className="alert info" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" /> {run.job?.progress ?? 'Working…'}</div>}
      {!busy && (STATE_HELP[run.state] || run.detail) && (
        <div className={`alert ${['NeedsRecovery', 'NeedsReview', 'ValidationFailed'].includes(run.state) ? 'error' : 'info'}`} role="status">
          <div>{STATE_HELP[run.state]}{run.detail && <p className="hint">{run.detail}</p>}</div>
        </div>
      )}

      {!busy && run.actions.length > 0 && !confirm && (
        <div className="actions">
          {run.actions.map(a => (
            <button key={a} className={a === 'deploy' || a === 'cleanup' ? 'btn' : 'btn outline'} onClick={() => void choose(a)}>{LABEL[a]}</button>
          ))}
        </div>
      )}
      {confirm === 'deploy' && <ConfirmDeploy workload={run.workload} onCancel={() => setConfirm(null)} onConfirm={v => void act('deploy', { confirmWorkload: v })} />}
      {confirm === 'cleanup' && <ConfirmCleanup runLabel={run.runLabel} onCancel={() => setConfirm(null)} onConfirm={v => void act('cleanup', { confirmRun: v, acknowledgeExternalState: true })} />}
      {confirm === 'discard' && (
        <div className="card confirm"><p>Discard this run? Nothing has been deployed, so nothing changes on the target.</p>
          <div className="actions"><button className="btn" onClick={() => void act('discard')}>Discard run</button><button className="btn outline" onClick={() => setConfirm(null)}>Cancel</button></div></div>
      )}

      <h3>Steps</h3>
      {run.steps.length === 0 && <p className="hint">No steps recorded yet.</p>}
      <ol className="steps">{run.steps.map(s => <StepItem key={s.id} step={s} />)}</ol>
    </>
  );
}

function ConfirmDeploy({ workload, onConfirm, onCancel }: { workload: string; onConfirm: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState('');
  return (
    <form className="card confirm" onSubmit={e => { e.preventDefault(); onConfirm(value); }}>
      <h3>Deploy the pilot</h3>
      <p>This creates one replica of the workload and its Services on the target, runs the smoke test and leaves them running until you clean up. To confirm, type <span className="mono">{workload}</span>.</p>
      <label htmlFor="confirm-workload">Workload</label>
      <input id="confirm-workload" className="mono" autoComplete="off" value={value} onChange={e => setValue(e.target.value)} />
      <div className="actions"><button className="btn" type="submit" disabled={value !== workload}>Deploy</button><button className="btn outline" type="button" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

function ConfirmCleanup({ runLabel, onConfirm, onCancel }: { runLabel: string; onConfirm: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState('');
  const [ack, setAck] = useState(false);
  return (
    <form className="card confirm" onSubmit={e => { e.preventDefault(); onConfirm(value); }}>
      <h3>Clean up the pilot</h3>
      <p>Deletes exactly the objects this run created, only if they are unchanged since the last inspection. Anything the pilot wrote elsewhere (databases, queues, files) is not undone.</p>
      <label className="check"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /> The application owner has reviewed what the pilot may have written outside the cluster.</label>
      <label htmlFor="confirm-run">To confirm, type the run ID <span className="mono">{runLabel}</span></label>
      <input id="confirm-run" className="mono" autoComplete="off" value={value} onChange={e => setValue(e.target.value)} />
      <div className="actions"><button className="btn" type="submit" disabled={!ack || value !== runLabel}>Clean up</button><button className="btn outline" type="button" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

function StepItem({ step }: { step: RunStep }) {
  const s = step.summary as {
    error?: string; smoke?: { status: string; detail: string }; rollout?: { status: string; detail: string };
    created?: { kind: string; name: string; uid: string }[]; uncertain?: string[];
    rows?: { kind: string; name: string; state: string; detail: string }[]; actions?: { kind: string; name: string; outcome: string }[];
  };
  const ok = ['Passed', 'Absent', 'ReviewRequired'].includes(step.status);
  const wait = step.step === 'cleanup' && step.status === 'Pending';   // deletion requested, still finishing
  return (
    <li className={ok ? 'ok' : wait ? 'wait' : 'bad'}>
      <div><strong>{step.step}</strong> <span className={`badge ${ok ? 'state-Assessed' : wait ? 'step-wait' : 'state-Blocked'}`}>{wait ? 'Deleting' : step.status}</span> <span className="hint">{new Date(step.observedAt).toLocaleString()}</span></div>
      {s.error && <p className="text-danger">{s.error}</p>}
      {s.rollout && s.rollout.status !== 'NotRun' && <p className="hint">Rollout: {s.rollout.status} — {s.rollout.detail}</p>}
      {s.smoke && s.smoke.status !== 'NotRun' && <p className="hint">Smoke test: {s.smoke.status} — {s.smoke.detail}</p>}
      {s.created && s.created.length > 0 && <p className="hint">Created: {s.created.map(c => `${c.kind}/${c.name}`).join(', ')}</p>}
      {s.uncertain && s.uncertain.length > 0 && <p className="text-danger">Outcome uncertain for: {s.uncertain.join(', ')}</p>}
      {s.rows && <ul className="plain">{s.rows.map((r, i) => <li key={i}><span className="mono">{r.kind}/{r.name}</span> · {r.state} <span className="hint">{r.detail}</span></li>)}</ul>}
      {s.actions && s.actions.length > 0 && <p className="hint">Deletions: {s.actions.map(a => `${a.kind}/${a.name} ${a.outcome}`).join(', ')}</p>}
    </li>
  );
}
