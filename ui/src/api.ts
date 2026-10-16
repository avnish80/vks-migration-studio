const KEY = 'vks-migration-studio.token';

/** Reads ?token= from the sign-in link once, stores it, and removes it from the address bar. */
export function captureTokenFromUrl(): void {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('token');
  if (!token) return;
  setToken(token);
  url.searchParams.delete('token');
  window.history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
}

export function getToken(): string | null {
  try { return window.localStorage.getItem(KEY); } catch { return null; }
}
export function setToken(token: string): void {
  try { window.localStorage.setItem(KEY, token.trim()); } catch { /* storage unavailable: token lives for this page only */ memory = token.trim(); }
}
export function clearToken(): void {
  try { window.localStorage.removeItem(KEY); } catch { /* ignore */ }
  memory = null;
}
let memory: string | null = null;

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken() ?? memory;
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body) headers.set('content-type', 'application/json');
  let response: Response;
  try { response = await fetch(path, { ...init, headers }); }
  catch { throw new ApiError(0, 'Cannot reach the engine. Check that the container is running.'); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, typeof body.message === 'string' ? body.message : `Request failed (${response.status}).`);
  return body as T;
}

export interface Project { id: string; name: string; description: string; createdAt: string; updatedAt: string }
export interface AuditEntry { seq: number; at: string; actor: string; action: string; subject: string; detail: Record<string, unknown> }
export interface Version { version: string; coreModules: string[] }
