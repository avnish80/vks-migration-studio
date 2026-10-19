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

// Kept in memory too, so sign-in still works for this page when storage is blocked.
export function getToken(): string | null {
  try { return window.localStorage.getItem(KEY) ?? memory; } catch { return memory; }
}
export function setToken(token: string): void {
  memory = token.trim();
  try { window.localStorage.setItem(KEY, memory); } catch { /* storage unavailable: token lives for this page only */ }
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
  const token = getToken();
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

export interface Project { id: string; name: string; description: string; sourceClusterId: string | null; targetClusterId: string | null; createdAt: string; updatedAt: string }
export type Side = 'source' | 'target';
export interface KubeContext { name: string; cluster: string; server: string; namespace: string; current: boolean; registered: boolean }
export interface Cluster { id: string; contextName: string; name: string; role: Side; clusterUid: string | null; pilotContextName: string | null; lastSeenAt: string | null; lastError: string | null; createdAt: string }
export interface Prerequisite { resource: string; action: string; status: string }
export interface Plan { id: string; workloadId: string; workload: string; revision: string; createdAt: string; blockers: { resource: string; reason: string }[]; prerequisites: Prerequisite[]; settings: Record<string, unknown>; manifests: { items: unknown[] } }
export interface PilotInfo { workload: string; state: string; containers: { name: string; image: string; init: boolean }[]; plan: Plan | null; planInputs: { images?: Record<string, string>; serviceAccount?: string; settings?: Record<string, unknown> } | null; runs: { id: string; state: string; createdAt: string }[]; target: { name: string; pilotContext: string | null } | null }
export type RunAction = 'validate' | 'deploy' | 'observe' | 'inspect' | 'cleanup' | 'discard';
export interface RunStep { id: string; step: string; status: string; observedAt: string; summary: Record<string, unknown> }
export interface Run { id: string; runLabel: string; projectId: string; workloadId: string; workload: string; planId: string; revision: string; context: string; state: string; detail: string | null; actions: RunAction[]; closed: boolean; createdAt: string; updatedAt: string; steps: RunStep[]; job: { id: string; state: string; progress: string | null } | null }
export interface RunListItem { id: string; state: string; detail: string | null; workload: string; workloadId: string; projectId: string; projectName: string; createdAt: string; updatedAt: string }
export interface Job { id: string; type: string; projectId: string | null; state: 'Queued' | 'Running' | 'Succeeded' | 'Failed'; attempts: number; progress: string | null; result: unknown; error: string | null; createdAt: string; updatedAt: string }
export interface Workload { id: string; resource: string; kind: string; namespace: string; name: string; state: string; blockers: number; reviews: number; updatedAt: string; platform: string | null; platformDetected: string | null; platformOverride: 'app' | 'platform' | null }
export interface WorkloadList { snapshotId: string | null; findingsBySeverity: Record<string, number>; estateFindings: number; items: Workload[] }
export interface Finding { id: string; resource: string; severity: string; category: string; title: string; evidence: string; action: string; validation: string }
export interface WorkloadDetail extends Omit<Workload, 'blockers' | 'reviews' | 'updatedAt'> { findings: Finding[]; edges: { from: string; to: string; type: string }[] }
export interface Snapshot { id: string; side: Side; origin: 'collected' | 'imported' | 'demo'; resources: number; collectedAt: string; storedAt: string; context: string | null; coverage: { complete: boolean; queried: number; errors: { resource: string; reason: string }[] } }
export interface Diff { snapshotId: string; previousId: string | null; counts: Record<string, number>; rows: { id: string; change: string }[]; truncated: boolean }
export interface AuditEntry { seq: number; at: string; actor: string; action: string; subject: string; detail: Record<string, unknown> }
export interface Version { version: string; coreModules: string[] }
