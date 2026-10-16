import { useEffect, useRef, useState } from 'react';
import { api, type Project } from '../api';
import { addUnsavedGuard, navigate } from '../router';
import { ProjectView } from './Project';

export function Estate({ projectId }: { projectId: string | null }) {
  if (projectId) return <ProjectView key={projectId} id={projectId} />;
  return <ProjectList />;
}

function ProjectList() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const load = () => api<{ items: Project[] }>('/api/projects').then(r => setProjects(r.items), e => setError(e.message));
  useEffect(() => { void load(); }, []);

  return (
    <>
      <header>
        <div><h1>Estate</h1><p className="lede">Migration projects. Open one to see its clusters, inventory and workloads.</p></div>
        {!creating && <button className="btn" onClick={() => setCreating(true)}>New project</button>}
      </header>
      {error && <div className="alert error" role="alert">{error}</div>}
      {projects && (
        <div className="tiles" aria-label="Summary">
          <div className="tile"><div className="k">Projects</div><div className="v">{projects.length}</div></div>
        </div>
      )}
      {creating && <NewProject onDone={created => { setCreating(false); if (created) void load(); }} />}
      {projects && projects.length === 0 && !creating && (
        <div className="card empty">
          <h3>No migration projects yet</h3>
          <p>A project groups one source cluster, one VKS target and the workloads you move between them.</p>
          <button className="btn outline" onClick={() => setCreating(true)}>Create your first project</button>
        </div>
      )}
      {projects && projects.length > 0 && (
        <table>
          <thead><tr><th>Project</th><th>Description</th><th>Created</th></tr></thead>
          <tbody>{projects.map(p => (
            <tr key={p.id} className="clickable" onClick={() => navigate(`/estate?project=${encodeURIComponent(p.id)}`)}><td><a href={`/estate?project=${encodeURIComponent(p.id)}`} onClick={e => { e.preventDefault(); navigate(`/estate?project=${encodeURIComponent(p.id)}`); }}>{p.name}</a></td><td>{p.description || <span className="hint">—</span>}</td><td>{new Date(p.createdAt).toLocaleDateString()}</td></tr>
          ))}</tbody>
        </table>
      )}
    </>
  );
}

function NewProject({ onDone }: { onDone: (created: boolean) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const dirty = useRef(false);
  dirty.current = name.trim() !== '' || description.trim() !== '';
  useEffect(() => addUnsavedGuard(() => dirty.current), []);

  const submit = async () => {
    setBusy(true); setError(undefined);
    try {
      await api('/api/projects', { method: 'POST', body: JSON.stringify(description.trim() ? { name, description } : { name }) });
      dirty.current = false; onDone(true);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not create the project.'); }
    finally { setBusy(false); }
  };

  return (
    <form className="card" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <h3>New project</h3>
      {error && <div className="alert error" role="alert">{error}</div>}
      <label htmlFor="pname">Name</label>
      <input id="pname" value={name} maxLength={100} onChange={e => setName(e.target.value)} autoFocus />
      <label htmlFor="pdesc">Description <span className="hint">(optional)</span></label>
      <textarea id="pdesc" value={description} maxLength={2000} onChange={e => setDescription(e.target.value)} />
      <div className="actions">
        <button className="btn" type="submit" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create project'}</button>
        <button className="btn outline" type="button" onClick={() => { if (!dirty.current || window.confirm('Discard this project?')) { dirty.current = false; onDone(false); } }}>Cancel</button>
      </div>
    </form>
  );
}
