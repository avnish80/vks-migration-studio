import { useEffect, useState } from 'react';
import { api, type AuditEntry } from '../api';

export function Audit() {
  const [items, setItems] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => { api<{ items: AuditEntry[] }>('/api/audit?limit=200').then(r => setItems(r.items), e => setError(e.message)); }, []);
  return (
    <>
      <header><div><h1>Audit log</h1><p className="lede">Every change the engine makes, newest first. Entries cannot be edited or deleted.</p></div></header>
      {error && <div className="alert error" role="alert">{error}</div>}
      {items && items.length === 0 && <div className="card empty"><h3>No activity yet</h3><p>Create a project to see the first entry.</p></div>}
      {items && items.length > 0 && (
        <table>
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Subject</th></tr></thead>
          <tbody>{items.map(a => (
            <tr key={a.seq}><td>{new Date(a.at).toLocaleString()}</td><td>{a.actor}</td><td className="mono">{a.action}</td><td className="mono">{a.subject}</td></tr>
          ))}</tbody>
        </table>
      )}
    </>
  );
}
