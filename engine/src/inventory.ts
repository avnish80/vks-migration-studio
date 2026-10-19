import crypto from 'node:crypto';
import type { DB } from './db/index.js';
import type { Core } from './core.js';
import { getBlob, putBlob } from './blobs.js';
import { record } from './audit.js';
import { platformReason } from './platform.js';

export interface Finding { id: string; resource: string; severity: string; category: string; title: string; evidence: string; action: string; validation: string }
export interface Analysis { workloads: string[]; findings: Finding[]; edges: { from: string; to: string; type: string; confidence: string }[]; coverage: unknown }
interface Inventory { items: { kind: string; metadata: { name: string; namespace?: string; uid?: string } }[]; collection?: { complete?: boolean; queriedResources?: string[]; errors?: { resource?: string; reason?: string }[]; collectedAt?: string; limitations?: string[] }; sourceVersion?: string }

export class InventoryError extends Error {}

const core = (c: Core) => ({
  changes: c.modules.changes as { prepare: (raw: unknown) => unknown; compare: (a: unknown, b: unknown, side: string) => { counts: Record<string, number>; rows: { id: string; change: string }[] } },
  engine: c.modules.engine as { analyze: (raw: unknown, target: unknown) => Analysis },
});

/** kube-system namespace UID in an inventory, if it was collected. */
export function inventoryClusterUid(raw: Inventory): string | undefined {
  return raw.items.find(r => r.kind === 'Namespace' && r.metadata?.name === 'kube-system')?.metadata.uid;
}

function coverageOf(raw: Inventory) {
  const c = raw.collection ?? {};
  // Only categories and resource names are kept; collector reasons are already categories.
  return {
    complete: c.complete === true,
    queried: Array.isArray(c.queriedResources) ? c.queriedResources.length : 0,
    errors: Array.isArray(c.errors) ? c.errors.slice(0, 200).map(e => ({ resource: String(e.resource ?? '').slice(0, 200), reason: String(e.reason ?? '').slice(0, 40) })) : [],
    limitations: Array.isArray(c.limitations) ? c.limitations.slice(0, 20).map(l => String(l).slice(0, 300)) : [],
  };
}

export interface StoreInput { projectId: string; side: 'source' | 'target'; origin: 'collected' | 'imported' | 'demo'; clusterId: string | null; raw: unknown }

/** The inventory's own collection time, if plausible; otherwise now. Used for display only. */
function reportedTime(value: unknown, now: Date): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return now.toISOString();
  const t = Date.parse(value);
  if (Number.isNaN(t) || t > now.getTime() + 5 * 60_000 || t < Date.UTC(2014, 0, 1)) return now.toISOString();
  return new Date(t).toISOString();
}

/**
 * Validates, sanitises and stores an inventory snapshot. Only the sanitised form produced by the
 * planning core is kept: Secret and ConfigMap data, env values, last-applied annotations and GitOps
 * values are removed even when an imported file contains them. Source snapshots are analysed, and
 * the project's workloads refreshed: the newest stored snapshot is always the one that counts.
 */
