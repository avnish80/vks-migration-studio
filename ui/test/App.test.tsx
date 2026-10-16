import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/App';

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown };
function mockFetch(handler: Handler) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}
const ok = (url: string, projects: unknown[] = []) =>
  url === '/api/version' ? { status: 200, body: { version: '1.0.0-alpha.1', coreModules: [] } } :
  url === '/api/projects' ? { status: 200, body: { items: projects } } : { status: 404, body: {} };

beforeEach(() => { localStorage.clear(); window.history.replaceState(null, '', '/'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('sign-in', () => {
  it('takes the token from the link, stores it and removes it from the address bar', async () => {
    window.history.replaceState(null, '', '/?token=abc123&x=1');
    const calls = mockFetch(url => ok(url));
    render(<App />);
    await screen.findByRole('heading', { name: 'Estate' });
    expect(window.location.search).toBe('?x=1');
    expect(localStorage.getItem('vks-migration-studio.token')).toBe('abc123');
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer abc123');
  });

  it('asks for a token when none is stored, and explains a rejected one', async () => {
    mockFetch(() => ({ status: 401, body: { message: 'nope' } }));
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Access token'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toContain('not accepted');
    expect(localStorage.getItem('vks-migration-studio.token')).toBeNull();
  });
});

describe('estate', () => {
  beforeEach(() => localStorage.setItem('vks-migration-studio.token', 'tok'));

  it('shows an empty state, then creates a project', async () => {
    let projects: unknown[] = [];
    const calls = mockFetch((url, init) => {
      if (url === '/api/projects' && init?.method === 'POST') { projects = [{ id: '1', name: 'Payments', description: '', createdAt: new Date().toISOString(), updatedAt: '' }]; return { status: 201, body: projects[0] }; }
      return ok(url, projects);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create your first project' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Payments' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByRole('cell', { name: 'Payments' })).toBeTruthy();
    const post = calls.find(c => c.init?.method === 'POST')!;
    expect(JSON.parse(String(post.init!.body))).toEqual({ name: 'Payments' });
  });

  it('shows the engine error message when creation fails', async () => {
    mockFetch((url, init) => url === '/api/projects' && init?.method === 'POST' ? { status: 400, body: { message: 'body/name must NOT have more than 100 characters' } } : ok(url));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect((await screen.findByRole('alert')).textContent).toContain('100 characters');
  });

  it('asks before leaving a half-filled form', async () => {
    mockFetch(url => ok(url));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'draft' } });
    fireEvent.click(screen.getByRole('link', { name: 'Audit log' }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Estate' })).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('draft'));
  });
});
