import { useEffect, useState } from 'react';
import { api, ApiError, captureTokenFromUrl, clearToken, getToken, setToken, type Version } from './api';
import { hasUnsaved, navigate, useRoute, type Route } from './router';
import { Estate } from './views/Estate';
import { Audit } from './views/Audit';
import { Placeholder } from './views/Placeholder';

type Session = { state: 'checking' } | { state: 'signin'; message?: string } | { state: 'ready'; version: string };

export function App() {
  const [session, setSession] = useState<Session>({ state: 'checking' });

  const check = async () => {
    if (!getToken()) return setSession({ state: 'signin' });
    try {
      const v = await api<Version>('/api/version');
      setSession({ state: 'ready', version: v.version });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { clearToken(); return setSession({ state: 'signin', message: 'That token was not accepted. Use the link or token from the engine start-up output.' }); }
      setSession({ state: 'signin', message: e instanceof Error ? e.message : 'Cannot reach the engine.' });
    }
  };

  useEffect(() => { captureTokenFromUrl(); void check(); }, []);

  if (session.state === 'checking') return <div className="signin" aria-busy="true">Connecting to the engine…</div>;
  if (session.state === 'signin') return <SignIn message={session.message} onSubmit={token => { setToken(token); void check(); }} />;
  return <Shell version={session.version} onSignOut={() => { clearToken(); setSession({ state: 'signin' }); }} />;
}

function SignIn({ message, onSubmit }: { message?: string; onSubmit: (token: string) => void }) {
  const [token, setValue] = useState('');
  return (
    <main className="signin">
      <div className="brand"><img src="/favicon.svg" alt="" width={28} height={28} /> VKS Migration Studio</div>
      <div className="card">
        <h3>Sign in to this engine</h3>
        <p className="lede">Open the sign-in link the engine printed when it started, or paste the token from the <span className="mono">token</span> file in its data folder.</p>
        {message && <div className="alert error" role="alert">{message}</div>}
        <form onSubmit={e => { e.preventDefault(); if (token.trim()) onSubmit(token); }}>
          <label htmlFor="token">Access token</label>
          <input id="token" type="password" autoComplete="off" value={token} onChange={e => setValue(e.target.value)} />
          <div className="actions"><button className="btn" type="submit" disabled={!token.trim()}>Sign in</button></div>
        </form>
      </div>
    </main>
  );
}

const NAV: { group: string; items: { to: Route; label: string; soon?: string }[] }[] = [
  { group: 'Migrate', items: [{ to: '/estate', label: 'Estate' }, { to: '/runs', label: 'Pilot runs', soon: '1.2' }] },
  { group: 'Platform', items: [{ to: '/clusters', label: 'Clusters', soon: '1.1' }, { to: '/audit', label: 'Audit log' }] },
];

function Shell({ version, onSignOut }: { version: string; onSignOut: () => void }) {
  const route = useRoute();
  return (
    <div className="app">
      <header className="header">
        <div className="brand"><img src="/favicon.svg" alt="" /> VKS Migration Studio <small>{version}</small></div>
        <div className="spacer" />
        <span className="meta">Local engine · 127.0.0.1</span>
        <button className="link" onClick={() => { if (!hasUnsaved() || window.confirm('You have unsaved changes on this page. Sign out without saving?')) onSignOut(); }}>Sign out</button>
      </header>
      <div className="strip" role="note"><strong>Pre-release.</strong> Pilot and planning only. The production gate is closed and no production traffic is moved.</div>
      <div className="body">
        <nav className="nav" aria-label="Main">
          {NAV.map(g => (
            <div key={g.group}>
              <h2>{g.group}</h2>
              {g.items.map(i => (
                <a key={i.to} href={i.to} aria-current={route === i.to ? 'page' : undefined} onClick={e => { e.preventDefault(); navigate(i.to); }}>
                  {i.label}{i.soon && <span className="soon">{i.soon}</span>}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <main className="content">
          {route === '/estate' && <Estate />}
          {route === '/audit' && <Audit />}
          {route === '/clusters' && <Placeholder title="Clusters" lede="Register source and VKS target contexts from your kubeconfig." milestone="1.1" body="The engine will read contexts from the kubeconfig you mount, record each cluster's identity, and show when a VKS token needs a fresh kubectl vsphere login. No credentials are stored." />}
          {route === '/runs' && <Placeholder title="Pilot runs" lede="Validate, deploy, observe, inspect and clean up a single-workload pilot." milestone="1.2" body="Runs will execute as engine jobs with evidence recorded directly — no receipt files to import. One unresolved run per workload is enforced." />}
        </main>
      </div>
    </div>
  );
}