export async function storeSnapshot(db: DB, c: Core, input: StoreInput): Promise<{ id: string; resources: number; workloads: number }> {
  let inv: Inventory;
  try { inv = core(c).changes.prepare(input.raw) as Inventory; } catch (e) { throw new InventoryError(`Not a valid inventory: ${e instanceof Error ? e.message : 'unreadable'}`); }
  if (!inv.items.length) throw new InventoryError('The inventory contains no resources.');
  const analysis = input.side === 'source' ? core(c).engine.analyze(inv, {}) : null;
  const now = new Date(), id = crypto.randomUUID();
  const blob = await putBlob(db, inv);
  const analysisHash = analysis ? await putBlob(db, analysis) : null;
  await db.transaction().execute(async trx => {
    await trx.insertInto('snapshots').values({ id, project_id: input.projectId, side: input.side, origin: input.origin, cluster_id: input.clusterId, blob_hash: blob, analysis_hash: analysisHash, resource_count: inv.items.length, collected_at: reportedTime(inv.collection?.collectedAt, now), stored_at: now.toISOString(), coverage: JSON.stringify(coverageOf(inv)) }).execute();
    if (analysis) await refreshWorkloads(trx as unknown as DB, input.projectId, id, analysis, now.toISOString(), inv);
    await record(trx as unknown as DB, 'inventory.store', `project/${input.projectId}`, { snapshot: id, side: input.side, origin: input.origin, resources: inv.items.length });
  });
  return { id, resources: inv.items.length, workloads: analysis?.workloads.length ?? 0 };
}
async function refreshWorkloads(db: DB, projectId: string, snapshotId: string, analysis: Analysis, now: string, inv: Inventory): Promise<void> {
  const meta = new Map<string, { labels?: Record<string, string>; annotations?: Record<string, string> }>();
  for (const r of inv.items as { kind?: string; metadata?: { name?: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> } }[]) {
    if (r.kind && r.metadata?.name) meta.set(`${r.metadata.namespace || 'cluster'}/${r.kind}/${r.metadata.name}`, r.metadata);   // the analysis's resource id format
  }
  const counts = new Map<string, { blockers: number; reviews: number }>();
  for (const f of analysis.findings) {
    const c = counts.get(f.resource) ?? { blockers: 0, reviews: 0 };
    if (f.severity === 'Blocker') c.blockers++; else if (f.severity === 'Review') c.reviews++;
    counts.set(f.resource, c);
  }
  const existing = new Map((await db.selectFrom('workloads').select(['id', 'resource_id', 'state']).where('project_id', '=', projectId).execute()).map(w => [w.resource_id, w]));
  for (const resource of analysis.workloads) {
    const [namespace = '', kind = '', ...rest] = resource.split('/');
    const c = counts.get(resource) ?? { blockers: 0, reviews: 0 };
    const assessed = c.blockers ? 'Blocked' : 'Assessed';
    const platform = platformReason(namespace, meta.get(resource));
    const prior = existing.get(resource);
    if (!prior) {
      await db.insertInto('workloads').values({ id: crypto.randomUUID(), project_id: projectId, resource_id: resource, kind, namespace, name: rest.join('/'), snapshot_id: snapshotId, blockers: c.blockers, reviews: c.reviews, state: assessed, wave_id: null, updated_at: now, platform, platform_override: null }).execute();
    } else {
      // Later lifecycle states (planned, piloting…) are owned by those steps, not by re-assessment.
      const state = ['Discovered', 'Assessed', 'Blocked', 'NotInLatestSnapshot'].includes(prior.state) ? assessed : prior.state;
      await db.updateTable('workloads').set({ snapshot_id: snapshotId, blockers: c.blockers, reviews: c.reviews, state, updated_at: now, platform }).where('id', '=', prior.id).execute();
    }
    existing.delete(resource);
  }
  for (const gone of existing.values()) {
    if (['Discovered', 'Assessed', 'Blocked'].includes(gone.state)) await db.updateTable('workloads').set({ state: 'NotInLatestSnapshot', updated_at: now }).where('id', '=', gone.id).execute();
  }
}

/** Compares a snapshot with the previous one on the same side of the same project. */
export async function diffSnapshot(db: DB, c: Core, projectId: string, snapshotId: string) {
  const current = await db.selectFrom('snapshots').selectAll().where('id', '=', snapshotId).where('project_id', '=', projectId).executeTakeFirst();
  if (!current) return undefined;
  const previous = await db.selectFrom('snapshots').selectAll().where('project_id', '=', projectId).where('side', '=', current.side)
    .where(eb => eb.or([eb('stored_at', '<', current.stored_at), eb.and([eb('stored_at', '=', current.stored_at), eb('id', '<', current.id)])]))
    .orderBy('stored_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  const after = await getBlob(db, current.blob_hash), before = previous ? await getBlob(db, previous.blob_hash) : null;
  const result = core(c).changes.compare(before, after, current.side);
  return { snapshotId, previousId: previous?.id ?? null, counts: result.counts, rows: result.rows.slice(0, 500).map(r => ({ id: r.id, change: r.change })), truncated: result.rows.length > 500 };
}

// Parsed analyses are large; keep the last few in memory instead of re-reading them on every request.
const cache = new Map<string, Analysis & { workloadSet: Set<string> }>();
export async function latestAnalysis(db: DB, projectId: string): Promise<{ snapshotId: string; analysis: Analysis & { workloadSet: Set<string> } } | undefined> {
  const s = await db.selectFrom('snapshots').select(['id', 'analysis_hash']).where('project_id', '=', projectId).where('side', '=', 'source').where('analysis_hash', 'is not', null).orderBy('stored_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  if (!s?.analysis_hash) return undefined;
  let analysis = cache.get(s.analysis_hash);
  if (!analysis) {
    const parsed = await getBlob<Analysis>(db, s.analysis_hash);
    analysis = { ...parsed, workloadSet: new Set(parsed.workloads) };
    cache.set(s.analysis_hash, analysis);
    while (cache.size > 4) cache.delete(cache.keys().next().value as string);
  }
  return { snapshotId: s.id, analysis };
}
